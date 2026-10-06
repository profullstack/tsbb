import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-openemoji-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3997';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { buildSet, renderEmoji, shortcodeFor, emojiKey } = await import('../plugins/openemoji/src/render.ts');

const index = JSON.parse(readFileSync(new URL('../plugins/openemoji/assets/index.json', import.meta.url), 'utf8'));
const set = buildSet(index);
const render = (html: string, shortcodes = true) => renderEmoji(html, set, { base: '/e', shortcodes });

describe('OpenEmoji rendering', () => {
  it('draws an emoji as an image with the character as alt', () => {
    assert.equal(
      render('<p>ship it 🚀</p>'),
      '<p>ship it <img class="oe" src="/e/64/1f680.webp" alt="🚀" title=":rocket:" width="20" height="20" loading="lazy" decoding="async"></p>',
    );
  });

  it('matches text with or without U+FE0F, and keeps ZWJ sequences whole', () => {
    assert.ok(render('❤').includes('/64/2764-fe0f.webp'));
    const zwj = render('👩‍💻');
    assert.equal(zwj.match(/<img/g)?.length, 1);
    assert.ok(zwj.includes('/64/1f469-200d-1f4bb.webp'));
  });

  it('turns shortcodes and familiar aliases into emoji, and leaves unknown ones alone', () => {
    assert.ok(render(':rocket:').includes('alt="🚀"'));
    assert.ok(render(':+1:').includes('alt="👍"'));
    assert.ok(render(':heart:').includes('alt="❤️"'));
    assert.equal(render('at 12:30:45 :not_an_emoji:'), 'at 12:30:45 :not_an_emoji:');
    assert.equal(render(':rocket:', false), ':rocket:');
  });

  it('names flags and accented names as plain shortcodes', () => {
    assert.equal(shortcodeFor('flag: Côte d’Ivoire'), 'flag_cote_d_ivoire');
    assert.equal(shortcodeFor('grinning face'), 'grinning_face');
  });

  it('never touches attributes or code', () => {
    const link = '<a href="https://example.com/🚀:rocket:">go 🚀</a>';
    const out = render(link);
    assert.ok(out.startsWith('<a href="https://example.com/🚀:rocket:">go <img'));
    assert.equal(render('<pre><code>🚀 :rocket:</code></pre>'), '<pre><code>🚀 :rocket:</code></pre>');
    assert.equal(render('<code>:rocket:</code> 🚀').match(/<img/g)?.length, 1);
  });

  it('leaves emoji without artwork (skin tones) as text', () => {
    assert.equal(render('👍🏽'), '👍🏽');
  });

  it('keys an emoji by its codepoints', () => {
    assert.equal(emojiKey('😀'), '1f600');
    assert.ok(set.keys.size > 2000);
  });
});

describe('the openemoji plugin on a board', () => {
  let app: { fetch: (req: Request) => Response | Promise<Response> };
  let cookie = '';
  const url = (path: string) => `http://localhost:3997${path}`;
  const get = (path: string) => app.fetch(new Request(url(path), { headers: cookie ? { cookie } : {} }));

  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
    const user = await core.createUser({ username: 'emojifan', email: 'e@example.com', isAdmin: true });
    cookie = `tsbb_session=${(await core.createSession(user.id)).id}`;
  });

  after(() => db.setDb(null));

  it('ships enabled', async () => {
    const page = await (await get('/')).text();
    assert.ok(page.includes('/p/openemoji/a/openemoji.css'), 'the stylesheet is linked on every page');
  });

  it('puts the picker and its script in the composer', async () => {
    const page = await (await get('/f/introductions/new')).text();
    assert.ok(page.includes('class="oe-picker"'));
    assert.ok(page.includes('<script src="/p/openemoji/a/picker.js" defer></script>'));
    assert.ok(page.includes('data-char="🚀"'), 'popular emoji work before any script runs');
    assert.ok(!/<[^>]+ style="/.test(page.slice(page.indexOf('oe-picker'), page.indexOf('</details>'))), 'no inline styles: the CSP refuses them');
  });

  it('draws emoji in a posted topic', async () => {
    const user = await core.userByUsername('emojifan');
    const { topic } = await core.createTopic({
      forum: (await core.forumBySlug('introductions'))!,
      viewer: { user: user!, groupIds: [], isAdmin: true, isModerator: true, viaToken: false },
      title: 'Hello from the emoji test',
      body: 'Shipped it 🚀 and :tada:\n\n`:rocket:` stays code.',
    });
    const page = await (await get(`/t/${topic.slug}-${topic.id}`)).text();
    assert.ok(page.includes('src="/p/openemoji/a/64/1f680.webp" alt="🚀"'));
    assert.ok(page.includes('alt="🎉"'));
    assert.ok(page.includes('<code>:rocket:</code>'));
  });

  it('serves its files, and nothing else', async () => {
    const webp = await get('/p/openemoji/a/64/1f680.webp');
    assert.equal(webp.status, 200);
    assert.equal(webp.headers.get('content-type'), 'image/webp');
    assert.match(webp.headers.get('cache-control') ?? '', /max-age=604800/);

    for (const [file, type] of [
      ['picker.js', 'text/javascript'],
      ['openemoji.css', 'text/css'],
      ['index.json', 'application/json'],
      ['sprite.svg', 'image/svg+xml'],
    ] as const) {
      const res = await get(`/p/openemoji/a/${file}`);
      assert.equal(res.status, 200, file);
      assert.ok(res.headers.get('content-type')?.startsWith(type), file);
    }

    for (const bad of ['64/zzzz.webp', '64/1f680.png', '../src/index.ts', '%2e%2e/src/index.ts', '64/%E0%A4%A.webp', '']) {
      // 404 from the allowlist, or the board's trailing-slash redirect for the
      // bare prefix; a `..` never survives URL normalisation in the first place.
      const res = await get(`/p/openemoji/a/${bad}`);
      assert.ok([301, 404].includes(res.status), `${bad}: ${res.status}`);
      assert.ok(!(await res.text()).includes('definePlugin'), `${bad} leaked source`);
    }
  });

  it('lists every shortcode', async () => {
    const page = await (await get('/p/openemoji/list')).text();
    assert.ok(page.includes(':rocket:'));
    assert.ok(page.includes(':flag_united_states:'));
  });
});
