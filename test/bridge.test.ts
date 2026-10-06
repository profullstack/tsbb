import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createBridgeHost } from '@profullstack/bridges';

const BOARD = 'http://localhost:3992';
const SECRET = 's'.repeat(43);
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-bridge-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = BOARD;
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';
process.env.TSBB_BRIDGE_AUTHORIZE_URL = 'https://host.example/api/v1/bridge/authorize';
process.env.TSBB_BRIDGE_TOKEN_URL = 'https://host.example/api/v1/bridge/token';
process.env.TSBB_BRIDGE_CLIENT_ID = 'tsbb';
process.env.TSBB_BRIDGE_SECRET = SECRET;
process.env.TSBB_BRIDGE_NAME = 'Host';
process.env.TSBB_BRIDGE_AUTO_COOKIE = 'host_session';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const core = await import('../packages/core/src/index.ts');

let hostUser: Record<string, unknown> | null = null;
const host = createBridgeHost({
  clients: { tsbb: { secret: SECRET, redirectUris: [`${BOARD}/auth/bridge/callback`] } },
  getUser: async () => hostUser as never,
  loginUrl: (returnTo) => `https://host.example/login?next=${encodeURIComponent(returnTo)}`,
});

let app: { fetch: (req: Request) => Response | Promise<Response> };
const realFetch = globalThis.fetch;

function cookiesOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function get(path: string, cookies: Record<string, string> = {}, accept = 'text/html') {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return app.fetch(new Request(`${BOARD}${path}`, { headers: { accept, ...(cookie ? { cookie } : {}) } }));
}

/** Start on the board, pass through the host, land back on the board. */
async function signIn(prompt: 'login' | 'none', returnTo = '/latest') {
  const start = await get(`/auth/bridge?prompt=${prompt}&return=${encodeURIComponent(returnTo)}`);
  assert.equal(start.status, 302);
  const state = cookiesOf(start);
  const atHost = await host.authorize(new Request(start.headers.get('location') ?? ''));
  const back = new URL(atHost.headers.get('location') ?? '');
  const callback = await get(`${back.pathname}${back.search}`, state);
  return { callback, cookies: cookiesOf(callback), atHost };
}

describe('host accounts on the board (bridges)', () => {
  before(async () => {
    // The board's token request goes to the in-process host. Installed before
    // boot, because the bridge client takes fetch when it is created.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith('https://host.example/') ? host.token(new Request(url, init)) : realFetch(input, init);
    }) as typeof fetch;
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
  });
  after(() => {
    globalThis.fetch = realFetch;
    db.setDb(null);
  });

  it('offers the host on the sign-in page', async () => {
    const page = await (await get('/login')).text();
    assert.match(page, /Continue with Host/);
  });

  it('creates and links an account on first arrival, and finds the same one after', async () => {
    hostUser = { sub: 'did:key:alice', name: 'Alice Doe', email: 'alice@example.com', emailVerified: true };
    const first = await signIn('login', '/latest');
    assert.equal(first.callback.status, 302);
    assert.equal(first.callback.headers.get('location'), '/latest');
    assert.ok(first.cookies.tsbb_session, 'signed in');

    const user = await core.userByEmail('alice@example.com');
    assert.ok(user, 'account created with the verified email');
    assert.equal(user?.username, 'alice_doe');

    // The host changes their name and email: the link holds, by sub.
    hostUser = { sub: 'did:key:alice', name: 'Alice Renamed', email: 'new@example.com', emailVerified: true };
    const again = await signIn('login');
    const me = await (await get('/settings', { tsbb_session: again.cookies.tsbb_session ?? '' })).text();
    assert.match(me, /alice_doe/);
    assert.equal(await core.userByEmail('new@example.com'), null, 'no second account');
  });

  it('never trusts an unverified email to link an existing account', async () => {
    hostUser = { sub: 'did:key:mallory', name: 'Mallory', email: 'alice@example.com' };
    await signIn('login');
    const row = await db.one<{ email: string; user_id: number }>(
      `SELECT u.email, i.user_id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.subject = ?`,
      ['did:key:mallory'],
    );
    assert.match(String(row?.email), /@bridge\.invalid$/, 'a placeholder, not alice');
    const alice = await core.userByEmail('alice@example.com');
    assert.notEqual(row?.user_id, alice?.id);
  });

  it('queues no mail to a placeholder address', async () => {
    const before = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM email_queue');
    await core.queueEmail({ to: 'abc@bridge.invalid', subject: 's', html: 'h', text: 't', kind: 'test' });
    const after = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM email_queue');
    assert.equal(Number(after?.n), Number(before?.n));
  });

  it('signs a host user in silently, and leaves guests and crawlers alone', async () => {
    const guest = await get('/');
    assert.equal(guest.status, 200, 'no host cookie: no detour');

    const hinted = await get('/f/general?page=2', { host_session: 'x' });
    assert.equal(hinted.status, 302);
    assert.equal(hinted.headers.get('location'), '/auth/bridge?prompt=none&return=%2Ff%2Fgeneral%3Fpage%3D2');

    assert.equal((await get('/feed.xml', { host_session: 'x' }, 'application/rss+xml')).status, 200, 'not a page');
    assert.equal((await get('/', { host_session: 'x', tsbb_bridge_skip: '1' })).status, 200, 'skip window');

    hostUser = { sub: 'did:key:bob', name: 'Bob' };
    const silent = await signIn('none', '/');
    assert.ok(silent.cookies.tsbb_session, 'came back signed in');
  });

  it('turns a signed-out host into a quiet guest visit, not a loop', async () => {
    hostUser = null;
    const silent = await signIn('none', '/f/general');
    assert.equal(new URL(silent.atHost.headers.get('location') ?? '').searchParams.get('error'), 'login_required');
    assert.equal(silent.callback.headers.get('location'), '/f/general');
    assert.equal(silent.cookies.tsbb_bridge_skip, '1', 'and does not try again on the next page');
  });

  it('refuses a return path that leaves the board', async () => {
    hostUser = { sub: 'did:key:carol', name: 'Carol' };
    const result = await signIn('login', '//evil.example/x');
    assert.equal(result.callback.headers.get('location'), '/');
  });
});
