import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-mount-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3994/bbs';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const { mountAt } = await import('../apps/server/src/mount.ts');
const { boardUrl, basePathOf } = await import('../packages/plugin-api/src/index.ts');
const db = await import('../packages/db/src/index.ts');

let fetch: (req: Request) => Response | Promise<Response>;
const get = (p: string) => fetch(new Request(`http://localhost:3994${p}`, { redirect: 'manual' }));

describe('a board mounted under a path', () => {
  before(async () => {
    await seed({ quiet: true });
    const { app, baseUrl } = await boot({ listen: false });
    fetch = mountAt(basePathOf(baseUrl), app.fetch);
  });
  after(() => db.setDb(null));

  it('builds absolute URLs that keep the prefix', () => {
    assert.equal(boardUrl('/t/1', 'https://c0upons.com/bbs'), 'https://c0upons.com/bbs/t/1');
    assert.equal(boardUrl('/t/1', 'https://c0upons.com/bbs/'), 'https://c0upons.com/bbs/t/1');
    assert.equal(boardUrl('/t/1?x=1', 'https://tsbb.dev'), 'https://tsbb.dev/t/1?x=1');
    assert.equal(boardUrl('https://example.com/a', 'https://tsbb.dev/bbs'), 'https://example.com/a');
    assert.equal(basePathOf('https://tsbb.dev'), '');
    assert.equal(basePathOf('https://c0upons.com/bbs/'), '/bbs');
  });

  it('serves the index with every root-relative link prefixed', async () => {
    const response = await get('/bbs');
    assert.equal(response.status, 200);
    const page = await response.text();
    const links = [...page.matchAll(/\s(?:href|src|action)="(\/[^"]*)"/g)].map((m) => m[1]);
    assert.ok(links.length > 5, 'the page has links');
    const stray = links.filter((l) => l !== undefined && !l.startsWith('/bbs/') && l !== '/bbs' && !l.startsWith('//'));
    assert.deepEqual(stray, []);
    assert.match(page, /rel="canonical" href="http:\/\/localhost:3994\/bbs\//);
  });

  it('serves the stylesheet the page links to', async () => {
    const page = await (await get('/bbs')).text();
    const css = /href="(\/bbs\/assets\/app\.[0-9a-f]+\.css)"/.exec(page)?.[1];
    assert.ok(css);
    const response = await get(css);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/css/);
  });

  it('redirects paths outside the prefix into it, but answers /healthz', async () => {
    const response = await get('/latest?page=2');
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), '/bbs/latest?page=2');
    assert.equal((await get('/healthz')).status, 200);
  });

  it('prefixes the manifest and the service worker', async () => {
    const manifest = (await (await get('/bbs/manifest.webmanifest')).json()) as { start_url: string; scope: string };
    assert.equal(manifest.start_url, '/bbs/');
    assert.equal(manifest.scope, '/bbs/');

    const sw = await get('/bbs/sw.js');
    assert.equal(sw.headers.get('service-worker-allowed'), '/bbs/');
    const source = await sw.text();
    assert.ok(source.includes("startsWith('/bbs/api/')"));
    assert.ok(source.includes("'/bbs/offline'"));
    assert.match(await (await get('/bbs/register-sw.js')).text(), /register\('\/bbs\/sw\.js'\)/);
  });

  it('prefixes redirects and cookie paths from the app', async () => {
    const stub = mountAt('/bbs', async () => {
      const headers = new Headers({ location: '/login' });
      headers.append('set-cookie', 'tsbb_session=abc; Path=/; HttpOnly');
      headers.append('set-cookie', 'other=1; Path=/settings');
      return new Response(null, { status: 302, headers });
    });
    const response = await stub(new Request('http://localhost:3994/bbs/whatever'));
    assert.equal(response.headers.get('location'), '/bbs/login');
    assert.deepEqual(response.headers.getSetCookie(), [
      'tsbb_session=abc; Path=/bbs; HttpOnly',
      'other=1; Path=/bbs/settings',
    ]);
  });
});
