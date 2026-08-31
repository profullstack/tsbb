import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The REST API and the MCP endpoint, against the real app.
 *
 * These are the surfaces other people's programs bind to, so the things worth
 * asserting are the ones that break somebody else's script when they change:
 * that the index describes what is actually mounted, that every path the
 * OpenAPI document advertises exists, and that a token cannot read past the
 * permissions a browser would enforce.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-api-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3996';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
let token = '';
let topicId = 0;
let postId = 0;

function url(path: string): string {
  return `http://localhost:3996${path}`;
}

async function api<T>(path: string, withToken = false): Promise<T> {
  const response = await app.fetch(
    new Request(url(path), {
      headers: withToken ? { authorization: `Bearer ${token}` } : {},
    }),
  );
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** One JSON-RPC round trip against /api/mcp. */
async function rpc(
  method: string,
  params?: Record<string, unknown>,
  withToken = true,
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await app.fetch(
    new Request(url('/api/mcp'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(withToken ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function callTool(name: string, args: Record<string, unknown> = {}, withToken = true) {
  const { body } = await rpc('tools/call', { name, arguments: args }, withToken);
  return body as unknown as {
    result?: { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
    error?: { code: number; message: string };
  };
}

describe('the API and MCP surfaces', () => {
  before(async () => {
    await seed({ quiet: true });
    await core.setSettings({ 'posts.floodSeconds': 0 });
    const booted = await boot({ listen: false });
    app = booted.app;

    // A member with a token, made the way the device flow makes one, so the
    // tests exercise the same path a real client takes.
    const user = await core.createUser({ email: 'api@example.com', username: 'apiuser' });
    token = await core.mintToken({ userId: user.id, label: 'test' });

    const forum = await core.forumBySlug('general');
    assert.ok(forum, 'the seed should create a general forum');
    const viewer = await core.viewerFromToken(token);
    const created = await core.createTopic({
      forum,
      viewer,
      title: 'A topic the API can see',
      body: 'The body of the first post.',
      format: 'markdown',
    });
    topicId = created.topic.id;
    postId = created.post.id;
  });

  after(() => {
    db.setDb(null);
  });

  it('describes itself, and points at the MCP endpoint', async () => {
    const index = await api<{
      api: string;
      endpoints: Record<string, string>;
      mcp: { endpoint: string; tools: number };
      authenticated: boolean;
    }>('/api/v1');

    assert.equal(index.api, 'tsbb');
    assert.equal(index.authenticated, false, 'an unauthenticated index says so');
    assert.equal(index.mcp.endpoint, 'http://localhost:3996/api/mcp');
    assert.ok(index.mcp.tools > 0, 'the index should count the MCP tools');
    assert.ok(index.endpoints.search?.includes('/api/v1/search'));
  });

  it('serves an OpenAPI document whose every path is actually mounted', async () => {
    const doc = await api<{ paths: Record<string, Record<string, unknown>> }>('/api/v1/openapi.json');
    const paths = Object.keys(doc.paths);
    assert.ok(paths.length > 10, 'the document should cover the API');

    for (const path of paths) {
      // Only the documented GETs can be probed without writing something.
      if (!doc.paths[path]?.get) continue;
      const concrete = path
        .replace('{id}', String(topicId))
        .replace('{slug}', 'general')
        .replace('{username}', 'apiuser');
      const response = await app.fetch(
        new Request(url(concrete.includes('search') ? `${concrete}?q=topic` : concrete), {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      assert.notEqual(response.status, 404, `${concrete} is documented but not mounted`);
    }
  });

  it('flattens the forum tree with a usable depth', async () => {
    const { forums } = await api<{ forums: { slug: string; depth: number; kind: string }[] }>(
      '/api/v1/forums',
    );
    assert.ok(forums.length > 0);
    assert.ok(
      forums.some((forum) => forum.slug === 'general'),
      'the seeded general forum should be listed',
    );
    assert.ok(forums.every((forum) => Number.isInteger(forum.depth) && forum.depth >= 0));
  });

  it('returns one post, with the topic it belongs to', async () => {
    const result = await api<{ post: { id: number; text: string }; topic: { id: number } }>(
      `/api/v1/posts/${postId}`,
    );
    assert.equal(result.post.id, postId);
    assert.equal(result.topic.id, topicId);
    assert.match(result.post.text, /body of the first post/);
  });

  it('returns a member profile without leaking their email address', async () => {
    const { user } = await api<{ user: Record<string, unknown> }>('/api/v1/users/apiuser');
    assert.equal(user.username, 'apiuser');
    assert.equal(user.email, undefined, 'an email address is not public');
  });

  it('counts the board', async () => {
    const stats = await api<{ members: number; topics: number; posts: number }>('/api/v1/stats');
    assert.ok(stats.members >= 1);
    assert.ok(stats.topics >= 1);
    assert.ok(stats.posts >= 1);
  });

  /*
   * A hidden forum used to be hidden from the listings only: its permission
   * rows still said members could read, so anybody with a topic's URL — or
   * willing to count upwards through the ids — was served the page, signed in
   * or not. Every route below resolves permissions from the forum, so this
   * covers the API, the MCP tools and the HTML pages at once.
   */
  it('refuses a hidden forum by URL, not only in the listings', async () => {
    const hidden = await core.createForum({ name: 'Staff only', slug: 'staff-only', kind: 'forum' });
    await db.run('UPDATE forums SET is_hidden = 1 WHERE id = ?', [hidden.id]);
    const admin = await core.createUser({ email: 'boss@example.com', username: 'boss' });
    await db.run('UPDATE users SET is_admin = 1, is_moderator = 1 WHERE id = ?', [admin.id]);
    const session = await core.createSession(admin.id);
    const adminViewer = await core.viewerFromSession(session.id);
    const secret = await core.createTopic({
      forum: hidden,
      viewer: adminViewer,
      title: 'Not for members',
      body: 'A private conversation.',
      format: 'markdown',
    });

    const handle = `${secret.topic.slug}-${secret.topic.id}`;
    const probes: [string, Request][] = [
      ['the post endpoint', new Request(url(`/api/v1/posts/${secret.post.id}`), { headers: { authorization: `Bearer ${token}` } })],
      ['the topic endpoint', new Request(url(`/api/v1/topics/${secret.topic.id}`), { headers: { authorization: `Bearer ${token}` } })],
      ['the topic list', new Request(url('/api/v1/forums/staff-only/topics'), { headers: { authorization: `Bearer ${token}` } })],
      ['the topic page, to a guest', new Request(url(`/t/${handle}`))],
      ['the forum page, to a guest', new Request(url('/f/staff-only'))],
    ];

    for (const [label, request] of probes) {
      const response = await app.fetch(request);
      assert.ok(
        response.status === 403 || response.status === 404,
        `${label} served a hidden forum with ${response.status}`,
      );
    }

    // And the MCP tools, which reach the board the same way.
    const answer = await callTool('read_topic', { topicId: secret.topic.id });
    assert.equal(answer.result?.isError, true, 'a tool must not read a hidden forum either');
  });

  describe('MCP over HTTP', () => {
    it('completes the handshake and echoes the protocol version it was asked for', async () => {
      const { body } = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      });
      const result = (body as never as { result: Record<string, never> }).result;
      assert.equal((result as never as { protocolVersion: string }).protocolVersion, '2025-06-18');
      assert.ok((result as never as { capabilities: { tools: unknown } }).capabilities.tools);
      assert.equal((result as never as { serverInfo: { name: string } }).serverInfo.name, 'tsbb');
    });

    it('answers a notification with 202 and no body', async () => {
      const response = await app.fetch(
        new Request(url('/api/mcp'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        }),
      );
      assert.equal(response.status, 202);
      assert.equal((await response.text()).trim(), '');
    });

    it('lists write tools only when a token was presented', async () => {
      const withToken = await rpc('tools/list', {}, true);
      const asGuest = await rpc('tools/list', {}, false);

      const names = (payload: typeof withToken): string[] =>
        ((payload.body as never as { result: { tools: { name: string }[] } }).result.tools ?? []).map(
          (tool) => tool.name,
        );

      assert.ok(names(withToken).includes('reply_to_topic'));
      assert.ok(names(withToken).includes('search_posts'));
      assert.ok(!names(asGuest).includes('reply_to_topic'), 'a guest is not offered writes');
      assert.ok(names(asGuest).includes('search_posts'), 'a guest can still read');
    });

    it('reads a topic through a tool, as text a model can use', async () => {
      const answer = await callTool('read_topic', { topicId });
      assert.ok(!answer.result?.isError, answer.result?.content[0]?.text);
      assert.match(answer.result?.content[0]?.text ?? '', /body of the first post/);
      assert.equal(
        (answer.result?.structuredContent?.topic as { id: number } | undefined)?.id,
        topicId,
      );
    });

    it('searches, and says so plainly when nothing matched', async () => {
      const hit = await callTool('search_posts', { query: 'topic' });
      assert.match(hit.result?.content[0]?.text ?? '', /results for/);

      const miss = await callTool('search_posts', { query: 'zzzznothinghere' });
      assert.match(miss.result?.content[0]?.text ?? '', /Nothing matched/);
    });

    it('tells a guest why a write tool is missing rather than pretending it does not exist', async () => {
      const answer = await callTool('reply_to_topic', { topicId, body: 'hello' }, false);
      assert.ok(answer.error, 'a guest calling a write tool is a protocol-level error');
      assert.match(answer.error?.message ?? '', /read-only/);
    });

    it('posts a reply through a tool, and the board has it', async () => {
      const answer = await callTool('reply_to_topic', {
        topicId,
        body: 'A reply written by an assistant.',
      });
      assert.ok(!answer.result?.isError, answer.result?.content[0]?.text);

      const topic = await api<{ posts: { text: string }[] }>(`/api/v1/topics/${topicId}`, true);
      assert.ok(
        topic.posts.some((post) => post.text.includes('written by an assistant')),
        'the reply should be readable back through the API',
      );
    });

    it('reports a bad argument as a tool error the model can act on', async () => {
      const answer = await callTool('read_topic', { topicId: 999999 });
      assert.equal(answer.result?.isError, true);
      assert.ok((answer.result?.content[0]?.text ?? '').length > 0);
    });

    it('refuses an unknown method and unparseable JSON', async () => {
      const unknown = await rpc('resources/list');
      assert.equal(
        (unknown.body as never as { error: { code: number } }).error.code,
        -32601,
        'an unimplemented method is method-not-found',
      );

      const broken = await app.fetch(
        new Request(url('/api/mcp'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not json at all',
        }),
      );
      assert.equal(broken.status, 400);
    });

    it('does not accept a session cookie as authorisation', async () => {
      // The board's own cookie must not authorise an MCP call: a browser sends
      // cookies with a cross-origin POST, and a token is meant to be handed
      // over deliberately.
      const user = await core.userByUsername('apiuser');
      assert.ok(user);
      const session = await core.createSession(user.id);
      const response = await app.fetch(
        new Request(url('/api/mcp'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `tsbb_session=${session.id}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
        }),
      );
      const body = (await response.json()) as { result: { tools: { name: string }[] } };
      assert.ok(
        !body.result.tools.some((tool) => tool.name === 'reply_to_topic'),
        'a cookie must not unlock the write tools',
      );
    });

    it('answers GET with 405 rather than hanging on a stream it never sends', async () => {
      const response = await app.fetch(new Request(url('/api/mcp')));
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'POST');
    });
  });
});
