import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * What a machine finds before it reads a page: robots.txt, the sitemap,
 * llms.txt, security.txt, the response headers, and the structured data in
 * the page head. None of it is visible to a person, which is why each piece
 * gets a test — a missing one has no symptom.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-discovery-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
// https, so the transport header is expected; the host still matches itself.
process.env.TSBB_BASE_URL = 'https://localhost:3997';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';
process.env.TSBB_MAIL_FROM = 'The Board <board@example.com>';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const core = await import('../packages/core/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
const get = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://localhost:3997${path}`, { redirect: 'manual', headers }));

/** The JSON-LD graphs in a page, or [] when there is no block. */
function structuredData(page: string): Record<string, unknown>[] {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page);
  if (!match?.[1]) return [];
  const parsed = JSON.parse(match[1]) as Record<string, unknown> | Record<string, unknown>[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

describe('discovery files and headers', () => {
  let topicHandle = '';

  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;

    await core.setSettings({
      'board.name': 'Testboard',
      // Long enough that the <title> keeps only the first clause.
      'board.tagline': 'A board for tests — forums, plugins, avatars, signatures and a terminal client',
      'posts.floodSeconds': 0,
    });
    const ann = await core.createUser({ username: 'ann', email: 'ann@example.com' });
    const forum = await core.forumBySlug('general');
    assert.ok(forum);
    const { topic } = await core.createTopic({
      forum,
      viewer: { user: ann, groupIds: [], isAdmin: true, isModerator: true, viaToken: false },
      title: 'Hello <world> & friends',
      body: 'The opening post, which is long enough to be accepted. It mentions </script> on purpose.',
    });
    topicHandle = `${topic.slug}-${topic.id}`;
  });
  after(() => db.setDb(null));

  it('answers robots.txt as text, naming the sitemap and the AI crawlers', async () => {
    const response = await get('/robots.txt');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
    const body = await response.text();
    assert.ok(body.includes('Sitemap: https://localhost:3997/sitemap.xml'));
    assert.ok(body.includes('Disallow: /admin'));
    assert.ok(body.includes('User-agent: GPTBot'));
    assert.ok(body.includes('User-agent: ClaudeBot'));
  });

  it('serves a sitemap index whose files list the public pages and topics', async () => {
    const index = await (await get('/sitemap.xml')).text();
    assert.ok(index.includes('<sitemapindex'));
    assert.ok(index.includes('https://localhost:3997/sitemaps/pages.xml'));
    const month = new Date().toISOString().slice(0, 7);
    assert.ok(index.includes(`/sitemaps/topics-${month}.xml`), 'this month has a topic, so it has a file');

    const pages = await (await get('/sitemaps/pages.xml')).text();
    for (const path of ['/', '/latest', '/about', '/docs/api', '/f/general']) {
      assert.ok(pages.includes(`<loc>https://localhost:3997${path}</loc>`), `pages.xml lists ${path}`);
    }

    const topics = await (await get(`/sitemaps/topics-${month}.xml`)).text();
    assert.ok(topics.includes(`<loc>https://localhost:3997/t/${topicHandle}</loc>`));
    assert.ok(topics.includes('<lastmod>'));

    assert.equal((await get('/sitemaps/topics-1999-01.xml')).status, 404, 'an empty month is not a file');
    assert.equal((await get('/sitemaps/anything.xml')).status, 404);
  });

  it('describes the board for language models', async () => {
    const response = await get('/llms.txt');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/markdown/);
    const body = await response.text();
    assert.ok(body.startsWith('# Testboard\n'));
    assert.ok(body.includes('> A board for tests'));
    assert.ok(body.includes('](https://localhost:3997/f/general)'), 'a public forum is listed');
    assert.ok(body.includes('](https://localhost:3997/docs/mcp)'));
    assert.ok(body.includes('/api/v1/openapi.json'));

    const full = await (await get('/llms-full.txt')).text();
    assert.ok(full.includes('# Testboard'));
    assert.ok(full.includes('/docs/mcp'), 'the guides are in it, with links rewritten to the site');

    const skill = await (await get('/skill.md')).text();
    assert.ok(skill.startsWith('---\nname: testboard\n'));
    assert.ok(skill.includes('https://localhost:3997/api/mcp'));
  });

  it('publishes a security contact taken from the sending address', async () => {
    const body = await (await get('/.well-known/security.txt')).text();
    assert.ok(body.includes('Contact: mailto:board@example.com'), 'the address, not the display name');
    assert.match(body, /^Expires: \d{4}-\d{2}-\d{2}T/m);
    assert.ok(body.includes('Canonical: https://localhost:3997/.well-known/security.txt'));

    // A configured address wins over the sending one.
    await core.setSettings({ 'board.contactEmail': 'hello@example.org' });
    assert.ok((await (await get('/.well-known/security.txt')).text()).includes('mailto:hello@example.org'));
    await core.setSettings({ 'board.contactEmail': '' });
  });

  it('redirects a trailing slash to the one address a page has', async () => {
    const docs = await get('/docs/');
    assert.equal(docs.status, 301);
    assert.equal(docs.headers.get('location'), '/docs');

    const members = await get('/members/?sort=new');
    assert.equal(members.status, 301);
    assert.equal(members.headers.get('location'), '/members?sort=new', 'the query survives');

    assert.equal((await get('/')).status, 200, 'the root is not a trailing slash');
  });

  it('sends the transport, framing, feature and cache headers', async () => {
    const response = await get('/');
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
    assert.match(response.headers.get('vary') ?? '', /Cookie/);

    // A member's page is theirs, and must not be held anywhere shared.
    const ann = await core.userByEmail('ann@example.com');
    assert.ok(ann);
    const session = await core.createSession(ann.id);
    const personal = await get('/', { cookie: `tsbb_session=${session.id}` });
    assert.equal(personal.headers.get('cache-control'), 'private, no-cache');

    // Not only pages: the stylesheet link is often the first response a
    // browser sees, and it must carry the transport rule too.
    const css = await get('/robots.txt');
    assert.ok(css.headers.get('strict-transport-security'));
  });

  it('gives the front page one heading, a real title, and site structured data', async () => {
    const page = await (await get('/')).text();
    assert.equal((page.match(/<h1[\s>]/g) ?? []).length, 1, 'exactly one <h1>');
    assert.ok(page.includes('<h1 class="hero-title">Testboard</h1>'));
    assert.ok(page.includes('<title>Testboard · A board for tests</title>'), 'the tagline\'s first clause');
    assert.ok(page.includes('property="og:image" content="https://localhost:3997/icons/icon-512.png"'));
    assert.ok(page.includes('name="twitter:title"'));
    assert.ok(page.includes('href="/signup"'), 'a guest is offered the way in');

    const graphs = structuredData(page);
    const site = graphs.find((g) => g['@type'] === 'WebSite');
    assert.ok(site, 'a WebSite graph');
    assert.equal(site.name, 'Testboard');
    assert.equal(site.url, 'https://localhost:3997');
    assert.equal((site.publisher as { name: string }).name, 'Profullstack, Inc.');
  });

  it('marks a thread up as a discussion, with hostile text kept inert', async () => {
    const page = await (await get(`/t/${topicHandle}`)).text();
    const graphs = structuredData(page);
    const thread = graphs.find((g) => g['@type'] === 'DiscussionForumPosting');
    assert.ok(thread, 'a DiscussionForumPosting graph');
    assert.equal(thread.headline, 'Hello <world> & friends');
    assert.equal(thread.url, `https://localhost:3997/t/${topicHandle}`);
    assert.equal((thread.author as { name: string }).name, 'ann');
    assert.ok(String(thread.text).includes('</script>'), 'the parsed JSON has the text back verbatim');

    // ...but the raw block never contained a closing tag for the tokenizer.
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    assert.ok(!block.includes('</script>'));
    assert.ok(!block.includes('<world>'));
  });

  it('has an About page that says what the board is and how to join', async () => {
    const response = await get('/about');
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.ok(page.includes('<h1 class="page-title">About Testboard</h1>'));
    assert.ok(page.includes('<h2>How do I join?</h2>'));
    assert.ok(page.includes('href="/signup"'));
    assert.ok(page.includes('href="/f/general"'));
    assert.ok(page.includes('href="/docs/mcp"'));
    assert.ok(page.includes('href="/about">About</a>'), 'and the footer links to it');
  });
});
