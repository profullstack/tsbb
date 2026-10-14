import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-paper-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3994';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { SKINS, LIGHT_ONLY_SKINS, SKIN_THEME_COLOR, isSkin, stylesheet } = await import('../packages/ui/src/index.ts');
const { setSettings } = await import('../packages/core/src/index.ts');
const { siteLinks } = await import('../apps/server/src/context.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
const get = (p: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost:3994${p}`, { headers }));

const W3BS_NAV = [
  'Packages | https://w3bs.org/packages',
  'Standards | https://w3bs.org/specs',
  'Community | {forums}',
  'Start building ↗ | https://w3bs.org/developers | button',
].join('\n');

describe('the paper skin', () => {
  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
  });
  after(() => db.setDb(null));

  it('is a light-only skin an administrator can pick', () => {
    assert.ok(SKINS.includes('paper'));
    assert.ok(isSkin('paper'));
    assert.ok(LIGHT_ONLY_SKINS.includes('paper'));
    assert.deepEqual(SKIN_THEME_COLOR.paper, { light: '#f6f4ed', dark: '#f6f4ed' });
  });

  it('layers over the modern sheet with system fonts only', () => {
    const modern = stylesheet('modern').css;
    const paper = stylesheet('paper').css;
    assert.ok(paper.startsWith(modern.slice(0, 200)), 'the modern sheet comes first');
    assert.notEqual(stylesheet('paper').hash, stylesheet('modern').hash);
    const layer = paper.slice(modern.length);
    assert.doesNotMatch(layer, /@font-face/, 'no web font');
    assert.match(layer, /Georgia/);
    assert.match(layer, /--paper: #f6f4ed/);
    // Fills follow the accent as chosen; without one the skin has its own.
    assert.match(layer, /--paper-accent: var\(--brand, var\(--primary\)\)/);
  });

  it('reads a renamed {forums} slot and a call-to-action line', () => {
    const parsed = siteLinks({ 'board.navLinks': W3BS_NAV });
    assert.deepEqual(parsed.items.map((i) => i.label), ['Packages', 'Standards']);
    assert.equal(parsed.forumsOnly, true);
    assert.equal(parsed.forumsLabel, 'Community');
    assert.deepEqual(parsed.actions.map((i) => [i.label, i.href]), [['Start building ↗', 'https://w3bs.org/developers']]);
    // A bare token still works, and keeps the board's own word.
    assert.equal(siteLinks({ 'board.navLinks': '{forums}' }).forumsLabel, null);
    // A button is still held to absolute http(s) URLs.
    assert.equal(siteLinks({ 'board.navLinks': 'Go | javascript:alert(1) | button' }).actions.length, 0);
  });

  it('renders the host site header and footer, light for everyone', async () => {
    await setSettings({
      'board.skin': 'paper',
      'board.name': 'w3bs',
      'board.logoUrl': 'https://w3bs.org/assets/mark.svg',
      'board.logoHref': 'https://w3bs.org/mission',
      'board.navLinks': W3BS_NAV,
    });
    // A dark cookie does not darken a paper board.
    const page = await (await get('/latest', { cookie: 'tsbb_theme=dark' })).text();
    assert.match(page, /<html lang="en" data-theme="light">/);
    assert.doesNotMatch(page, /action="\/prefs\/theme"/, 'no theme toggle');

    const nav = /<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? '';
    const links = [...nav.matchAll(/class="([^"]+)" href="[^"]*"\s*>\s*([A-Za-z]+)\s*<\/a/g)].map((m) => [m[2], m[1]]);
    // The board's single entry is the current section on every board page.
    assert.deepEqual(links, [
      ['Packages', 'nav-link'],
      ['Standards', 'nav-link'],
      ['Community', 'nav-link active'],
    ]);
    assert.match(page, /class="btn btn-outline btn-sm site-action" href="https:\/\/w3bs.org\/developers"/);
    assert.match(page, /Start building <span class="site-action-arrow" aria-hidden="true">↗<\/span>/);
    assert.match(page, /<img class="brand-logo" src="https:\/\/w3bs.org\/assets\/mark.svg" alt="w3bs" \/>\s*<span class="brand-name" aria-hidden="true">w3bs<\/span>/);
    assert.match(page, /<div class="container footer-columns">/);
    assert.match(page, /<span class="footer-heading">w3bs.org<\/span>/);
    assert.match(page, /href="\/search">Search<\/a>/);

    // Other skins keep their theme toggle and hide the columns.
    await setSettings({ 'board.skin': 'modern' });
    const modern = await (await get('/latest', { cookie: 'tsbb_theme=dark' })).text();
    assert.match(modern, /data-theme="dark"/);
    assert.match(modern, /action="\/prefs\/theme"/);
    assert.match(stylesheet('modern').css, /\.footer-columns \{ display: none; \}/);
    await setSettings({ 'board.navLinks': '', 'board.logoUrl': '', 'board.logoHref': '/' });
  });

  it('lays the sign-in page out with a class, not a refused style attribute', async () => {
    const page = await (await get('/login')).text();
    assert.match(page, /<div class="auth-page">/);
    assert.doesNotMatch(page, /style="max-width:26rem/);
  });
});
