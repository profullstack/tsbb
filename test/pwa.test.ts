import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-pwa-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3995';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { stylesheet } = await import('../packages/ui/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
const url = (p: string) => `http://localhost:3995${p}`;
const get = (p: string) => app.fetch(new Request(url(p), { redirect: 'manual' }));

describe('the PWA', () => {
  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
  });
  after(() => db.setDb(null));

  it('serves an installable manifest', async () => {
    const response = await get('/manifest.webmanifest');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/manifest\+json/);
    const manifest = (await response.json()) as {
      name: string; start_url: string; display: string;
      icons: { sizes: string; purpose: string }[];
    };
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    // The three things a browser actually requires to offer an install prompt.
    assert.ok(manifest.name);
    assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'a maskable icon, or launchers crop the mark');
  });

  it('ties the service worker cache name to the shell it caches', async () => {
    // A hard-coded version is how a fix ships that no returning reader ever
    // sees: their browser keeps serving the old precache because the cache name
    // never moved. It is derived, so it cannot be forgotten.
    const source = await (await get('/sw.js')).text();
    const version = /VERSION = "([^"]+)"/.exec(source)?.[1];
    assert.ok(version, 'the worker names a version');

    const before = version;
    // The stylesheet hash is one of its inputs, so a CSS change moves it.
    assert.ok(source.includes(stylesheet().hash), 'the precached stylesheet is the current one');
    assert.notEqual(before, stylesheet().hash, 'and the cache name is not merely the hash');
  });

  it('is network-first for pages and cache-first only for immutable assets', async () => {
    const source = await (await get('/sw.js')).text();
    // On a forum, serving a stale thread is worse than serving a spinner.
    assert.ok(source.includes("request.mode === 'navigate'"));
    assert.ok(/fetch\(request\)[\s\S]{0,400}catch\(\)? *\(\)? *=>[\s\S]{0,200}caches\.match/.test(source.replace(/\s+/g, ' ')) ||
      source.includes(".catch(() => caches.match(request)"), 'pages fall back to cache, not lead with it');
    assert.ok(source.includes("url.pathname.startsWith('/assets/')"), 'hashed assets are cache-first');
  });

  it('never caches a per-viewer or write path', async () => {
    const source = await (await get('/sw.js')).text();
    for (const path of ['/api/', '/auth/', '/notifications', '/settings', '/admin']) {
      assert.ok(source.includes(`'${path}'`), `${path} is excluded from the worker`);
    }
  });

  it('drops every previous cache when it activates', async () => {
    const source = await (await get('/sw.js')).text();
    assert.ok(source.includes('caches.delete'), 'or the old shell survives forever');
    assert.ok(source.includes('clients.claim'));
  });

  it('registers the worker from a file, so the CSP keeps no inline script', async () => {
    const page = await get('/');
    const html = await page.text();
    assert.ok(html.includes('src="/register-sw.js"'));
    assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline script anywhere in the document');

    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes('unsafe-inline'), 'the worker cost no relaxation of the policy');
    assert.match(csp, /worker-src 'self'/);
  });

  it('serves its icons and refuses anything else under /icons', async () => {
    for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'favicon.ico']) {
      const response = await get(`/icons/${name}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('cache-control') ?? '', /max-age/);
    }
    for (const name of ['evil.png', '../../etc/passwd', 'sw.js']) {
      assert.equal((await get(`/icons/${name}`)).status, 404, name);
    }
  });

  it('has an offline page wearing the board’s own chrome', async () => {
    const response = await get('/offline');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('You are offline'));
    // Not a bare static file: it carries the header, so it does not read as a crash.
    assert.ok(html.includes('site-header'));
  });

  it('gives the browser chrome a colour for each theme', async () => {
    const html = await (await get('/')).text();
    assert.ok(html.includes('media="(prefers-color-scheme: light)"'));
    assert.ok(html.includes('media="(prefers-color-scheme: dark)"'));
  });
});
