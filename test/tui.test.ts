import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { renderToText } from '@profullstack/hqtui/testing';

/**
 * The terminal client, driven against a real board.
 *
 * The client's fetch is pointed at the in-process Hono app, so these exercise
 * the actual REST surface rather than a fixture — and the views are rendered
 * with hqtui's headless renderer, so the assertions are on the characters that
 * would appear in a terminal.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-tui-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3997';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';
process.env.TSBB_CONFIG_DIR = join(scratch, 'config');

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { BoardClient, ApiError } = await import('../apps/tui/src/client.ts');
const { renderApp } = await import('../apps/tui/src/views.ts');
const { initialState, flattenForums } = await import('../apps/tui/src/state.ts');
const { normaliseServer, loadConfig, rememberBoard } = await import('../apps/tui/src/config.ts');

let client: InstanceType<typeof BoardClient>;
let app: { fetch: (req: Request) => Response | Promise<Response> };

const SIZE = { width: 80, height: 24 };

function screen(state: Parameters<typeof renderApp>[1]): string {
  return renderToText(
    ({ ui, width, height }) => renderApp(ui, state, width, height),
    SIZE,
  );
}

describe('the terminal client', () => {
  before(async () => {
    await seed({ quiet: true });
    // These tests post several times in a row as one user to build up something
    // worth rendering. Flood control is real and correct — it is exercised in
    // the end-to-end suite — but here it would only be testing the clock.
    await core.setSettings({ 'posts.floodSeconds': 0 });
    const booted = await boot({ listen: false });
    app = booted.app;

    // The client speaks to the real app through its fetch handler, so every
    // request goes through the same routing, auth and permission checks a
    // browser would hit.
    client = new BoardClient({
      server: 'http://localhost:3997',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(String(input), init))) as typeof fetch,
    });
  });

  after(() => db.setDb(null));

  it('reads the board as a guest', async () => {
    const board = await client.board();
    assert.equal(board.board.name, 'A tsbb board');
    assert.ok(board.forums.length > 0);
    const me = await client.me();
    assert.equal(me.authenticated, false);
  });

  it('draws the forum list, with categories as headings', async () => {
    const board = await client.board();
    const state = initialState(client.server);
    state.boardName = board.board.name;
    state.forums = flattenForums(board.forums);
    state.loading = false;
    state.status = 'Reading as a guest';

    const text = screen(state);
    assert.ok(text.includes('A tsbb board'), 'the board name is in the header');
    assert.ok(text.includes('COMMUNITY'), 'a category is a heading');
    assert.ok(text.includes('General discussion'), 'a forum is a row');
    assert.ok(text.includes('not signed in'));
    assert.ok(text.includes('q quit'), 'the key hints are visible');
  });

  it('puts the selection marker on the first openable forum, never on a category', async () => {
    const board = await client.board();
    const state = initialState(client.server);
    state.forums = flattenForums(board.forums);
    state.loading = false;

    // The marker sits inside the panel border, so match the row rather than
    // the start of the printed line.
    const lines = screen(state).split('\n');
    const marked = lines.filter((line) => /^\s*\u2502\s*>/.test(line));
    assert.equal(marked.length, 1, 'exactly one row is marked');
    assert.ok(marked[0]?.includes('Announcements'), 'and it is a forum, not the category above it');
  });

  it('posts a topic through the API and shows it in the topic list', async () => {
    const ann = await core.createUser({ username: 'ann', email: 'ann@example.com' });
    const token = await core.mintToken({ userId: ann.id, label: 'tui-test' });
    client.setToken(token);

    const me = await client.me();
    assert.equal(me.authenticated, true);
    assert.equal(me.user?.username, 'ann');

    await client.newTopic('general', 'Posted from a terminal', 'Written in the TUI.');

    const result = await client.topics('general');
    const state = initialState(client.server);
    state.screen = 'topics';
    state.topics = result.topics;
    state.forumName = result.forum.name;
    state.loading = false;
    state.me = me;

    const text = screen(state);
    assert.ok(text.includes('Posted from a terminal'));
    assert.ok(text.includes('General discussion'), 'the panel is titled with the forum');
    assert.ok(text.includes('ann'), 'the signed-in user is shown in the header');
  });

  it('renders a topic as a readable transcript, not a wall of markup', async () => {
    const topics = await client.topics('general');
    const first = topics.topics[0];
    assert.ok(first);

    await client.reply(first.id, 'A reply with **bold** in it and a very long line that will need to be wrapped by the client because a terminal is only so wide.');

    const result = await client.topic(first.id);
    const state = initialState(client.server);
    state.screen = 'topic';
    state.posts = result.posts;
    state.topic = result.topic;
    state.topicTitle = result.topic.title;
    state.canReply = result.canReply;
    state.loading = false;

    const text = screen(state);
    assert.ok(text.includes('Posted from a terminal'), 'the title is the panel');
    assert.ok(text.includes('#1'), 'posts are numbered');
    assert.ok(text.includes('#2'));
    assert.ok(text.includes('ann'), 'the byline names the author');
    // The API hands back plain text alongside the source, so a terminal never
    // has to reimplement the markup parser.
    assert.ok(text.includes('bold'), 'the body is readable');
    assert.ok(!text.includes('**bold**'), 'markdown syntax is not shown raw');

    for (const line of text.split('\n')) {
      assert.ok(line.length <= SIZE.width, `a line overflowed the terminal: ${line.length}`);
    }
  });

  it('draws the sign-in screen with a code a person can read out', () => {
    const state = initialState(client.server);
    state.screen = 'login';
    state.login = {
      userCode: 'QGB3-96DX',
      verifyUrl: 'http://localhost:3997/link?code=QGB3-96DX',
      expiresAt: Date.now() + 600_000,
    };
    const text = screen(state);
    assert.ok(text.includes('QGB3-96DX'));
    assert.ok(text.includes('/link?code='));
    assert.ok(text.includes('Waiting for approval'));
  });

  it('shows an unreachable board by name rather than "fetch failed"', async () => {
    const broken = new BoardClient({
      server: 'http://localhost:1',
      fetch: (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => broken.board(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'unreachable');
        assert.match(error.message, /Cannot reach http:\/\/localhost:1/);
        return true;
      },
    );
  });

  it('renders every screen without throwing at an awkward size', () => {
    const state = initialState(client.server);
    state.loading = false;
    for (const name of ['forums', 'topics', 'topic', 'search', 'notifications', 'help'] as const) {
      state.screen = name;
      for (const size of [{ width: 40, height: 10 }, { width: 200, height: 60 }]) {
        const text = renderToText(({ ui, width, height }) => renderApp(ui, state, width, height), size);
        assert.ok(text.length > 0, `${name} rendered nothing at ${size.width}x${size.height}`);
      }
    }
  });

  it('renders the composer with the field being edited marked', () => {
    const state = initialState(client.server);
    state.screen = 'compose';
    state.loading = false;
    state.compose = { kind: 'topic', forumSlug: 'general', title: 'A title', body: 'Some body', field: 'body' };
    const text = screen(state);
    assert.ok(text.includes('A title'));
    assert.ok(text.includes('Some body'));
    assert.ok(text.includes('Message (editing)'), 'the focused field says so');
    assert.ok(text.includes('ctrl+s send'), 'the composer has its own key hints');
  });
});

describe('the terminal client config', () => {
  it('assumes https for a hostname but not for localhost', () => {
    assert.equal(normaliseServer('forum.example.com'), 'https://forum.example.com');
    assert.equal(normaliseServer('localhost:3000'), 'http://localhost:3000');
    assert.equal(normaliseServer('http://x.test/'), 'http://x.test');
    assert.equal(normaliseServer('https://x.test///'), 'https://x.test');
  });

  it('remembers several boards and which one is current', () => {
    rememberBoard({ server: 'https://a.test', token: 'tok-a' });
    rememberBoard({ server: 'https://b.test', token: null });
    const config = loadConfig();
    assert.equal(config.current, 'https://b.test');
    assert.equal(config.boards['https://a.test']?.token, 'tok-a');
    assert.equal(Object.keys(config.boards).length, 2);
  });
});
