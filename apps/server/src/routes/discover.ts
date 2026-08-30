import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { ancestryOf, forumBySlug, listTopics, resolvePermissions, searchPosts, visibleForumIds } from '@tsbb/core';
import { escapeHtml, excerpt } from '@tsbb/markup';
import { all } from '@tsbb/db';
import { Button, Card, CardContent, Empty, TimeAgo, trusted } from '@tsbb/ui';
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
                      <span></span>
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

    return render(c, services, { title: query ? `Search: ${query}` : 'Search', body });
  });

  // --- Feeds --------------------------------------------------------------

  app.get('/feed.xml', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const forumIds = await visibleForumIds(viewer);
    const topics = await listTopics({ forumIds, limit: Number(settings['feeds.itemLimit'] ?? 50) });
    return feed(c, services, {
      title: String(settings['board.name'] ?? 'tsbb'),
      description: String(settings['board.tagline'] ?? ''),
      path: '/feed.xml',
      topics,
    });
  });

  app.get('/f/:slug/feed.xml', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const forum = await forumBySlug(c.req.param('slug'));
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    // A feed must answer exactly what the page would. A forum a guest cannot
    // read must not become readable by asking for its RSS.
    if (!permissions.canView || !permissions.canRead) return c.text('Not allowed', 403);

    const topics = await listTopics({ forumId: forum.id, limit: Number(settings['feeds.itemLimit'] ?? 50) });
    return feed(c, services, {
      title: `${forum.name} — ${String(settings['board.name'] ?? 'tsbb')}`,
      description: forum.description ?? '',
      path: `/f/${forum.slug}/feed.xml`,
      topics,
    });
  });

  return app;
}

async function feed(
  c: Context<AppEnv>,
  services: Services,
  options: {
    title: string;
    description: string;
    path: string;
    topics: { id: number; slug: string; title: string; createdAt: number; authorName: string | null; firstPostId: number | null }[];
  },
) {
  const base = services.baseUrl;
  const firstPostIds = options.topics
    .map((t) => t.firstPostId)
    .filter((id): id is number => id !== null);
  const bodies = firstPostIds.length
    ? new Map(
        (
          await all<{ id: number; body: string; body_format: string }>(
            `SELECT id, body, body_format FROM posts WHERE id IN (${firstPostIds.map(() => '?').join(',')})`,
            firstPostIds,
          )
        ).map((row) => [row.id, row]),
      )
    : new Map();

  const items = options.topics
    .map((topic) => {
      const link = new URL(`/t/${topic.slug}-${topic.id}`, base).toString();
      const post = topic.firstPostId ? bodies.get(topic.firstPostId) : null;
      const summary = post ? excerpt(post.body, post.body_format as 'markdown' | 'bbcode', 400) : '';
      return (
        `    <item>\n` +
        `      <title>${escapeHtml(topic.title)}</title>\n` +
        `      <link>${escapeHtml(link)}</link>\n` +
        `      <guid isPermaLink="true">${escapeHtml(link)}</guid>\n` +
        (topic.authorName ? `      <dc:creator>${escapeHtml(topic.authorName)}</dc:creator>\n` : '') +
        `      <pubDate>${new Date(topic.createdAt).toUTCString()}</pubDate>\n` +
        `      <description>${escapeHtml(summary)}</description>\n` +
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
