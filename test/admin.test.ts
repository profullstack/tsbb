import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-admin-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3996';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
let registry: Awaited<ReturnType<typeof boot>>['registry'];
let adminCookie = '';
let adminId = 0;

const url = (path: string) => `http://localhost:3996${path}`;

const get = (path: string, cookie = adminCookie) =>
  app.fetch(new Request(url(path), { headers: cookie ? { cookie } : {}, redirect: 'manual' }));

const post = (path: string, body: Record<string, string>, cookie = adminCookie) =>
  app.fetch(
    new Request(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    }),
  );

describe('the admin panel', () => {
  before(async () => {
    await seed({ quiet: true });
    const booted = await boot({ listen: false });
    app = booted.app;
    registry = booted.registry;

    const admin = await core.createUser({ username: 'root', email: 'root@example.com', isAdmin: true });
    adminId = admin.id;
    const session = await core.createSession(admin.id);
    adminCookie = `tsbb_session=${session.id}`;
  });

  after(() => db.setDb(null));

  it('is closed to guests and to ordinary members', async () => {
    const guest = await app.fetch(new Request(url('/admin'), { redirect: 'manual' }));
    assert.equal(guest.status, 302, 'a guest is sent to sign in');

    const member = await core.createUser({ username: 'mallory', email: 'm@example.com' });
    const session = await core.createSession(member.id);
    const response = await get('/admin/settings', `tsbb_session=${session.id}`);
    assert.equal(response.status, 403);
  });

  it('is closed to an API token even when its owner is an administrator', async () => {
    // Administrative power needs a real session, so a leaked token can never
    // reconfigure the board.
    const token = await core.mintToken({ userId: adminId, label: 'test' });
    const response = await app.fetch(
      new Request(url('/admin/settings'), { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' }),
    );
    assert.equal(response.status, 403);
    const body = await response.text();
    assert.ok(body.includes('token is never an administrator'));
  });

  it('saves board settings, reading each value by the type of its default', async () => {
    // An unchecked checkbox sends nothing at all, which is why booleans are
    // read by presence and not by value.
    const response = await post('/admin/settings', {
      'board.name': 'The Test Board',
      'signatures.minPosts': '25',
      'posts.floodSeconds': '0',
      // signatures.enabled deliberately omitted, as a browser would omit it
    });
    assert.equal(response.status, 303);

    const settings = await core.loadSettings(true);
    assert.equal(settings['board.name'], 'The Test Board');
    assert.equal(settings['signatures.minPosts'], 25, 'a number stayed a number');
    assert.equal(settings['signatures.enabled'], false, 'an omitted checkbox is false, not unchanged');

    const index = await get('/', '');
    assert.ok((await index.text()).includes('The Test Board'), 'and the board is renamed everywhere');
  });

  it('creates a forum and shows it on the board', async () => {
    const response = await post('/admin/forums', {
      name: 'Off topic',
      description: 'Anything goes.',
      kind: 'forum',
      position: '9',
    });
    assert.equal(response.status, 303);
    const forum = await core.forumBySlug('off-topic');
    assert.ok(forum, 'the slug came from the name');
    assert.equal(forum?.description, 'Anything goes.');
  });

  it('renders a plugin settings form from its manifest', async () => {
    const response = await get('/admin/plugins');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('CrawlProof Ads'));
    assert.ok(body.includes('Ad slot ID'), 'the manifest drove the field label');
    assert.ok(body.includes('name="hideForStaff"'), 'and its boolean');
    assert.ok(body.includes('Installing one is installing code'), 'the trust model is stated plainly');
  });

  it('writes only the settings keys the manifest declares', async () => {
    const response = await post('/admin/plugins/crawlproof-ads/settings', {
      slotId: 'slot-from-admin',
      hideForStaff: 'on',
      // A field the plugin never asked for is not a setting, whatever it is called.
      isAdmin: 'true',
      __proto__: 'polluted',
    });
    assert.equal(response.status, 303);

    const config = registry.config('crawlproof-ads');
    assert.equal(config.slotId, 'slot-from-admin');
    assert.equal(config.hideForStaff, true);
    assert.ok(!('isAdmin' in config), 'an undeclared key was ignored');
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'and nothing was polluted');
  });

  it('enables and disables a plugin from the panel', async () => {
    await post('/admin/plugins/hello-world/toggle', { enabled: '1' });
    assert.ok(registry.enabled.has('hello-world'));
    await post('/admin/plugins/hello-world/toggle', { enabled: '0' });
    assert.ok(!registry.enabled.has('hello-world'));
  });

  it('promotes a member to moderator', async () => {
    const member = await core.userByUsername('mallory');
    assert.ok(member);
    await post(`/admin/users/${member.id}`, { role: 'moderator', banned: '0' });
    const after = await core.userByUsername('mallory');
    assert.equal(after?.isModerator, true);
    assert.equal(after?.isAdmin, false);
  });

  it('refuses to let an administrator lock themselves out', async () => {
    // On a single-admin board one mis-click here would close the panel
    // permanently, with no way back short of editing the database.
    for (const attempt of [{ role: 'member', banned: '0' }, { role: 'admin', banned: '1' }]) {
      const response = await post(`/admin/users/${adminId}`, attempt);
      const body = await response.text();
      assert.ok(body.includes('cannot remove your own administrator role'), JSON.stringify(attempt));
    }
    const self = await core.userById(adminId);
    assert.equal(self?.isAdmin, true, 'still an admin');
    assert.equal(self?.isBanned, false, 'and not banned');
  });

  it('records role changes in the moderation log', async () => {
    const rows = await db.all<{ action: string }>("SELECT action FROM mod_log WHERE action = 'user.role'");
    assert.ok(rows.length >= 1);
    const response = await get('/admin/moderation');
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('user.role'));
  });
});
