import { createApp, type KeyEvent } from '@profullstack/hqtui';
import { ApiError, BoardClient, rememberBoard } from '@tsbb/client';
import { flattenForums, clampSelection, initialState, rowCount, type State } from './state.ts';
import { renderApp, scrollFor } from './views.ts';

export interface RunOptions {
  server: string;
  token: string | null;
  client?: BoardClient;
}

/**
 * The terminal client.
 *
 * State lives in one object, views are pure functions of it, and every key
 * handler is "change the state, ask for a repaint". Nothing renders from inside
 * a network callback, so a slow board makes the client slow to *update* rather
 * than slow to respond.
 */
export async function run(options: RunOptions): Promise<void> {
  const client = options.client ?? new BoardClient({ server: options.server, token: options.token });
  const state = initialState(client.server);

  const app = await createApp({ quitKeys: [] });
  let viewport = 20;

  const paint = () => app.invalidate?.();

  app.render(({ ui, width, height }) => {
    viewport = Math.max(3, height - 8);
    state.scroll = scrollFor(state, viewport);
    renderApp(ui, state, width, height);
  });

  const fail = (error: unknown) => {
    state.loading = false;
    state.error =
      error instanceof ApiError ? error.message : `Something went wrong: ${(error as Error).message}`;
    paint();
  };

  const busy = async (message: string, work: () => Promise<void>) => {
    state.loading = true;
    state.error = null;
    state.status = message;
    paint();
    try {
      await work();
      state.loading = false;
    } catch (error) {
      fail(error);
    }
    paint();
  };

  // --- Loaders -----------------------------------------------------------

  const loadBoard = () =>
    busy('Loading board…', async () => {
      const [board, me] = await Promise.all([client.board(), client.me().catch(() => null)]);
      state.boardName = board.board.name;
      state.forums = flattenForums(board.forums);
      state.me = me;
      state.status = me?.authenticated
        ? `Signed in as ${me.user?.username}`
        : 'Reading as a guest — press L to sign in';
    });

  const openForum = (slug: string, name: string) =>
    busy(`Opening ${name}…`, async () => {
      const result = await client.topics(slug);
      state.topics = result.topics;
      state.forumName = result.forum.name ?? name;
      state.forumSlug = slug;
      state.history.push(state.screen);
      state.screen = 'topics';
      state.selected = 0;
      state.scroll = 0;
      state.status = `${result.topics.length} topics`;
    });

  const openTopic = (id: number, title: string) =>
    busy(`Opening ${title}…`, async () => {
      const result = await client.topic(id);
      state.posts = result.posts;
      state.topic = result.topic;
      state.topicTitle = result.topic.title;
      state.canReply = result.canReply;
      state.history.push(state.screen);
      state.screen = 'topic';
      state.selected = 0;
      state.scroll = 0;
      state.status = `${result.posts.length} posts`;
    });

  const openNotifications = () =>
    busy('Loading notifications…', async () => {
      const result = await client.notifications();
      state.notifications = result.notifications;
      state.history.push(state.screen);
      state.screen = 'notifications';
      state.selected = 0;
      state.scroll = 0;
      state.status = `${result.unread} unread`;
    });

  const runSearch = () =>
    busy(`Searching for ${state.query}…`, async () => {
      const result = await client.search(state.query);
      state.hits = result.hits;
      state.selected = 0;
      state.scroll = 0;
      state.status = `${result.hits.length} results`;
    });

  /**
   * Device authorisation. The terminal cannot hold a browser session, so it
   * shows a code, the human approves it in a browser, and this polls until the
   * board hands over a token — which it does exactly once.
   */
  const signIn = async () => {
    state.history.push(state.screen);
    state.screen = 'login';
    state.error = null;
    paint();
    try {
      const grant = await client.startDeviceAuth('tsbb-tui');
      state.login = { userCode: grant.userCode, verifyUrl: grant.verifyUrl, expiresAt: grant.expiresAt };
      state.status = 'Waiting for approval…';
      paint();

      const interval = Math.max(1, grant.interval) * 1000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        if (state.screen !== 'login') return; // cancelled
        const poll = await client.pollDeviceAuth(grant.deviceCode);
        if (poll.status === 'approved' && poll.token) {
          client.setToken(poll.token);
          rememberBoard({ server: client.server, token: poll.token });
          state.login = null;
          state.screen = state.history.pop() ?? 'forums';
          await loadBoard();
          state.status = 'Signed in.';
          paint();
          return;
        }
        if (poll.status === 'expired') {
          state.login = null;
          state.screen = state.history.pop() ?? 'forums';
          state.error = 'That code expired. Press L to try again.';
          paint();
          return;
        }
      }
    } catch (error) {
      state.login = null;
      state.screen = state.history.pop() ?? 'forums';
      fail(error);
    }
  };

  const send = () =>
    busy('Sending…', async () => {
      const compose = state.compose;
      if (!compose) return;
      if (compose.kind === 'reply' && compose.topicId) {
        await client.reply(compose.topicId, compose.body);
        state.compose = null;
        state.screen = 'topic';
        const refreshed = await client.topic(compose.topicId);
        state.posts = refreshed.posts;
        state.selected = Math.max(0, refreshed.posts.length - 1);
        state.status = 'Posted.';
        return;
      }
      if (compose.kind === 'topic' && compose.forumSlug) {
        const created = await client.newTopic(compose.forumSlug, compose.title, compose.body);
        state.compose = null;
        await openTopic(created.id, compose.title);
        state.status = 'Topic created.';
      }
    });

  const back = () => {
    state.error = null;
    if (state.screen === 'compose') {
      state.compose = null;
      state.screen = state.history.pop() ?? 'forums';
    } else if (state.screen === 'login') {
      state.login = null;
      state.screen = state.history.pop() ?? 'forums';
    } else {
      state.screen = state.history.pop() ?? 'forums';
    }
    state.selected = 0;
    state.scroll = 0;
    paint();
  };

  // --- Keys ---------------------------------------------------------------

  app.on('key', (event: KeyEvent) => {
    void handleKey(event);
  });

  async function handleKey(event: KeyEvent): Promise<void> {
    const key = event.key ?? '';

    // Composing and searching capture ordinary characters, so the navigation
    // keys below must not run while text is being typed.
    if (state.screen === 'compose' && state.compose) {
      const compose = state.compose;
      if (event.ctrl && key === 's') return void send();
      if (key === 'escape') return back();
      if (key === 'tab' && compose.kind === 'topic') {
        compose.field = compose.field === 'title' ? 'body' : 'title';
        return paint();
      }
      if (key === 'backspace') {
        if (compose.field === 'title') compose.title = compose.title.slice(0, -1);
        else compose.body = compose.body.slice(0, -1);
        return paint();
      }
      if (key === 'enter') {
        if (compose.field === 'title') compose.field = 'body';
        else compose.body += '\n';
        return paint();
      }
      if (key.length === 1 && !event.ctrl && !event.alt) {
        if (compose.field === 'title') compose.title += key;
        else compose.body += key;
        return paint();
      }
      return;
    }

    if (state.screen === 'search') {
      if (key === 'escape') return back();
      if (key === 'enter') return void runSearch();
      if (key === 'backspace') {
        state.query = state.query.slice(0, -1);
        return paint();
      }
      if (key.length === 1 && !event.ctrl && !event.alt && state.hits.length === 0) {
        state.query += key;
        return paint();
      }
      // Once there are results, the arrow keys navigate them instead of typing.
      if (key === 'j' || key === 'down') return move(1);
      if (key === 'k' || key === 'up') return move(-1);
      if (key === 'enter' || key === 'l') return openSelected();
      return;
    }

    switch (key) {
      case 'q':
        return void app.stop();
      case 'c':
        if (event.ctrl) return void app.stop();
        return;
      case 'j':
      case 'down':
        return move(1);
      case 'k':
      case 'up':
        return move(-1);
      case 'pagedown':
        return move(viewport);
      case 'pageup':
        return move(-viewport);
      case 'home':
        state.selected = 0;
        return paint();
      case 'end':
        state.selected = Math.max(0, rowCount(state) - 1);
        return paint();
      case 'enter':
      case 'l':
      case 'right':
        return openSelected();
      case 'backspace':
      case 'escape':
      case 'h':
      case 'left':
        return back();
      case 'g':
        return void openNotifications();
      case 'a':
        if (state.screen === 'notifications') {
          await client.markNotificationsRead().catch(() => {});
          return void openNotifications();
        }
        return;
      case '/':
        state.history.push(state.screen);
        state.screen = 'search';
        state.query = '';
        state.hits = [];
        return paint();
      case '?':
        state.history.push(state.screen);
        state.screen = 'help';
        return paint();
      case 'L':
        return void signIn();
      case 'R':
        return void loadBoard();
      case 'n':
        if (state.screen === 'topics' && state.forumSlug) {
          state.history.push(state.screen);
          state.screen = 'compose';
          state.compose = { kind: 'topic', forumSlug: state.forumSlug, title: '', body: '', field: 'title' };
          return paint();
        }
        return;
      case 'r':
        if (state.screen === 'topic' && state.topic) {
          if (!state.canReply) {
            state.error = state.me?.authenticated
              ? 'You cannot reply to this topic.'
              : 'Sign in first — press L.';
            return paint();
          }
          state.history.push(state.screen);
          state.screen = 'compose';
          state.compose = { kind: 'reply', topicId: state.topic.id, title: '', body: '', field: 'body' };
          return paint();
        }
        return;
      default:
        return;
    }
  }

  function move(delta: number): void {
    state.selected += delta;
    clampSelection(state);
    paint();
  }

  function openSelected(): void {
    if (state.screen === 'forums') {
      const openable = state.forums.filter((f) => f.node.kind !== 'category');
      const target = openable[state.selected];
      if (target) void openForum(target.node.slug, target.node.name);
      return;
    }
    if (state.screen === 'topics') {
      const topic = state.topics[state.selected];
      if (topic) void openTopic(topic.id, topic.title);
      return;
    }
    if (state.screen === 'search') {
      const hit = state.hits[state.selected];
      if (hit) void openTopic(hit.topicId, hit.title);
      return;
    }
    if (state.screen === 'notifications') {
      const row = state.notifications[state.selected];
      const id = row?.url?.match(/-(\d+)(?:\/|$)/)?.[1];
      if (id) void openTopic(Number(id), row?.title ?? 'Topic');
    }
  }

  await loadBoard();
  await app.start();
}

export { renderApp } from './views.ts';
export type { State } from './state.ts';
