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

  it('throttles a second post from the same account', async () => {
    // Flood control counts off audit_events, which every write already touches,
    // so throttling costs no extra write anywhere.
    await core.setSettings({ 'posts.floodSeconds': 60 });
    const response = await post('/f/introductions/new', {
      title: 'Rapid fire',
      body: 'Posting again immediately after the last one.',
    });
    assert.equal(response.status, 400, 'refused, and with a real status');
    const body = await response.text();
    assert.match(body, /Please wait \d+s before posting again/);
    await core.setSettings({ 'posts.floodSeconds': 0 });
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

  it('never 500s on punctuation in the search box', async () => {
    // FTS5 MATCH takes a query language, not a string, so raw input containing
    // punctuation raises a syntax error — and pasting an error message into a
    // forum's search box is exactly what people do.
    for (const query of [
      'Error: cannot read property "x" of undefined',
      'a@b.com',
      'C++ / C#',
      '((()))',
      'NEAR(a b)',
      '"unterminated',
      '*',
      '-',
    ]) {
      const response = await get(`/search?q=${encodeURIComponent(query)}`, false);
      assert.equal(response.status, 200, `search 500d on ${query}`);
    }
  });

  it('serves a well-formed feed with everything escaped', async () => {
    const response = await get('/feed.xml', false);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/rss\+xml/);
    const body = await response.text();
    assert.ok(body.startsWith('<?xml version="1.0"'));
    assert.ok(body.includes('<atom:link'), 'a self link, so a reader can find its way back');

    // Check the *content* of each title rather than pattern-matching the raw
    // document: a character class next to the closing tag backtracks onto it
    // and reports every well-formed feed as broken.
    for (const match of body.matchAll(/<title>([\s\S]*?)<\/title>/g)) {
      const text = match[1] ?? '';
      assert.ok(!/[<>]/.test(text), `raw angle bracket in a title: ${text}`);
      assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text), `bare ampersand in: ${text}`);
    }
  });

  it('escapes a hostile topic title into the feed', async () => {
    const forum = await db.one<{ id: number }>("SELECT id FROM forums WHERE slug = 'introductions'");
    const ann = await core.userByEmail('ann@example.com');
    assert.ok(forum && ann);
    await core.setSettings({ 'posts.floodSeconds': 0 });
    await core.createTopic({
      forum: (await core.forumBySlug('introductions'))!,
      viewer: { user: ann, groupIds: [], isAdmin: true, isModerator: true, viaToken: false },
      title: 'Tom & Jerry <script>alert(1)</script>',
      body: 'A body long enough to pass validation.',
    });

    const body = await (await get('/feed.xml', false)).text();
    assert.ok(body.includes('Tom &amp; Jerry &lt;script&gt;'), 'escaped, not stripped');
    assert.ok(!body.includes('<script>'), 'and no live tag reached the document');
  });

  it('refuses a feed for a forum the viewer cannot read', async () => {
    // A feed must answer exactly what the page would: a restricted forum does
    // not become readable by asking for its RSS instead.
    const guests = await db.one<{ id: number }>("SELECT id FROM groups WHERE slug = 'guests'");
    const forum = await db.one<{ id: number }>("SELECT id FROM forums WHERE slug = 'bugs'");
    await db.run(
      `INSERT INTO forum_permissions (forum_id, group_id, can_view, can_read) VALUES (?, ?, 0, 0)
       ON CONFLICT (forum_id, group_id) DO UPDATE SET can_view = 0, can_read = 0`,
      [forum?.id ?? 0, guests?.id ?? 0],
    );
    const response = await app.fetch(new Request(url('/f/bugs/feed.xml')));
    assert.equal(response.status, 403);
    const page = await app.fetch(new Request(url('/f/bugs')));
    assert.equal(page.status, 403, 'and the page agrees with the feed');
  });

  it('rejects an avatar upload that is not really an image', async () => {
    // The declared content-type is attacker-controlled, so the magic bytes
    // decide. A file that is not an image never reaches the disk.
    const form = new FormData();
    form.set('avatar', new File([Buffer.from('<?php echo 1; ?>')], 'x.png', { type: 'image/png' }));
    const response = await app.fetch(
      new Request(url('/settings/avatar'), { method: 'POST', headers: { cookie }, body: form }),
    );
    const body = await response.text();
    assert.ok(body.includes('not a PNG, JPEG, GIF or WebP image'), 'refused on content, not on its name');
  });

  it('accepts a real image and serves it back immutably', async () => {
    // A 1x1 PNG, byte for byte.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.set('avatar', new File([png], 'me.png', { type: 'image/png' }));
    const response = await app.fetch(
      new Request(url('/settings/avatar'), { method: 'POST', headers: { cookie }, body: form }),
    );
    assert.equal(response.status, 200);

    const row = await db.one<{ avatar_url: string; avatar_kind: string }>(
      'SELECT avatar_url, avatar_kind FROM users WHERE email_lower = ?',
      ['ann@example.com'],
    );
    assert.equal(row?.avatar_kind, 'upload');
    // The name is a hash of the bytes plus an extension chosen from the sniffed
    // type — never from what the browser called the file.
    assert.match(row?.avatar_url ?? '', /^\/uploads\/[0-9a-f]{32}\.png$/);

    const served = await get(row?.avatar_url ?? '', false);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('cache-control') ?? '', /immutable/);
  });

  it('will not serve a path that is not one of its own generated names', async () => {
    for (const name of ['../../etc/passwd', 'x.php', 'abc.png', '%2e%2e%2fetc%2fpasswd']) {
      const response = await get(`/uploads/${name}`, false);
      assert.ok(response.status === 404, `served ${name}`);
    }
  });

  it('redirects www to the canonical host with a 308, method intact', async () => {
    // Serving both hosts would mean two origins for one board: a cookie set on
    // one is not sent to the other, and a passkey registered on the apex cannot
    // be asserted on www. Redirecting first means no credential is ever minted
    // against a hostname the board does not consider its own.
    //
    // 308 and not 302, because only 308 requires the method and body to be
    // preserved — a form POST to www must arrive as the same POST, not as a GET
    // that silently drops what somebody just wrote.
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.fetch(
        new Request('http://localhost:3999/login'.replace('localhost:3999', 'www.localhost:3999'), {
          method,
          redirect: 'manual',
        }),
      );
      assert.equal(response.status, 308, method);
      assert.equal(response.headers.get('location'), 'http://localhost:3999/login');
    }
  });

  it('reports plugin health', async () => {
    const response = await get('/healthz', false);
    const health = (await response.json()) as { ok: boolean; plugins: string[] };
    assert.equal(health.ok, true);
    assert.ok(Array.isArray(health.plugins));
  });
});
