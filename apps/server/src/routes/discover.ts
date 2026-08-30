import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import {
  ancestryOf,
  breadcrumb,
  forumBySlug,
  forumTree,
  listPosts,
  listTopics,
  resolvePermissions,
  searchPosts,
  topicById,
  userByUsername,
  visibleForumIds,
} from '@tsbb/core';
import { escapeHtml, excerpt } from '@tsbb/markup';
import { all } from '@tsbb/db';
import { Avatar, Button, Card, CardContent, Empty, TimeAgo, trusted } from '@tsbb/ui';
import { render, type AppEnv, type Services } from '../context.ts';

export function discoverRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get('/search', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const query = (c.req.query('q') ?? '').trim();
    const minLength = Number(settings['search.minLength'] ?? 2);

    const results =
      query.length >= minLength
        ? await searchPosts({ query, viewer, limit: 30 })
        : { hits: [], terms: [] };

    const body = html`
      <div class="page-head">
        <div>
          <h1 class="page-title">Search</h1>
          ${query ? html`<p class="page-subtitle">${results.hits.length} results for “${query}”</p>` : ''}
        </div>
      </div>
      ${Card(
        CardContent(html`<form method="get" action="/search" class="row">
          <input class="input grow" type="search" name="q" value="${query}" placeholder="Search posts…" autofocus />
          ${Button('Search', { type: 'submit' })}
        </form>`),
      )}
      <div style="margin-top:1rem">
        ${!query
          ? Card(CardContent(Empty('Search the board', 'Titles are weighted above bodies, so a topic name finds the topic.')))
          : results.hits.length === 0
            ? Card(CardContent(Empty('Nothing matched', 'Try fewer words, or a different one.')))
            : Card(
                CardContent(
                  results.hits.map(
                    (hit) => html`<div class="topic-row">
                      ${hit.username
                        ? Avatar(
                            {
                              id: hit.userId ?? 0,
                              username: hit.username,
                              email: hit.email ?? '',
                              avatarKind: (hit.avatarKind as never) ?? 'identicon',
                              avatarUrl: hit.avatarUrl ?? null,
                            },
                            'sm',
                          )
                        : html`<span></span>`}
                      <div class="grow">
                        <a class="topic-title" href="/t/${hit.slug}-${hit.topicId}/p/${hit.postId}">${hit.title}</a>
                        <div class="small muted" style="margin-top:.25rem">${trusted(hit.snippet)}</div>
                        <div class="topic-sub">
                          ${hit.username ? html`<a href="/u/${hit.username}">${hit.username}</a>` : 'someone'}
                          <span class="dot" aria-hidden="true"></span>${TimeAgo(hit.createdAt)}
                        </div>
                      </div>
                      <span></span>
                    </div>`,
                  ),
                  { flush: true },
                ),
              )}
      </div>`;

    return render(c, services, {
      title: query ? `Search: ${query}` : 'Search',
      // A search you can subscribe to is the whole reason to save one.
      feedUrl: query ? `/search/feed.xml?q=${encodeURIComponent(query)}` : undefined,
      body,
    });
  });

  // --- Feeds ----------------------------------------------------------------
  //
  // Every list on the board has a feed, and each one answers exactly what its
  // page answers: a forum a viewer cannot read returns 403 for its RSS too.

  app.get('/feed.xml', async (c) => {
    const settings = c.get('settings');
    const forumIds = await visibleForumIds(c.get('viewer'));
    const topics = await listTopics({ forumIds, limit: Number(settings['feeds.itemLimit'] ?? 50) });
    return rssFeed(c, services, {
      title: String(settings['board.name'] ?? 'tsbb'),
      description: String(settings['board.tagline'] ?? ''),
      path: '/feed.xml',
      items: await topicsAsItems(topics),
    });
  });

  app.get('/latest/feed.xml', async (c) => {
    const settings = c.get('settings');
    const forumIds = await visibleForumIds(c.get('viewer'));
    const topics = await listTopics({ forumIds, limit: Number(settings['feeds.itemLimit'] ?? 50) });
    return rssFeed(c, services, {
      title: `Latest — ${String(settings['board.name'] ?? 'tsbb')}`,
      description: 'Recent activity across the board',
      path: '/latest/feed.xml',
      items: await topicsAsItems(topics),
    });
  });

  app.get('/f/:slug/feed.xml', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const forum = await forumBySlug(c.req.param('slug'));
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canView || !permissions.canRead) return c.text('Not allowed', 403);

    const topics = await listTopics({ forumId: forum.id, limit: Number(settings['feeds.itemLimit'] ?? 50) });
    return rssFeed(c, services, {
      title: `${forum.name} — ${String(settings['board.name'] ?? 'tsbb')}`,
      description: forum.description ?? '',
      path: `/f/${forum.slug}/feed.xml`,
      items: await topicsAsItems(topics),
    });
  });

  /** A single thread: its replies, oldest first, so a reader follows along. */
  app.get('/t/:handle/feed.xml', async (c) => {
    const viewer = c.get('viewer');
    const handle = c.req.param('handle');
    const id = Number.parseInt(handle.slice(handle.lastIndexOf('-') + 1), 10);
    const topic = await topicById(Number.isFinite(id) ? id : 0);
    if (!topic) return c.notFound();

    const forum = (await breadcrumb(topic.forumId)).at(-1);
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canRead) return c.text('Not allowed', 403);

    const posts = await listPosts({ topicId: topic.id, limit: 100 });
    return rssFeed(c, services, {
      title: topic.title,
      description: `Replies to ${topic.title}`,
      path: `/t/${topic.slug}-${topic.id}/feed.xml`,
      items: posts.map((post, index) => ({
        title: index === 0 ? topic.title : `Re: ${topic.title} (#${index + 1})`,
        path: `/t/${topic.slug}-${topic.id}/p/${post.id}`,
        createdAt: post.createdAt,
        author: post.authorName,
        summary: excerpt(post.body, post.bodyFormat, 500),
      })),
    });
  });

  /** One member's topics. */
  app.get('/u/:username/feed.xml', async (c) => {
    const settings = c.get('settings');
    const profile = await userByUsername(c.req.param('username'));
    if (!profile) return c.notFound();
    const topics = await listTopics({ userId: profile.id, limit: Number(settings['feeds.itemLimit'] ?? 50) });
    return rssFeed(c, services, {
      title: `${profile.username} — ${String(settings['board.name'] ?? 'tsbb')}`,
      description: `Topics started by ${profile.username}`,
      path: `/u/${profile.username}/feed.xml`,
      items: await topicsAsItems(topics),
    });
  });

  /** A saved search. Subscribing to a query is the whole point of having one. */
  app.get('/search/feed.xml', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const query = (c.req.query('q') ?? '').trim();
    const { hits } = query ? await searchPosts({ query, viewer, limit: 50 }) : { hits: [] };
    return rssFeed(c, services, {
      title: `Search: ${query} — ${String(settings['board.name'] ?? 'tsbb')}`,
      description: `Posts matching ${query}`,
      path: `/search/feed.xml?q=${encodeURIComponent(query)}`,
      items: hits.map((hit) => ({
        title: hit.title,
        path: `/t/${hit.slug}-${hit.topicId}/p/${hit.postId}`,
        createdAt: hit.createdAt,
        author: hit.username,
        summary: hit.snippet.replace(/<\/?mark>/g, ''),
      })),
    });
  });

  /**
   * Every feed on the board as one OPML file, so a reader can subscribe to the
   * whole thing in one import instead of hunting for links per forum.
   */
  app.get('/feeds.opml', async (c) => {
    const settings = c.get('settings');
    const viewer = c.get('viewer');
    const base = services.baseUrl;
    const boardName = String(settings['board.name'] ?? 'tsbb');
    const forums = await forumTree(viewer);

    const outline = (title: string, path: string) =>
      `      <outline type="rss" text="${escapeHtml(title)}" title="${escapeHtml(title)}" ` +
      `xmlUrl="${escapeHtml(new URL(path, base).toString())}" ` +
      `htmlUrl="${escapeHtml(new URL(path.replace(/\/feed\.xml$/, ''), base).toString())}" />`;

    const flatten = (nodes: typeof forums): string[] =>
      nodes.flatMap((node) => [
        ...(node.kind === 'forum' ? [outline(node.name, `/f/${node.slug}/feed.xml`)] : []),
        ...flatten(node.children as typeof forums),
      ]);

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<opml version="2.0">\n` +
      `  <head>\n` +
      `    <title>${escapeHtml(boardName)} — all feeds</title>\n` +
      `    <dateCreated>${new Date().toUTCString()}</dateCreated>\n` +
      `  </head>\n` +
      `  <body>\n` +
      `    <outline text="${escapeHtml(boardName)}" title="${escapeHtml(boardName)}">\n` +
      outline('All topics', '/feed.xml') + `\n` +
      outline('Latest', '/latest/feed.xml') + `\n` +
      flatten(forums).join('\n') + `\n` +
      `    </outline>\n` +
      `  </body>\n` +
      `</opml>\n`;

    return c.body(xml, 200, {
      'content-type': 'text/x-opml; charset=utf-8',
      // Named, so a browser saves it as a file rather than rendering XML.
      'content-disposition': `attachment; filename="${boardName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-feeds.opml"`,
      'cache-control': 'public, max-age=300',
    });
  });

  /** A page that lists what can be subscribed to, and offers the OPML. */
  app.get('/feeds', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const forums = await forumTree(viewer);
    const flat = (nodes: typeof forums): typeof forums =>
      nodes.flatMap((n) => [...(n.kind === 'forum' ? [n] : []), ...flat(n.children as typeof forums)]);

    const body = html`
      <div class="page-head">
        <div>
          <h1 class="page-title">Feeds</h1>
          <p class="page-subtitle">Every list here has one. Subscribe to the board, a forum, a member, or a search.</p>
        </div>
        <a class="btn btn-sm" href="/feeds.opml" download>Download OPML</a>
      </div>
      ${Card(
        CardContent(
          html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Feed</th><th>Address</th></tr></thead>
            <tbody>
              <tr><td>All topics</td><td><a href="/feed.xml"><code>/feed.xml</code></a></td></tr>
              <tr><td>Latest</td><td><a href="/latest/feed.xml"><code>/latest/feed.xml</code></a></td></tr>
              ${flat(forums).map(
                (f) => html`<tr>
                  <td>${f.name}</td>
                  <td><a href="/f/${f.slug}/feed.xml"><code>/f/${f.slug}/feed.xml</code></a></td>
                </tr>`,
              )}
              <tr><td>Any thread</td><td><code>/t/&lt;thread&gt;/feed.xml</code></td></tr>
              <tr><td>Any member</td><td><code>/u/&lt;name&gt;/feed.xml</code></td></tr>
              <tr><td>Any search</td><td><code>/search/feed.xml?q=&lt;query&gt;</code></td></tr>
            </tbody>
          </table></div>`,
          { flush: true },
        ),
      )}`;

    return render(c, services, {
      title: 'Feeds',
      description: `Every RSS feed on ${String(settings['board.name'] ?? 'this board')}`,
      body,
    });
  });

  return app;
}

export interface FeedItem {
  title: string;
  path: string;
  createdAt: number;
  author: string | null;
  summary: string;
}

/**
 * One RSS builder for every feed on the board.
 *
 * It takes already-shaped items rather than topics, so a topic's replies, a
 * member's posts and a search can each be a feed without a second
 * implementation drifting away from the first.
 */
function rssFeed(
  c: Context<AppEnv>,
  services: Services,
  options: { title: string; description: string; path: string; items: FeedItem[] },
) {
  const base = services.baseUrl;
  const items = options.items
    .map((item) => {
      const link = new URL(item.path, base).toString();
      return (
        `    <item>\n` +
        `      <title>${escapeHtml(item.title)}</title>\n` +
        `      <link>${escapeHtml(link)}</link>\n` +
        `      <guid isPermaLink="true">${escapeHtml(link)}</guid>\n` +
        (item.author ? `      <dc:creator>${escapeHtml(item.author)}</dc:creator>\n` : '') +
        `      <pubDate>${new Date(item.createdAt).toUTCString()}</pubDate>\n` +
        `      <description>${escapeHtml(item.summary)}</description>\n` +
        `    </item>`
      );
    })
    .join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `  <channel>\n` +
    `    <title>${escapeHtml(options.title)}</title>\n` +
    `    <link>${escapeHtml(base)}</link>\n` +
    `    <description>${escapeHtml(options.description)}</description>\n` +
    `    <atom:link href="${escapeHtml(new URL(options.path, base).toString())}" rel="self" type="application/rss+xml" />\n` +
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n` +
    `${items}\n` +
    `  </channel>\n` +
    `</rss>\n`;

  return c.body(xml, 200, {
    'content-type': 'application/rss+xml; charset=utf-8',
    'cache-control': 'public, max-age=300',
  });
}

/** Topics as feed items, with the opening post as the summary. */
async function topicsAsItems(
  topics: { id: number; slug: string; title: string; createdAt: number; authorName: string | null; firstPostId: number | null }[],
): Promise<FeedItem[]> {
  const ids = topics.map((t) => t.firstPostId).filter((id): id is number => id !== null);
  const bodies = ids.length
    ? new Map(
        (
          await all<{ id: number; body: string; body_format: string }>(
            `SELECT id, body, body_format FROM posts WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids,
          )
        ).map((r) => [r.id, r]),
      )
    : new Map();

  return topics.map((topic) => {
    const post = topic.firstPostId ? bodies.get(topic.firstPostId) : null;
    return {
      title: topic.title,
      path: `/t/${topic.slug}-${topic.id}`,
      createdAt: topic.createdAt,
      author: topic.authorName,
      summary: post ? excerpt(post.body, post.body_format as 'markdown' | 'bbcode', 400) : '',
    };
  });
}
