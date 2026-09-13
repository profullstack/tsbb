import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Settings sync, against the real app.
 *
 * What has to hold: the projection that leaves the machine carries no token;
 * loading it adds boards without tokens and never touches the ones here; the
 * board stores a snapshot under revision 1, hands it back, answers an
 * unchanged save with the same revision, refuses a stale one with 409 and the
 * current revision, and lists what it keeps. An empty account is a 200 with
 * `empty: true`, because the OpenAPI probe reads a 404 as "not mounted".
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-sync-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3997';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { applySettings, settingsFrom } = await import('../packages/client/src/sync.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
let token = '';

const url = (path: string) => `http://localhost:3997${path}`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.fetch(
    new Request(url(path), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const snapshot = (current: string) => ({
  version: 1,
  host: 'laptop',
  app: 'tsbb',
  files: { 'boards.json': { content: JSON.stringify({ current, boards: { [current]: { server: current, username: 'ada' } } }) } },
});

describe('the settings projection', () => {
  it('leaves every token behind, and loading adds boards without one', () => {
    const config = {
      current: 'https://a.example',
      boards: {
        'https://a.example': { server: 'https://a.example', token: 'tsbb_secret_a', username: 'ada' },
        'https://b.example': { server: 'https://b.example', token: 'tsbb_secret_b' },
      },
    };
    const settings = settingsFrom(config);
    assert.deepEqual(settings, { current: 'https://a.example', boards: { 'https://a.example': { server: 'https://a.example', username: 'ada' }, 'https://b.example': { server: 'https://b.example' } } });
    assert.ok(!JSON.stringify(settings).includes('tsbb_secret'), 'a token reached the projection');

    const fresh = { current: null, boards: {} };
    const applied = applySettings(settings, fresh);
    assert.deepEqual(applied.added.sort(), ['https://a.example', 'https://b.example']);
    assert.equal(applied.current, 'https://a.example');
    assert.equal(applied.config.boards['https://a.example']?.token, null);
    assert.equal(applied.config.boards['https://a.example']?.username, 'ada');

    // A board already here keeps its token and its current choice.
    const local = { current: 'https://b.example', boards: { 'https://b.example': { server: 'https://b.example', token: 'mine' } } };
    const kept = applySettings(settings, local);
    assert.deepEqual(kept.added, ['https://a.example']);
    assert.equal(kept.current, 'https://b.example');
    assert.equal(kept.config.boards['https://b.example']?.token, 'mine');
  });
});

describe('the settings routes', () => {
  before(async () => {
    await seed({ quiet: true });
    const booted = await boot({ listen: false });
    app = booted.app;
    const user = await core.createUser({ email: 'sync@example.com', username: 'syncuser' });
    token = await core.mintToken({ userId: user.id, label: 'test' });
  });

  after(() => {
    db.setDb(null);
  });

  it('needs a member', async () => {
    const response = await app.fetch(new Request(url('/api/v1/settings')));
    assert.equal(response.status, 401);
  });

  it('is empty at first, then holds revisions, answers unchanged saves, and refuses stale ones', async () => {
    const empty = await call('GET', '/api/v1/settings');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.empty, true);
    assert.equal(empty.body.revision, null);

    const first = await call('PUT', '/api/v1/settings', { snapshot: snapshot('https://a.example'), ifRevision: null });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.revision, 1);
    assert.match(String(first.body.digest), /^[0-9a-f]{64}$/);

    const again = await call('PUT', '/api/v1/settings', { snapshot: snapshot('https://a.example'), ifRevision: 1 });
    assert.equal(again.body.revision, 1);
    assert.equal(again.body.unchanged, true);

    const got = await call('GET', '/api/v1/settings');
    assert.equal(got.status, 200);
    assert.equal(got.body.revision, 1);
    assert.deepEqual((got.body.snapshot as { files: unknown }).files, snapshot('https://a.example').files);

    const second = await call('PUT', '/api/v1/settings', { snapshot: snapshot('https://b.example'), ifRevision: 1 });
    assert.equal(second.body.revision, 2);

    const stale = await call('PUT', '/api/v1/settings', { snapshot: snapshot('https://c.example'), ifRevision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 2);

    const forced = await call('PUT', '/api/v1/settings', { snapshot: snapshot('https://c.example'), ifRevision: null });
    assert.equal(forced.body.revision, 3);

    const revisions = await call('GET', '/api/v1/settings/revisions');
    assert.deepEqual((revisions.body.revisions as { revision: number }[]).map((r) => r.revision), [3, 2, 1]);

    const bad = await call('PUT', '/api/v1/settings', { snapshot: { version: 1, files: { '../x': { content: '' } } } });
    assert.equal(bad.status, 400);
  });
});
