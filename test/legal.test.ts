import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * /privacy and /terms: real server-rendered pages, linked from the footer,
 * with no ads on them. An app directory reviewer reads them with curl, so a
 * page that only exists after a script runs does not count.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-legal-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'https://localhost:3996';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';
process.env.TSBB_MAIL_FROM = 'The Board <board@example.com>';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const core = await import('../packages/core/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
let registry: Awaited<ReturnType<typeof boot>>['registry'];
const get = (path: string) => app.fetch(new Request(`https://localhost:3996${path}`, { redirect: 'manual' }));

describe('legal pages', () => {
  before(async () => {
    await seed({ quiet: true });
    const booted = await boot({ listen: false });
    app = booted.app;
    registry = booted.registry;
    await core.setSettings({ 'board.name': 'Testboard' });
    // Ads on everywhere they can be, so their absence on the legal pages means something.
    await db.run("UPDATE plugins SET enabled = 1, config = ? WHERE slug = 'crawlproof-ads'", [
      JSON.stringify({ slotId: 'slot-abc', 'placement.header': true, 'placement.footer': true }),
    ]);
    await registry.reload();
  });
  after(() => db.setDb(null));

  for (const [path, heading] of [
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Service'],
  ] as const) {
    it(`serves ${path} as a full page headed "${heading}"`, async () => {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      const page = await response.text();
      assert.match(page, new RegExp(`<title>${heading}[^<]*</title>`));
      assert.match(page, new RegExp(`<h1 class="page-title">${heading}</h1>`));
      assert.ok(page.includes('Effective date: November 11, 2026'));
      assert.ok(page.includes('Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA'));
      assert.ok(page.includes('support@profullstack.com'));
      assert.ok(page.includes('https://localhost:3996/api/mcp'), 'names the MCP endpoint');
      assert.ok(!page.includes('crawlproof.com/api/ads/frame'), 'no ad units');
    });
  }

  it('has the required MCP section and describes only what this install uses', async () => {
    const page = await (await get('/privacy')).text();
    assert.ok(page.includes('AI agents and MCP'));
    assert.ok(page.includes('MCP and API requests are logged'));
    assert.ok(page.includes('CrawlProof'), 'the ads plugin is on, so it is named');
    assert.ok(!page.includes('Resend'), 'the console transport sends nothing through Resend');
    assert.ok(!page.includes('CoinPay'), 'CoinPay sign-in is not configured');
  });

  it('writes no em or en dashes into either page body', async () => {
    for (const path of ['/privacy', '/terms']) {
      const page = await (await get(path)).text();
      const main = /<main[\s\S]*<\/main>/.exec(page)?.[0] ?? '';
      assert.ok(main.length > 0);
      assert.ok(!/[–—]/.test(main), `${path} has a dash`);
    }
  });

  it('links both from the footer of every page', async () => {
    const page = await (await get('/')).text();
    assert.ok(page.includes('href="/privacy"'));
    assert.ok(page.includes('href="/terms"'));
    assert.ok(page.includes('crawlproof.com/api/ads/frame'), 'while ordinary pages keep their ads');
  });

  it('lists both in the sitemap', async () => {
    const body = await (await get('/sitemaps/pages.xml')).text();
    assert.ok(body.includes('https://localhost:3996/privacy'));
    assert.ok(body.includes('https://localhost:3996/terms'));
  });
});
