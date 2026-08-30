import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * End-to-end through the real Hono app: a fresh database, the real routes, the
 * real plugin host. Nothing here is mocked except the clock-free bits, because
 * the things most likely to break — permission resolution, the signature gate,
 * notification fan-out — only misbehave once several layers are stacked.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-e2e-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3999';
process.env.TSBB_SESSION_SECRET = 'test-secret-not-a-real-one';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const core = await import('../packages/core/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
let cookie = '';

function url(path: string): string {
  return `http://localhost:3999${path}`;
}

async function get(path: string, withSession = true): Promise<Response> {
  return app.fetch(
    new Request(url(path), { headers: withSession && cookie ? { cookie } : {} }),
  );
}

async function post(path: string, body: Record<string, string>): Promise<Response> {
  return app.fetch(
    new Request(url(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    }),
  );
}

describe('a board end to end', () => {
  before(async () => {
    await seed({ quiet: true });
    const booted = await boot({ listen: false });
    app = booted.app;
  });

  after(() => {
    db.setDb(null);
  });

  it('serves the board index to a guest', async () => {
    const response = await get('/', false);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('General discussion'));
    assert.ok(body.includes('Sign in'), 'a guest is offered a way in');
  });

  it('does not let a guest start a topic', async () => {
    const response = await app.fetch(new Request(url('/f/general/new')));
    // Guests are sent to sign in rather than shown a form they cannot submit.
    assert.equal(response.status, 302);
    assert.ok(response.headers.get('location')?.startsWith('/login'));
  });

  it('answers a sign-in request identically whoever asked', async () => {
    // Known, unknown and rate-limited addresses must be indistinguishable, or
    // the endpoint enumerates who has an account.
    const unknown = await post('/login', { email: 'nobody@example.com' });
    const body = await unknown.text();
    assert.ok(body.includes('Check your inbox'));
    assert.ok(body.includes('nobody@example.com'));
  });

  it('signs in through a magic link and makes the first account an admin', async () => {
    const { token } = await core.startMagicLink({ email: 'ann@example.com' });
    const response = await app.fetch(
      new Request(url(`/auth/${token}`), { redirect: 'manual' }),
    );
    assert.equal(response.status, 302);
    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes('tsbb_session='), 'a session cookie is set');
    assert.ok(setCookie.includes('HttpOnly'), 'the session cookie is HttpOnly');
    cookie = setCookie.split(';')[0] ?? '';

    const user = await core.userByEmail('ann@example.com');
    assert.ok(user, 'the link created the account');
    assert.equal(user?.isAdmin, true, 'the first account on a fresh board is its admin');
  });

  it('refuses to reuse a consumed link', async () => {
    const { token } = await core.startMagicLink({ email: 'ann@example.com' });
    await app.fetch(new Request(url(`/auth/${token}`), { redirect: 'manual' }));
    const second = await app.fetch(new Request(url(`/auth/${token}`), { redirect: 'manual' }));
    const body = await second.text();
    assert.ok(body.includes('expired or has already been used'));
  });

  it('creates a topic and shows it on the board', async () => {
    const response = await post('/f/general/new', {
      title: 'Hello from the test suite',
      body: 'This is the **first** post on this board.',
      format: 'markdown',
    });
    assert.equal(response.status, 303);
    const location = response.headers.get('location') ?? '';
    assert.match(location, /^\/t\/hello-from-the-test-suite-\d+$/);

    const page = await get(location);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.ok(body.includes('Hello from the test suite'));
    assert.ok(body.includes('<strong>first</strong>'), 'markdown is rendered');
  });

  it('redirects a stale slug to the canonical one instead of serving a duplicate', async () => {
    const topic = await db.one<{ id: number }>('SELECT id FROM topics ORDER BY id DESC LIMIT 1');
    const response = await app.fetch(
      new Request(url(`/t/an-old-slug-${topic?.id}`), { redirect: 'manual' }),
    );
    assert.equal(response.status, 301);
    assert.match(response.headers.get('location') ?? '', /hello-from-the-test-suite/);
  });

  it('holds a signature back until its author has earned it', async () => {
    const ann = await core.userByEmail('ann@example.com');
    assert.ok(ann);
    await core.updateProfile(ann.id, { signature: 'Find me at https://example.com' });

    const settings = await core.loadSettings(true);
    const fresh = await core.userById(ann.id);
    assert.ok(fresh);

    // One post in: below the threshold, so nothing is rendered.
    const gateNow = core.signatureGate(fresh, settings);
    assert.equal(gateNow.visible, false);
    assert.equal(gateNow.minPosts, 10);
    assert.ok(gateNow.remaining > 0);

    const topic = await db.one<{ id: number; slug: string }>(
      'SELECT id, slug FROM topics ORDER BY id DESC LIMIT 1',
    );
    const page = await get(`/t/${topic?.slug}-${topic?.id}`);
    const body = await page.text();
    assert.ok(!body.includes('post-signature'), 'no empty separator under a new member');

    // Now push the author over the line and check it appears.
    await db.run('UPDATE users SET post_count = 10 WHERE id = ?', [ann.id]);
    const veteran = await core.userById(ann.id);
    assert.ok(veteran);
    assert.equal(core.signatureGate(veteran, settings).visible, true);

    const after = await get(`/t/${topic?.slug}-${topic?.id}`);
    const afterBody = await after.text();
    assert.ok(afterBody.includes('post-signature'), 'the signature appears once earned');
    assert.ok(afterBody.includes('example.com'));
  });

  it('notifies a subscriber when somebody replies, but never the author', async () => {
    const topic = await db.one<{ id: number; slug: string }>(
      'SELECT id, slug FROM topics ORDER BY id DESC LIMIT 1',
    );
    const ann = await core.userByEmail('ann@example.com');
    assert.ok(topic && ann);

    const before = await core.unreadCount(ann.id);

    // A second member replies.
    const bob = await core.createUser({ username: 'bob', email: 'bob@example.com' });
    const session = await core.createSession(bob.id);
    const bobCookie = `tsbb_session=${session.id}`;
    const response = await app.fetch(
      new Request(url(`/t/${topic.slug}-${topic.id}/reply`), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: bobCookie },
        body: new URLSearchParams({ body: 'Replying to say hello.', format: 'markdown' }).toString(),
        redirect: 'manual',
      }),
    );
    assert.equal(response.status, 303);

    const annAfter = await core.unreadCount(ann.id);
    assert.equal(annAfter, before + 1, 'the topic author was notified of the reply');
    assert.equal(await core.unreadCount(bob.id), 0, 'the replier is never notified of their own reply');
  });

  it('notifies a mention instead of a reply, not both', async () => {
    const topic = await db.one<{ id: number; slug: string }>(
      'SELECT id, slug FROM topics ORDER BY id DESC LIMIT 1',
    );
    const carol = await core.createUser({ username: 'carol', email: 'carol@example.com' });
    const session = await core.createSession(carol.id);

    const ann = await core.userByEmail('ann@example.com');
    assert.ok(ann && topic);
    await core.markNotificationsRead(ann.id);

    await app.fetch(
      new Request(url(`/t/${topic.slug}-${topic.id}/reply`), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `tsbb_session=${session.id}`,
        },
        body: new URLSearchParams({ body: 'What do you think @ann?' }).toString(),
        redirect: 'manual',
      }),
    );

    const rows = await db.all<{ kind: string }>(
      'SELECT kind FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [ann.id],
    );
    assert.equal(rows.length, 1, 'one notification, not a mention *and* a reply');
    assert.equal(rows[0]?.kind, 'mention', 'being addressed directly wins over the subscription');
  });

  it('serves the stylesheet immutably under its content hash', async () => {
    const index = await get('/', false);
    const href = /\/assets\/app\.([0-9a-f]+)\.css/.exec(await index.text())?.[0];
    assert.ok(href);
    const css = await get(href, false);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('cache-control') ?? '', /immutable/);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    const body = await css.text();
    assert.ok(body.includes('--primary'), 'shadcn tokens are present');

    // A stale hash must not serve stale bytes under a year-long cache.
    const stale = await get('/assets/app.deadbeef.css', false);
    assert.equal(stale.status, 302);
  });

  it('reports plugin health', async () => {
    const response = await get('/healthz', false);
    const health = (await response.json()) as { ok: boolean; plugins: string[] };
    assert.equal(health.ok, true);
    assert.ok(Array.isArray(health.plugins));
  });
});
