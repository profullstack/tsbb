import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tsbb-feed-sources-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3992';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');

const RSS = (
  items: { title: string; guid: string; link: string; body: string; date: string }[],
) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example &amp; Co. News</title>
    <link>https://example.com/</link>
    ${items
      .map(
        (item) => `<item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <guid isPermaLink="false">${item.guid}</guid>
      <pubDate>${item.date}</pubDate>
      <dc:creator>Jo Writer</dc:creator>
      <description><![CDATA[${item.body}]]></description>
    </item>`,
      )
      .join('\n')}
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>An Atom feed</title>
  <link rel="self" href="https://example.org/atom.xml"/>
  <link rel="alternate" href="https://example.org/"/>
  <entry>
    <id>tag:example.org,2026:one</id>
    <title type="html">First &lt;em&gt;entry&lt;/em&gt;</title>
    <link rel="replies" href="https://example.org/one/comments"/>
    <link rel="alternate" href="https://example.org/one"/>
    <published>2026-09-01T10:00:00Z</published>
    <author><name>Sam Author</name></author>
    <content type="html">&lt;p&gt;Hello from &lt;b&gt;Atom&lt;/b&gt;.&lt;/p&gt;</content>
  </entry>
</feed>`;

describe('feed sources', () => {
  let app: { fetch: (req: Request) => Response | Promise<Response> };
  let registry: Awaited<ReturnType<typeof boot>>['registry'];
  let server: Server;
  let feedUrl = '';
  let served = RSS([]);
  let servedStatus = 200;
  let hits = 0;
  let adminCookie = '';
  let memberCookie = '';
  let adminId = 0;
  let forumId = 0;
  let forumSlug = '';

  const url = (path: string) => `http://localhost:3992${path}`;
  const get = (path: string, cookie = adminCookie) =>
    app.fetch(new Request(url(path), { headers: cookie ? { cookie } : {}, redirect: 'manual' }));
  const post = (path: string, body: Record<string, string>, cookie = adminCookie) =>
    app.fetch(
      new Request(url(path), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(cookie ? { cookie } : {}),
        },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      }),
    );

  before(async () => {
    await seed({ quiet: true });
    await core.setSettings({ 'posts.floodSeconds': 0 });
    const booted = await boot({ listen: false });
    app = booted.app;
    registry = booted.registry;

    const admin = await core.createUser({
      username: 'root',
      email: 'root@example.com',
      isAdmin: true,
    });
    adminId = admin.id;
    adminCookie = `tsbb_session=${(await core.createSession(admin.id)).id}`;
    const member = await core.createUser({ username: 'mia', email: 'mia@example.com' });
    memberCookie = `tsbb_session=${(await core.createSession(member.id)).id}`;

    server = createServer((req, res) => {
      hits += 1;
      if (req.headers['if-none-match'] === '"v1"' && servedStatus === 304) {
        res.writeHead(304).end();
        return;
      }
      res
        .writeHead(servedStatus, { 'content-type': 'application/rss+xml', etag: '"v1"' })
        .end(served);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    feedUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/feed.xml`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.setDb(null);
  });

  it('parses RSS with CDATA, entities and a dc:creator', () => {
    const feed = core.parseFeed(
      RSS([
        {
          title: 'Hello &amp; welcome',
          guid: 'g1',
          link: 'https://example.com/1',
          body: '<p>First paragraph.</p><p>Second &amp; last.</p>',
          date: 'Mon, 01 Sep 2026 10:00:00 GMT',
        },
      ]),
    );
    assert.ok(feed);
    assert.equal(feed.kind, 'rss');
    assert.equal(feed.title, 'Example & Co. News');
    assert.equal(feed.items.length, 1);
    const [item] = feed.items;
    assert.equal(item?.title, 'Hello & welcome');
    assert.equal(item?.guid, 'g1');
    assert.equal(item?.author, 'Jo Writer');
    assert.equal(item?.publishedAt, Date.parse('2026-09-01T10:00:00Z'));
    assert.equal(core.htmlToText(item?.summary), 'First paragraph.\n\nSecond & last.');
  });

  it('parses Atom, taking the alternate link rather than the replies one', () => {
    const feed = core.parseFeed(ATOM);
    assert.ok(feed);
    assert.equal(feed.kind, 'atom');
    assert.equal(feed.title, 'An Atom feed');
    const [item] = feed.items;
    assert.equal(item?.link, 'https://example.org/one');
    assert.equal(item?.guid, 'tag:example.org,2026:one');
    assert.equal(item?.author, 'Sam Author');
    assert.equal(core.topicTitle(item!), 'First entry');
    assert.equal(core.htmlToText(item?.content), 'Hello from Atom.');
  });

  it('refuses something that is not a feed', () => {
    assert.equal(core.parseFeed('<!doctype html><html><body>Not a feed</body></html>'), null);
  });

  it('lets an administrator create a reply-only forum and attach a feed from the admin panel', async () => {
    const created = await post('/admin/forums', {
      name: 'Industry news',
      description: 'Stories from around the web.',
      kind: 'forum',
      parentId: '',
      position: '5',
      memberPosting: 'replies',
    });
    assert.equal(created.status, 303);
    const forum = await core.forumBySlug('industry-news');
    assert.ok(forum);
    assert.equal(forum.memberPosting, 'replies');
    forumId = forum.id;
    forumSlug = forum.slug;

    const rejected = await post(`/admin/forums/${forumId}/feeds`, {
      url: 'ftp://example.com/feed',
      postAs: 'root',
      intervalMinutes: '30',
      maxItems: '2',
    });
    assert.equal(rejected.status, 303);
    assert.ok(rejected.headers.get('location')?.includes('error='), 'a non-http URL is refused');

    const added = await post(`/admin/forums/${forumId}/feeds`, {
      url: feedUrl,
      postAs: 'root',
      intervalMinutes: '30',
      maxItems: '2',
    });
    assert.equal(added.status, 303);
    const sources = await core.listFeedSources(forumId);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.postAs, 'root');
    assert.equal(sources[0]?.maxItems, 2);
    assert.equal(sources[0]?.lastStatus, null, 'nothing fetched yet');

    const page = await (await get(`/admin/forums/${forumId}`)).text();
    assert.ok(page.includes(feedUrl), 'the feed is listed on the forum page');
    assert.ok(page.includes('Members reply only') || page.includes('value="replies" selected'));
  });

  it('polls a due feed, posts the newest items as topics, and skips older ones', async () => {
    served = RSS([
      {
        title: 'Newest',
        guid: 'n3',
        link: 'https://example.com/3',
        body: '<p>Third story.</p>',
        date: 'Wed, 03 Sep 2026 10:00:00 GMT',
      },
      {
        title: 'Middle',
        guid: 'n2',
        link: 'https://example.com/2',
        body: '<p>Second story.</p>',
        date: 'Tue, 02 Sep 2026 10:00:00 GMT',
      },
      {
        title: 'Oldest',
        guid: 'n1',
        link: 'https://example.com/1',
        body: '<p>First story.</p>',
        date: 'Mon, 01 Sep 2026 10:00:00 GMT',
      },
    ]);
    const result = await core.pollFeedSources({
      baseUrl: 'http://localhost:3992',
      bus: registry.bus,
    });
    assert.equal(result.fetched, 1);
    assert.equal(result.added, 2, 'maxItems caps the first fetch');
    assert.equal(result.errors, 0);

    const topics = await core.listTopics({ forumId });
    assert.deepEqual(
      topics.map((t) => t.title),
      ['Newest', 'Middle'],
      'the newest story is on top and the oldest was skipped',
    );
    assert.equal(topics[0]?.authorName, 'root');

    const posts = await core.listPosts({ topicId: topics[0]!.id, limit: 1 });
    assert.ok(posts[0]?.body.includes('Third story.'));
    assert.ok(
      posts[0]?.body.includes(
        'Read the original (By Jo Writer, via Example & Co. News): https://example.com/3',
      ),
    );

    const [source] = await core.listFeedSources(forumId);
    assert.equal(source?.lastStatus, 'ok');
    assert.equal(source?.title, 'Example & Co. News');
    assert.equal(source?.itemCount, 2);
    assert.ok(
      source?.nextFetchAt && source.nextFetchAt > Date.now(),
      'the next fetch is scheduled',
    );

    const seen = await db.all<{ guid: string; topic_id: number | null }>(
      'SELECT guid, topic_id FROM feed_items WHERE source_id = ? ORDER BY guid',
      [source!.id],
    );
    assert.deepEqual(
      seen.map((row) => [row.guid, row.topic_id !== null]),
      [
        ['n1', false],
        ['n2', true],
        ['n3', true],
      ],
      'the skipped item is remembered so it is never posted later',
    );
  });

  it('does not fetch again before it is due, and never posts the same item twice', async () => {
    const before = hits;
    const idle = await core.pollFeedSources({
      baseUrl: 'http://localhost:3992',
      bus: registry.bus,
    });
    assert.equal(idle.fetched, 0);
    assert.equal(hits, before, 'no request was made');

    // Fetch now ignores the schedule. The feed carries one new item and the
    // same three as before; only the new one becomes a topic.
    served = RSS([
      {
        title: 'Breaking',
        guid: 'n4',
        link: 'https://example.com/4',
        body: '<p>Fourth story.</p>',
        date: 'Thu, 04 Sep 2026 10:00:00 GMT',
      },
      {
        title: 'Newest',
        guid: 'n3',
        link: 'https://example.com/3',
        body: '<p>Third story.</p>',
        date: 'Wed, 03 Sep 2026 10:00:00 GMT',
      },
      {
        title: 'Middle',
        guid: 'n2',
        link: 'https://example.com/2',
        body: '<p>Second story.</p>',
        date: 'Tue, 02 Sep 2026 10:00:00 GMT',
      },
      {
        title: 'Oldest',
        guid: 'n1',
        link: 'https://example.com/1',
        body: '<p>First story.</p>',
        date: 'Mon, 01 Sep 2026 10:00:00 GMT',
      },
    ]);
    const [source] = await core.listFeedSources(forumId);
    const fetched = await post(`/admin/forums/${forumId}/feeds/${source!.id}/fetch`, {});
    assert.equal(fetched.status, 303);
    assert.ok(fetched.headers.get('location')?.includes(encodeURIComponent('1 new topic')));

    const topics = await core.listTopics({ forumId });
    assert.deepEqual(
      topics.map((t) => t.title),
      ['Breaking', 'Newest', 'Middle'],
    );
    assert.equal((await core.forumById(forumId))?.topicCount, 3);
  });

  it('honours a 304 and records an error without losing the schedule', async () => {
    servedStatus = 304;
    const [source] = await core.listFeedSources(forumId);
    const unchanged = await core.fetchFeedSource(source!, { baseUrl: 'http://localhost:3992' });
    assert.equal(unchanged.status, 'unchanged');
    assert.equal((await core.feedSourceById(source!.id))?.lastStatus, 'unchanged');

    servedStatus = 500;
    const failed = await core.fetchFeedSource(source!, { baseUrl: 'http://localhost:3992' });
    assert.equal(failed.status, 'error');
    const after = await core.feedSourceById(source!.id);
    assert.equal(after?.lastStatus, 'error');
    assert.ok(after?.lastError?.includes('500'));
    assert.ok(after?.nextFetchAt && after.nextFetchAt > Date.now());
    servedStatus = 200;

    const page = await (await get(`/admin/forums/${forumId}`)).text();
    assert.ok(page.includes('HTTP 500'), 'the admin page shows what went wrong');
  });

  it('keeps members to replies in a reply-only forum, while staff may still post', async () => {
    const memberPage = await (await get(`/f/${forumSlug}`, memberCookie)).text();
    assert.ok(!memberPage.includes(`/f/${forumSlug}/new`), 'no New topic button for a member');
    const memberNew = await get(`/f/${forumSlug}/new`, memberCookie);
    assert.equal(memberNew.status, 403);

    const memberApi = await app.fetch(
      new Request(url(`/api/v1/forums/${forumSlug}/topics`), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await core.mintToken({ userId: (await core.userByUsername('mia'))!.id, label: 't' })}`,
        },
        body: JSON.stringify({ title: 'Sneaking one in', body: 'Through the API instead.' }),
      }),
    );
    assert.equal(memberApi.status, 403, 'the API applies the same rule');

    const topics = await core.listTopics({ forumId });
    const handle = `${topics[0]!.slug}-${topics[0]!.id}`;
    const topicPage = await (await get(`/t/${handle}`, memberCookie)).text();
    assert.ok(topicPage.includes(`/t/${handle}/reply`), 'a member may reply');
    const replied = await post(
      `/t/${handle}/reply`,
      { body: 'Great story, thanks for sharing it here.' },
      memberCookie,
    );
    assert.equal(replied.status, 303);

    const adminPage = await (await get(`/f/${forumSlug}`)).text();
    assert.ok(adminPage.includes(`/f/${forumSlug}/new`), 'an administrator still sees New topic');

    // Read-only shuts replies too, but not for staff.
    await post(`/admin/forums/${forumId}`, {
      name: 'Industry news',
      description: '',
      position: '5',
      memberPosting: 'none',
    });
    assert.equal((await core.forumById(forumId))?.memberPosting, 'none');
    const readOnly = await (await get(`/t/${handle}`, memberCookie)).text();
    assert.ok(!readOnly.includes(`/t/${handle}/reply`), 'no reply button once read-only');
    const refused = await post(
      `/t/${handle}/reply`,
      { body: 'One more reply that should not land.' },
      memberCookie,
    );
    assert.equal(refused.status, 403);
    const staffReply = await post(`/t/${handle}/reply`, {
      body: 'Staff can still weigh in on a story.',
    });
    assert.equal(staffReply.status, 303);
    assert.equal(adminId > 0, true);
  });

  it('pauses, resumes and removes a feed, leaving its topics behind', async () => {
    const [source] = await core.listFeedSources(forumId);
    await post(`/admin/forums/${forumId}/feeds/${source!.id}/toggle`, {});
    assert.equal((await core.feedSourceById(source!.id))?.isEnabled, false);
    const paused = await core.pollFeedSources({ baseUrl: 'http://localhost:3992' });
    assert.equal(paused.fetched, 0, 'a paused feed is not polled');

    await post(`/admin/forums/${forumId}/feeds/${source!.id}/toggle`, {});
    const resumed = await core.feedSourceById(source!.id);
    assert.equal(resumed?.isEnabled, true);
    assert.ok(
      resumed?.nextFetchAt && resumed.nextFetchAt <= Date.now(),
      'resuming makes it due at once',
    );

    await post(`/admin/forums/${forumId}/feeds/${source!.id}/delete`, {});
    assert.equal(await core.feedSourceById(source!.id), null);
    assert.equal((await core.listTopics({ forumId })).length, 3, 'the topics stay');
  });

  it('stays out of the way when feed import is switched off board-wide', async () => {
    await core.setSettings({ 'feeds.importEnabled': false });
    await core.createFeedSource({ forumId, url: `${feedUrl}?again=1`, userId: adminId });
    const result = await core.pollFeedSources({ baseUrl: 'http://localhost:3992' });
    assert.equal(result.fetched, 0);
    await core.setSettings({ 'feeds.importEnabled': true });
  });
});
