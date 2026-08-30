import type { Container } from '@profullstack/hqtui';
import { count, pad, relative, truncate, wrapText } from './format.ts';
import { rowCount, type State } from './state.ts';

/**
 * Every screen, as a pure function of state.
 *
 * Nothing here touches the network or the terminal, so hqtui's renderToText can
 * run the real view against a fixed state and assert on the characters that
 * come out — the layout itself is tested, not a description of it.
 */
export function renderApp(ui: Container, state: State, width: number, height: number): void {
  header(ui, state, width);

  switch (state.screen) {
    case 'login':
      loginScreen(ui, state, width);
      break;
    case 'help':
      helpScreen(ui);
      break;
    case 'compose':
      composeScreen(ui, state, width, height);
      break;
    case 'topics':
      topicsScreen(ui, state, width, height);
      break;
    case 'topic':
      topicScreen(ui, state, width, height);
      break;
    case 'notifications':
      notificationsScreen(ui, state, width, height);
      break;
    case 'search':
      searchScreen(ui, state, width, height);
      break;
    default:
      forumsScreen(ui, state, width, height);
  }

  footer(ui, state, width);
}

function header(ui: Container, state: State, width: number): void {
  const who = state.me?.authenticated
    ? `${state.me.user?.username ?? 'signed in'}${state.me.unread ? ` (${state.me.unread})` : ''}`
    : 'not signed in';
  // A row's children take equal shares by default, which would cut both halves
  // in half. The right-hand cell is sized to its own text so the left gets
  // everything that is left over.
  const right = Math.min(who.length + 1, Math.max(0, width - 12));
  ui.box({ height: 1 }, (box) => {
    box.row({ gap: 1 }, (row) => {
      row.heading(truncate(state.boardName, Math.max(6, width - right - 2)), { size: 'fill' });
      row.text(who, { align: 'right', size: right });
    });
  });
  ui.divider();
}

function footer(ui: Container, state: State, width: number): void {
  ui.divider();
  const keys =
    state.screen === 'compose'
      ? 'ctrl+s send · tab field · esc cancel'
      : state.screen === 'topic'
        ? 'r reply · j/k move · backspace back · ? help · q quit'
        : state.screen === 'login'
          ? 'esc cancel'
          : 'enter open · j/k move · n new · / search · g inbox · ? help · q quit';

  /*
   * The key hints are what a new reader needs and the status line is what they
   * already know, so the hints get the width they ask for and the status takes
   * what is left. On a narrow terminal the hints are shortened deliberately
   * rather than being cut off mid-word by the layout.
   */
  const shortKeys = state.screen === 'compose' ? 'ctrl+s send · esc cancel' : 'j/k · enter · ? help · q quit';
  const hints = keys.length + 14 <= width ? keys : shortKeys;
  const right = Math.min(hints.length + 1, Math.max(0, width - 8));
  const message = state.error ? `! ${state.error}` : state.status;

  ui.box({ height: 1 }, (box) => {
    box.row({ gap: 1 }, (row) => {
      row.text(truncate(message, Math.max(4, width - right - 2)), { size: 'fill' });
      row.label(hints, { align: 'right', size: right });
    });
  });
}

function emptyPanel(ui: Container, title: string, message: string, height: number): void {
  ui.panel({ title, size: Math.max(3, height) }, (panel) => {
    panel.spacer(1);
    panel.label(`  ${message}`);
  });
}

function forumsScreen(ui: Container, state: State, width: number, height: number): void {
  const body = Math.max(3, height - 6);
  if (!state.forums.length) {
    emptyPanel(ui, 'Forums', state.loading ? 'Loading…' : 'This board has no forums yet.', body);
    return;
  }

  // Categories are headings, not rows: they cannot be opened, so selecting one
  // would be a dead keypress.
  const items: { label: string; selectable: boolean }[] = [];
  for (const entry of state.forums) {
    if (entry.node.kind === 'category') {
      items.push({ label: entry.node.name.toUpperCase(), selectable: false });
      continue;
    }
    const stats = `${pad(count(entry.node.topics), 6)}${pad(count(entry.node.posts), 7)}`;
    const name = truncate(entry.node.name, Math.max(10, width - stats.length - 8));
    items.push({ label: `  ${pad(name, Math.max(10, width - stats.length - 8))}${stats}`, selectable: true });
  }

  let selectableIndex = -1;
  const rendered = items.map((item) => {
    if (item.selectable) selectableIndex += 1;
    const isSelected = item.selectable && selectableIndex === state.selected;
    return { label: `${isSelected ? '>' : ' '}${item.label}`, ...(item.selectable ? {} : { color: undefined }) };
  });

  ui.panel({ title: 'Forums', size: body }, (panel) => {
    panel.list({ items: rendered, selected: -1, offset: state.scroll, scrollbar: true });
  });
}

function topicsScreen(ui: Container, state: State, width: number, height: number): void {
  const body = Math.max(3, height - 6);
  if (!state.topics.length) {
    emptyPanel(ui, state.forumName || 'Topics', state.loading ? 'Loading…' : 'No topics here yet.', body);
    return;
  }

  const metaWidth = 16;
  const items = state.topics.map((topic, index) => {
    const marks = [
      topic.unread ? '*' : ' ',
      topic.kind === 'sticky' || topic.kind === 'announcement' ? 'P' : ' ',
      topic.locked ? 'L' : ' ',
      topic.solved ? '✓' : ' ',
    ].join('');
    const meta = `${pad(count(topic.replies), 6)}${pad(relative(topic.lastPostAt ?? topic.createdAt), 6)}`;
    const title = truncate(topic.title, Math.max(10, width - metaWidth - marks.length - 6));
    return {
      label: `${index === state.selected ? '>' : ' '}${marks} ${pad(title, Math.max(10, width - metaWidth - marks.length - 6))}${meta}`,
    };
  });

  ui.panel({ title: state.forumName || 'Topics', size: body }, (panel) => {
    panel.list({ items, selected: -1, offset: state.scroll, scrollbar: true });
  });
}

function topicScreen(ui: Container, state: State, width: number, height: number): void {
  const body = Math.max(3, height - 6);
  if (!state.posts.length) {
    emptyPanel(ui, state.topicTitle || 'Topic', state.loading ? 'Loading…' : 'Nothing here.', body);
    return;
  }

  // Posts are rendered as a flowing transcript rather than one panel each: a
  // reader scrolls through a thread, they do not tab between boxes.
  const lines: { label: string }[] = [];
  const columnWidth = Math.max(20, width - 6);

  state.posts.forEach((post, index) => {
    const marker = index === state.selected ? '>' : ' ';
    const byline = `${post.author ?? 'deleted'} · ${relative(post.createdAt)}${post.editedAt ? ' · edited' : ''}${post.reactions ? ` · ♥${post.reactions}` : ''}`;
    lines.push({ label: `${marker} #${index + 1}  ${truncate(byline, columnWidth)}` });
    for (const line of wrapText(post.text, columnWidth - 4)) {
      lines.push({ label: `     ${line}` });
    }
    lines.push({ label: '' });
  });

  ui.panel({ title: truncate(state.topicTitle, Math.max(10, width - 4)), size: body }, (panel) => {
    panel.list({ items: lines, selected: -1, offset: state.scroll, scrollbar: true });
  });
}

function notificationsScreen(ui: Container, state: State, width: number, height: number): void {
  const body = Math.max(3, height - 6);
  if (!state.notifications.length) {
    emptyPanel(ui, 'Notifications', state.loading ? 'Loading…' : 'Nothing new.', body);
    return;
  }
  const items = state.notifications.map((row, index) => {
    const unread = row.readAt === null ? '*' : ' ';
    const when = pad(relative(row.createdAt), 5);
    const label = truncate(
      `${row.kind}: ${row.title ?? ''}${row.excerpt ? ` — ${row.excerpt}` : ''}`,
      Math.max(10, width - when.length - 6),
    );
    return { label: `${index === state.selected ? '>' : ' '}${unread} ${pad(label, Math.max(10, width - when.length - 6))}${when}` };
  });
  ui.panel({ title: 'Notifications', size: body }, (panel) => {
    panel.list({ items, selected: -1, offset: state.scroll, scrollbar: true });
  });
}

function searchScreen(ui: Container, state: State, width: number, height: number): void {
  const body = Math.max(3, height - 8);
  ui.panel({ title: 'Search', height: 3 }, (panel) => {
    panel.text(`  ${state.query}${state.screen === 'search' ? '▏' : ''}`);
  });
  if (!state.hits.length) {
    emptyPanel(
      ui,
      'Results',
      state.loading ? 'Searching…' : state.query ? 'Nothing matched.' : 'Type to search, enter to run it.',
      body,
    );
    return;
  }
  const items: { label: string }[] = [];
  state.hits.forEach((hit, index) => {
    items.push({ label: `${index === state.selected ? '>' : ' '} ${truncate(hit.title, width - 6)}` });
    items.push({ label: `    ${truncate(`${hit.author ?? 'someone'}: ${hit.snippet}`, width - 8)}` });
  });
  ui.panel({ title: `Results (${state.hits.length})`, size: body }, (panel) => {
    panel.list({ items, selected: -1, offset: state.scroll, scrollbar: true });
  });
}

function composeScreen(ui: Container, state: State, width: number, height: number): void {
  const compose = state.compose;
  if (!compose) return;
  const isTopic = compose.kind === 'topic';

  if (isTopic) {
    ui.panel({ title: compose.field === 'title' ? 'Title (editing)' : 'Title', height: 3 }, (panel) => {
      panel.text(`  ${compose.title}${compose.field === 'title' ? '▏' : ''}`);
    });
  }

  const body = Math.max(3, height - (isTopic ? 11 : 8));
  ui.panel(
    { title: compose.field === 'body' ? 'Message (editing)' : 'Message', size: body },
    (panel) => {
      const lines = wrapText(compose.body, Math.max(20, width - 6));
      const shown = lines.slice(Math.max(0, lines.length - (body - 2)));
      for (const line of shown) panel.text(`  ${line}`);
      if (compose.field === 'body') panel.text(`  ${shown.length ? '' : ''}▏`);
    },
  );
}

function loginScreen(ui: Container, state: State, width: number): void {
  const login = state.login;
  ui.panel({ title: 'Sign in', height: 11 }, (panel) => {
    if (!login) {
      panel.spacer(1);
      panel.text('  Starting…');
      return;
    }
    panel.spacer(1);
    panel.text('  Open this page in a browser and approve the code:');
    panel.spacer(1);
    panel.heading(`    ${login.userCode}`);
    panel.spacer(1);
    panel.label(`    ${truncate(login.verifyUrl, Math.max(20, width - 8))}`);
    panel.spacer(1);
    panel.label('  Waiting for approval…');
  });
}

function helpScreen(ui: Container): void {
  ui.panel({ title: 'Keys', height: 18 }, (panel) => {
    panel.keyValues([
      { label: 'j / k, ↓ / ↑', value: 'move' },
      { label: 'enter', value: 'open' },
      { label: 'backspace, esc', value: 'back' },
      { label: 'n', value: 'new topic (in a forum)' },
      { label: 'r', value: 'reply (in a topic)' },
      { label: '/', value: 'search' },
      { label: 'g', value: 'notifications' },
      { label: 'a', value: 'mark all notifications read' },
      { label: 'L', value: 'sign in on this device' },
      { label: 'R', value: 'reload' },
      { label: 'ctrl+s', value: 'send, while composing' },
      { label: '?', value: 'this help' },
      { label: 'q, ctrl+c', value: 'quit' },
    ]);
  });
}

/** How far the list must be scrolled to keep the selection on screen. */
export function scrollFor(state: State, viewport: number): number {
  const total = rowCount(state);
  if (total === 0) return 0;
  if (state.selected < state.scroll) return state.selected;
  if (state.selected >= state.scroll + viewport) return state.selected - viewport + 1;
  return Math.min(state.scroll, Math.max(0, total - viewport));
}
