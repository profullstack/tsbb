import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-feeds-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3994';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
let handle = '';
const url = (p: string) => `http://localhost:3994${p}`;
const get = (p: string) => app.fetch(new Request(url(p), { redirect: 'manual' }));

describe('feeds and avatars in lists', () => {
  before(async () => {
    await seed({ quiet: true });
    await core.setSettings({ 'posts.floodSeconds': 0 });
    app = (await boot({ listen: false })).app;

    const ann = await core.createUser({ username: 'ann', email: 'ann@example.com' });
    const forum = await core.forumBySlug('general');
    const viewer = { user: ann, groupIds: [], isAdmin: false, isModerator: false, viaToken: false };
    const { topic } = await core.createTopic({
      forum: forum!,
      viewer,
      title: 'A topic worth subscribing to',
      body: 'The opening post, long enough to make a summary out of.',
    });
    await core.reply({ topic, viewer, body: 'A reply, so the thread feed has more than one item.' });
    handle = `${topic.slug}-${topic.id}`;
  });

  after(() => db.setDb(null));

  it('shows a real avatar in a topic list, never a letter', async () => {
    const html = await (await get('/latest')).text();
    assert.ok(!html.includes('avatar-fallback'), 'no letter placeholders remain');
    // The identicon is generated and inlined, so a list needs no extra request.
    assert.ok(html.includes('class="avatar avatar-sm"'));
    assert.ok(html.includes('src="data:image/svg+xml;base64,'));
  });

  it('serves every feed, and each declares itself', async () => {
    const feeds = [
      '/feed.xml',
      '/latest/feed.xml',
      '/f/general/feed.xml',
      `/t/${handle}/feed.xml`,
      '/u/ann/feed.xml',
      '/search/feed.xml?q=topic',
    ];
    for (const path of feeds) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') ?? '', /application\/rss\+xml/, path);
      const body = await response.text();
      assert.ok(body.startsWith('<?xml version="1.0"'), path);
      // A self link is what lets a reader re-find the feed it is holding.
      assert.ok(body.includes('<atom:link'), `${path} has no self link`);
      assert.ok(body.includes('<channel>') && body.includes('</rss>'), path);
    }
  });

  it('gives a thread its replies, in order', async () => {
    const body = await (await get(`/t/${handle}/feed.xml`)).text();
    const titles = [...body.matchAll(/<item>[\s\S]*?<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    assert.equal(titles.length, 2, 'the opening post and the reply');
    assert.ok(titles[1]?.startsWith('Re: '), 'replies are marked as such');
  });

  it('escapes everything it puts in a feed', async () => {
    const forum = await core.forumBySlug('introductions');
    const ann = await core.userByUsername('ann');
    await core.createTopic({
      forum: forum!,
      viewer: { user: ann!, groupIds: [], isAdmin: true, isModerator: true, viaToken: false },
      title: 'Tom & Jerry <script>alert(1)</script>',
      body: 'A body with <b>markup</b> & an ampersand.',
    });
    const body = await (await get('/f/introductions/feed.xml')).text();
    assert.ok(body.includes('Tom &amp; Jerry &lt;script&gt;'), 'escaped, not stripped');
    assert.ok(!body.includes('<script>'), 'no live tag reached the document');
  });

  it('offers every feed as one OPML file, as a download', async () => {
    const response = await get('/feeds.opml');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /opml/);
    // Named, or a browser renders the XML instead of saving it.
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename=/);

    const body = await response.text();
    assert.ok(body.startsWith('<?xml version="1.0"'));
    assert.ok(body.includes('<opml version="2.0">'));
    // Every forum the viewer can see, plus the two board-wide feeds.
    for (const slug of ['general', 'announcements', 'introductions', 'help', 'bugs']) {
      assert.ok(body.includes(`/f/${slug}/feed.xml`), `${slug} missing from the OPML`);
    }
    assert.ok(body.includes('/feed.xml'));
    assert.ok(body.includes('/latest/feed.xml'));
    // Absolute URLs, or an imported OPML points at nothing.
    assert.ok(!/xmlUrl="\//.test(body), 'feed URLs are absolute');
  });

  it('lists the feeds on a page, with the OPML as an option', async () => {
    const html = await (await get('/feeds')).text();
    assert.equal((await get('/feeds')).status, 200);
    assert.ok(html.includes('/feeds.opml'));
    assert.ok(html.includes('download'), 'offered as a download, not forced');
    assert.ok(html.includes('/f/general/feed.xml'));
  });

  it('points each page at its own feed, not the whole board', async () => {
    const pairs: [string, string][] = [
      ['/latest', '/latest/feed.xml'],
      ['/u/ann', '/u/ann/feed.xml'],
      [`/t/${handle}`, `/t/${handle}/feed.xml`],
      ['/search?q=topic', '/search/feed.xml?q=topic'],
    ];
    for (const [page, feed] of pairs) {
      const html = await (await get(page)).text();
      assert.ok(html.includes(`href="${feed}"`), `${page} should advertise ${feed}`);
    }
  });
});
