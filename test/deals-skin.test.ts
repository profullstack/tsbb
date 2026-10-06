import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-deals-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3993';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { SKINS, isSkin, stylesheet, brandCss, fontFile } = await import('../packages/ui/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
const get = (p: string) => app.fetch(new Request(`http://localhost:3993${p}`));

describe('the deals skin', () => {
  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
  });
  after(() => db.setDb(null));

  it('is a skin an administrator can pick', () => {
    assert.ok(SKINS.includes('deals'));
    assert.ok(isSkin('deals'));
  });

  it('layers over the modern sheet and self-hosts Geist', () => {
    const modern = stylesheet('modern').css;
    const deals = stylesheet('deals').css;
    assert.ok(deals.startsWith(modern.slice(0, 200)), 'the modern sheet comes first');
    assert.match(deals, /font-family: 'Geist'/);
    assert.match(deals, /url\('\/assets\/fonts\/geist\.woff2'\)/);
    assert.notEqual(stylesheet('deals').hash, stylesheet('modern').hash);
  });

  it('fills with the accent exactly as chosen, white text on a mid-tone one', () => {
    const css = brandCss('#f97316');
    const brand = /--brand: oklch\(([\d.]+) /.exec(css)?.[1];
    assert.ok(brand, 'emits --brand');
    // #f97316 is ~0.70 lightness; --primary is clamped to 0.62 for text on
    // white, and --brand must NOT be.
    assert.ok(Number(brand) > 0.68, `--brand kept its lightness (${brand})`);
    assert.match(css, /--brand-foreground: oklch\(1 0 0\)/);
    // A very light accent gets dark text instead.
    assert.doesNotMatch(brandCss('#fde68a'), /--brand-foreground: oklch\(1 0 0\)/);
  });

  it('serves the font, and nothing else from the font route', async () => {
    assert.ok(fontFile('geist.woff2')?.length);
    const font = await get('/assets/fonts/geist.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.match(font.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await get('/assets/fonts/..%2Fpackage.json')).status, 404);
    assert.equal((await get('/assets/fonts/other.woff2')).status, 404);
  });
});
