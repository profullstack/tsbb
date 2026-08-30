import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-plugins-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3998';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { HookBus } = await import('../packages/plugin-host/src/bus.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
let registry: Awaited<ReturnType<typeof boot>>['registry'];

const url = (path: string) => `http://localhost:3998${path}`;

describe('the plugin host', () => {
  before(async () => {
    await seed({ quiet: true });
    const booted = await boot({ listen: false });
    app = booted.app;
    registry = booted.registry;
  });

  after(() => db.setDb(null));

  it('discovers the bundled plugins', () => {
    assert.deepEqual([...registry.plugins.keys()].sort(), ['crawlproof-ads', 'hello-world']);
    assert.deepEqual([...registry.errors.entries()], [], 'no plugin failed to load');
  });

  it('honours defaultEnabled on first sight only', async () => {
    assert.ok(registry.enabled.has('crawlproof-ads'), 'ads ship on');
    assert.ok(!registry.enabled.has('hello-world'), 'the example ships off');

    // An administrator turning the ads off must stay off across restarts —
    // otherwise defaultEnabled would silently re-enable it on every upgrade.
    await registry.setEnabled('crawlproof-ads', false);
    assert.ok(!registry.enabled.has('crawlproof-ads'));
    await registry.reload();
    assert.ok(!registry.enabled.has('crawlproof-ads'), 'the database wins after first sight');

    await registry.setEnabled('crawlproof-ads', true);
    assert.ok(registry.enabled.has('crawlproof-ads'));
  });

  it('renders nothing when the ads plugin has no slot configured', async () => {
    await db.run("UPDATE plugins SET config = '{}' WHERE slug = 'crawlproof-ads'");
    await registry.reload();
    const body = await (await app.fetch(new Request(url('/')))).text();
    assert.ok(!body.includes('cp-ad-unit'), 'an unconfigured board looks finished, not broken');
  });

  it('serves ads over the CSP-safe frame endpoint once a slot is set', async () => {
    await db.run("UPDATE plugins SET config = ? WHERE slug = 'crawlproof-ads'", [
      JSON.stringify({ slotId: 'slot-abc', 'placement.boardIndex': true }),
    ]);
    await registry.reload();

    const response = await app.fetch(new Request(url('/')));
    const body = await response.text();
    assert.ok(body.includes('crawlproof.com/api/ads/frame'), 'uses the frame path, not ad.js');
    assert.ok(!body.includes('ad.js'), 'ad.js would need unsafe-inline site-wide');
    assert.ok(!/[?&]theme=/.test(body), 'no theme is named; the frame answers prefers-color-scheme');

    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-src[^;]*https:\/\/crawlproof\.com/, 'the plugin widened frame-src');
    assert.ok(!csp.includes('unsafe-inline'), 'and nothing else was loosened');
  });

  it('takes the CSP permission away again when the plugin is disabled', async () => {
    await registry.setEnabled('crawlproof-ads', false);
    const response = await app.fetch(new Request(url('/')));
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.ok(!csp.includes('crawlproof.com'), 'a disabled plugin grants nothing');
    await registry.setEnabled('crawlproof-ads', true);
  });

  it('runs a plugin migration and mounts its routes when enabled', async () => {
    await registry.setEnabled('hello-world', true);
    assert.ok(registry.enabled.has('hello-world'));

    const table = await db.one<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hello_greetings'",
    );
    assert.ok(table, 'the plugin migration created its own table');

    const tracked = await db.one<{ name: string }>(
      "SELECT name FROM plugin_migrations WHERE plugin_slug = 'hello-world'",
    );
    assert.ok(tracked, 'tracked separately from the core ledger');

    const response = await app.fetch(new Request(url('/p/hello-world/status')));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { ok: boolean; greeting: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.greeting, 'Hello from a plugin');
  });

  it('enforces the route requirement itself rather than trusting the plugin', async () => {
    // The gate is applied by the host. A plugin that forgets to check would
    // otherwise be a hole in the board.
    const response = await app.fetch(new Request(url('/p/hello-world/secret'), { redirect: 'manual' }));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  });

  it('unmounts a plugin route the moment it is disabled', async () => {
    await registry.setEnabled('hello-world', false);
    const response = await app.fetch(new Request(url('/p/hello-world/status')));
    assert.equal(response.status, 404);
  });

  it('refuses a write through the read-only query helper', async () => {
    const { buildContext } = await import('../packages/plugin-host/src/context.ts');
    const bus = new HookBus(() => {});
    const ctx = buildContext(
      { manifest: { slug: 'probe', name: 'Probe', version: '0' }, setup: () => {} },
      { bus, routes: [], baseUrl: 'http://localhost', configCache: new Map() },
    );
    await assert.rejects(
      () => ctx.query('DELETE FROM posts'),
      /read-only/,
      'a plugin that needs to write declares a migration and owns its tables',
    );
    await assert.doesNotReject(() => ctx.query('SELECT 1'));
  });
});

describe('the hook bus fails safely', () => {
  it('keeps the previous value when a filter throws', async () => {
    const errors: string[] = [];
    const bus = new HookBus((slug) => errors.push(slug));
    bus.addFilter('good', 'post:render', (html) => `${html}<b>ok</b>`);
    bus.addFilter('bad', 'post:render', () => {
      throw new Error('boom');
    });
    const out = await bus.applyFilter('post:render', '<p>body</p>', {} as never);
    assert.equal(out, '<p>body</p><b>ok</b>', 'a broken plugin cannot blank a page');
    assert.deepEqual(errors, ['bad'], 'and the failure is attributed to it by name');
  });

  it('contributes nothing when a slot throws, and still renders the others', async () => {
    const bus = new HookBus(() => {});
    bus.addSlot('bad', 'layout:footer', () => {
      throw new Error('boom');
    });
    bus.addSlot('good', 'layout:footer', () => '<span>fine</span>');
    assert.equal(await bus.renderSlot('layout:footer', {} as never), '<span>fine</span>');
  });

  it('swallows a rejected action rather than failing the write that raised it', async () => {
    const errors: string[] = [];
    const bus = new HookBus((slug) => errors.push(slug));
    bus.addAction('bad', 'post:created', async () => {
      throw new Error('webhook down');
    });
    await assert.doesNotReject(() => bus.emit('post:created', {} as never));
    assert.deepEqual(errors, ['bad']);
  });

  it('orders slot output by weight, not by which handler finished first', async () => {
    const bus = new HookBus(() => {});
    bus.addSlot('slow', 'layout:footer', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'first';
    }, 1);
    bus.addSlot('fast', 'layout:footer', () => 'second', 2);
    assert.equal(await bus.renderSlot('layout:footer', {} as never), 'firstsecond');
  });

  it('drops everything a plugin registered when it is removed', async () => {
    const bus = new HookBus(() => {});
    bus.addFilter('p', 'post:render', (h) => `${h}!`);
    bus.addSlot('p', 'layout:footer', () => 'x');
    bus.removePlugin('p');
    assert.equal(await bus.applyFilter('post:render', 'body', {} as never), 'body');
    assert.equal(await bus.renderSlot('layout:footer', {} as never), '');
  });
});
