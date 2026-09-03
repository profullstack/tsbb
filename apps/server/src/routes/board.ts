import { Hono } from 'hono';
import { all, one } from '@tsbb/db';
import type { Context } from 'hono';
import { html } from 'hono/html';
import {
  ancestryOf,
  breadcrumb,
  canEditPost,
  forumBySlug,
  forumTree,
  forumWithDescendants,
  listPosts,
  listTopics,
  countTopics,
  formatCount,
  markRead,
  rankFor,
  recordView,
  render as renderMarkup,
  renderUserSignature,
  resolvePermissions,
  signatureGate,
  topicById,
  unreadInTree,
  unreadTopicCounts,
  visibleForumIds,
  isSubscribed,
  type Settings,
} from '@tsbb/core';
import {
  Breadcrumb,
  Card,
  CardContent,
  CardHeader,
  Empty,
  ForumRow,
  LinkButton,
  Pagination,
  PostArticle,
  ReadBar,
  TopicRow,
  trusted,
  type PostView,
} from '@tsbb/ui';
import type { Post, User, Viewer } from '@tsbb/plugin-api';
import { render, slot, type AppEnv, type Services } from '../context.ts';

export function boardRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // --- Board index --------------------------------------------------------

  app.get('/', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const tree = await forumTree(viewer);

    const above = await slot(c, services, 'board:above_categories');
    const below = await slot(c, services, 'board:below_categories');
    const stats = await boardStats();

    const body = html`${trusted(above)}
      ${viewer.user && tree.length
        ? ReadBar({ unread: unreadInTree(tree), action: '/read', label: 'Mark all read', scope: 'on the board' })
        : ''}
      ${tree.length === 0
        ? Card(CardContent(Empty('No forums yet', viewer.isAdmin
            ? html`Create the first one in <a href="/admin/forums">administration</a>.`
            : 'An administrator has not set this board up yet.')))
        : (() => {
            // One counter across every category, so the hue cycle runs the
            // length of the page instead of restarting inside each card —
            // :nth-child counts within a parent and never gets past hue 3.
            let hue = 0;
            return tree.map((node) =>
              node.kind === 'category'
                ? html`<section class="category">
                    <div class="category-header"><h2 class="category-title">${node.name}</h2></div>
                    ${Card(
                      CardContent(
                        node.children.map((child) => ForumRow(child, hue++)),
                        { flush: true },
                      ),
                    )}
                  </section>`
                : html`<section class="category">
                    ${Card(CardContent(ForumRow(node, hue++), { flush: true }))}
                  </section>`,
            );
          })()}
      ${boardStatsPanel(stats)}
      ${trusted(below)}`;

    return render(c, services, {
      title: String(settings['board.name'] ?? 'Forums'),
      description: String(settings['board.description'] ?? settings['board.tagline'] ?? ''),
      feedUrl: '/feed.xml',
      body,
    });
  });

  // --- Latest across every forum the viewer can read ----------------------

  app.get('/latest', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const perPage = Number(settings['topics.perPage'] ?? 30);
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const forumIds = await visibleForumIds(viewer);

    const [topics, total, unread] = await Promise.all([
      listTopics({ forumIds, limit: perPage, offset: (page - 1) * perPage, viewerId: viewer.user?.id ?? null }),
      countTopics({ forumIds }),
      unreadTopicCounts(viewer.user?.id ?? null, forumIds),
    ]);

    const body = html`
      <div class="page-head">
        <div><h1 class="page-title">Latest</h1><p class="page-subtitle">Recent activity across the board</p></div>
      </div>
      ${viewer.user
        ? ReadBar({ unread: sumCounts(unread), action: '/read', label: 'Mark all read', scope: 'on the board' })
        : ''}
      ${Card(
        CardContent(
          topics.length ? topics.map((t) => TopicRow(t)) : Empty('Nothing posted yet'),
          { flush: true },
        ),
      )}
      ${Pagination(page, Math.ceil(total / perPage), (p) => `/latest?page=${p}`)}`;

    return render(c, services, { title: 'Latest', feedUrl: '/latest/feed.xml', body });
  });

  // --- One forum ----------------------------------------------------------

  app.get('/f/:slug', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const forum = await forumBySlug(c.req.param('slug'));
    if (!forum) return c.notFound();

    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canView || !permissions.canRead) {
      return forbidden(c, services, 'You do not have access to this forum.');
    }

    const perPage = Number(settings['topics.perPage'] ?? 30);
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const viewerId = viewer.user?.id ?? null;
    const [topics, total, trail, unread] = await Promise.all([
      listTopics({
        forumId: forum.id,
        limit: perPage,
        offset: (page - 1) * perPage,
        viewerId,
        includeHidden: permissions.canModerate,
      }),
      countTopics({ forumId: forum.id, includeHidden: permissions.canModerate }),
      breadcrumb(forum.id),
      // Subforums count too, because "mark this forum read" covers them.
      forumWithDescendants(forum.id).then((ids) => unreadTopicCounts(viewerId, ids)),
    ]);

    const above = await slot(c, services, 'forum:above_topics', { forum });
    const below = await slot(c, services, 'forum:below_topics', { forum });

    const body = html`
      ${Breadcrumb([{ label: 'Forums', href: '/' }, ...trail.map((f) => ({ label: f.name, href: `/f/${f.slug}` }))])}
      <div class="page-head">
        <div>
          <h1 class="page-title">${forum.name}</h1>
          ${forum.description ? html`<p class="page-subtitle">${forum.description}</p>` : ''}
        </div>
        ${permissions.canPost && !forum.isLocked
          ? LinkButton('New topic', `/f/${forum.slug}/new`, { size: 'sm' })
          : ''}
      </div>
      ${trusted(above)}
      ${viewer.user
        ? ReadBar({
            unread: sumCounts(unread),
            action: `/f/${forum.slug}/read`,
            label: 'Mark forum read',
            scope: 'in this forum',
          })
        : ''}
      ${Card(
        CardContent(
          topics.length
            ? topics.map((t) => TopicRow(t))
            : Empty(
                'No topics here yet',
                permissions.canPost
                  ? 'Be the first to post.'
                  : forum.memberPosting !== 'topics'
                    ? 'Topics here are posted by the board, not by members.'
                    : undefined,
              ),
          { flush: true },
        ),
      )}
      ${Pagination(page, Math.ceil(total / perPage), (p) => `/f/${forum.slug}?page=${p}`)}
      ${trusted(below)}`;

    return render(c, services, {
      title: forum.name,
      description: forum.description ?? undefined,
      feedUrl: `/f/${forum.slug}/feed.xml`,
      body,
    });
  });

  /**
   * The page the service worker serves when the network is gone. It is a real
   * route rather than a static file so it carries the board's own chrome and
   * theme — an offline page that looks like a different site reads as a crash.
   */
  app.get('/offline', async (c) =>
    render(c, services, {
      title: 'Offline',
      body: Card(
        CardContent(
          Empty(
            'You are offline',
            'Pages you have already read are still here. Anything new needs a connection.',
          ),
        ),
      ),
    }),
  );

  // --- One topic ----------------------------------------------------------
  // The slug is decorative: the id after the last hyphen is what resolves, so
  // a renamed topic keeps working from every link ever posted to it.

  app.get('/t/:handle', async (c) => topicPage(c, services));
  app.get('/t/:handle/p/:postId', async (c) => topicPage(c, services));

  return app;
}

function sumCounts(counts: Map<number, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

interface BoardStats {
  topics: number;
  posts: number;
  members: number;
  online: number;
  newest: string | null;
}

/**
 * The statistics strip every phpBB and vBulletin board has carried for twenty
 * years. It is not decoration: on a quiet board it is the only thing that says
 * anybody is here at all.
 */
async function boardStats(): Promise<BoardStats> {
  const row = await one<{ topics: number; posts: number; members: number; online: number }>(
    `SELECT
       (SELECT COUNT(*) FROM topics WHERE is_deleted = 0 AND is_hidden = 0) AS topics,
       (SELECT COUNT(*) FROM posts  WHERE is_deleted = 0 AND is_hidden = 0) AS posts,
       (SELECT COUNT(*) FROM users  WHERE is_deleted = 0) AS members,
       (SELECT COUNT(*) FROM users  WHERE is_deleted = 0 AND last_seen_at > ?) AS online`,
    [Date.now() - 15 * 60_000],
  );
  const newest = await one<{ username: string }>(
    'SELECT username FROM users WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 1',
  );
  return {
    topics: Number(row?.topics ?? 0),
    posts: Number(row?.posts ?? 0),
    members: Number(row?.members ?? 0),
    online: Number(row?.online ?? 0),
    newest: newest?.username ?? null,
  };
}

function boardStatsPanel(stats: BoardStats) {
  return Card(html`
    ${CardHeader('Board statistics')}
    <div class="board-stats">
      <div class="board-stat"><strong>${formatCount(stats.topics)}</strong><span>Topics</span></div>
      <div class="board-stat"><strong>${formatCount(stats.posts)}</strong><span>Posts</span></div>
      <div class="board-stat"><strong>${formatCount(stats.members)}</strong><span>Members</span></div>
      <div class="board-stat"><strong>${formatCount(stats.online)}</strong><span>Online now</span></div>
    </div>
    ${stats.newest
      ? html`<div class="board-newest">
          Welcome to our newest member, <a href="/u/${stats.newest}">${stats.newest}</a>
        </div>`
      : ''}
  `);
}

function topicIdFromHandle(handle: string): number {
  const id = Number.parseInt(handle.slice(handle.lastIndexOf('-') + 1), 10);
  return Number.isFinite(id) ? id : 0;
}

async function topicPage(c: Context<AppEnv>, services: Services) {
  const viewer = c.get('viewer') as Viewer;
  const settings = c.get('settings') as Settings;
  const handle = c.req.param('handle') ?? '';
  const topic = await topicById(topicIdFromHandle(handle), true);
  if (!topic) return c.notFound();

  const forum = (await breadcrumb(topic.forumId)).at(-1);
  if (!forum) return c.notFound();

  const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
  if (!permissions.canView || !permissions.canRead) {
    return forbidden(c, services, 'You do not have access to this topic.');
  }
  if ((topic.isHidden || topic.isDeleted) && !permissions.canModerate) return c.notFound();

  // The canonical URL always carries the current slug, so a link with a stale
  // one redirects rather than serving a second copy of the page.
  const canonicalHandle = `${topic.slug}-${topic.id}`;
  if (handle !== canonicalHandle) {
    return c.redirect(`/t/${canonicalHandle}${c.req.param('postId') ? `/p/${c.req.param('postId')}` : ''}`, 301);
  }

  const perPage = Number(settings['posts.perPage'] ?? 20);
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const posts = await listPosts({
    topicId: topic.id,
    limit: perPage,
    offset: (page - 1) * perPage,
    viewerId: viewer.user?.id ?? null,
    includeHidden: permissions.canModerate,
  });

  await recordView(topic.id, viewer.user?.id ?? null);
  if (viewer.user && topic.lastPostId) await markRead(topic.id, viewer.user.id, topic.lastPostId);

  const baseUrl = services.baseUrl;
  const internalHosts = [new URL(baseUrl).host];
  const editWindow = Number(settings['posts.editWindowMinutes'] ?? 0);

  const views: PostView[] = await Promise.all(
    posts.map(async (post) => {
      const author: User | null = post.authorName
        ? ({
            id: post.userId ?? 0,
            username: post.authorName,
            displayName: post.authorDisplayName,
            email: post.authorEmail ?? '',
            avatarKind: (post.authorAvatarKind as User['avatarKind']) ?? 'identicon',
            avatarUrl: post.authorAvatarUrl,
            signature: post.authorSignature,
            title: post.authorTitle,
            location: null,
            website: null,
            bio: null,
            timezone: 'UTC',
            locale: 'en',
            postCount: post.authorPostCount,
            topicCount: 0,
            reactionCount: 0,
            isAdmin: post.authorIsAdmin,
            isModerator: post.authorIsModerator,
            isBanned: false,
            createdAt: post.authorCreatedAt ?? 0,
            lastSeenAt: null,
          } satisfies User)
        : null;

      const bodyHtml = await services.registry.bus.applyFilter(
        'post:render',
        renderMarkup(post.body, post.bodyFormat, {
          internalHosts,
          mentionUrl: (u) => `/u/${u}`,
        }),
        { post: post as Post, author, viewer },
      );

      // The signature threshold is a filter, so a plugin can raise it, lower it
      // or make it conditional without touching core.
      let signatureHtml: string | null = null;
      if (author) {
        const minPosts = await services.registry.bus.applyFilter(
          'signature:min_posts',
          Number(settings['signatures.minPosts'] ?? 10),
          { author },
        );
        const gate = signatureGate(author, settings, minPosts);
        if (gate.visible) {
          signatureHtml = await services.registry.bus.applyFilter(
            'signature:render',
            renderUserSignature(author, settings, { internalHosts, mentionUrl: (u) => `/u/${u}` }) ?? '',
            { author, viewer },
          );
        }
      }

      const [byline, footer] = await Promise.all([
        slot(c, services, 'post:byline', { post, author }),
        slot(c, services, 'post:footer', { post, author }),
      ]);

      return {
        id: post.id,
        bodyHtml,
        signatureHtml: signatureHtml || null,
        createdAt: post.createdAt,
        editedAt: post.editedAt,
        editCount: post.editCount,
        isHidden: post.isHidden,
        isSolution: false,
        reactionCount: post.reactionCount,
        viewerReacted: post.viewerReacted,
        author: author
          ? { ...author, rank: (await rankFor(author))?.title ?? null }
          : null,
        canEdit: canEditPost(viewer, permissions, post, editWindow),
        canDelete: canEditPost(viewer, permissions, post, editWindow),
        canModerate: permissions.canModerate,
        slots: { byline, footer },
      } satisfies PostView;
    }),
  );

  const [above, below] = await Promise.all([
    slot(c, services, 'topic:above_posts', { topic, forum }),
    slot(c, services, 'topic:below_posts', { topic, forum }),
  ]);

  /*
   * One entry per gap between two posts. The board offers every gap and a
   * plugin picks which to use, rather than the board guessing — but they are
   * resolved here rather than inside the render map, so the output does not
   * depend on how quickly each handler happened to return.
   */
  const betweenPosts = await Promise.all(
    views.slice(0, -1).map((_view, index) =>
      slot(c, services, 'topic:between_posts', { topic, index, total: views.length }),
    ),
  );
  const subscribed = viewer.user ? await isSubscribed(viewer.user.id, topic.id) : false;
  const trail = await breadcrumb(topic.forumId);
  const pages = Math.ceil((topic.replyCount + 1) / perPage);

  const body = html`
    ${Breadcrumb([
      { label: 'Forums', href: '/' },
      ...trail.map((f) => ({ label: f.name, href: `/f/${f.slug}` })),
      { label: topic.title },
    ])}
    <div class="topic-head">
      <div>
        <h1 class="topic-heading">${topic.title}</h1>
        <div class="topic-head-meta">
          <span>${topic.replyCount} ${topic.replyCount === 1 ? 'reply' : 'replies'}</span>
          <span class="dot" aria-hidden="true"></span>
          <span>${topic.viewCount} views</span>
        </div>
      </div>
      <div class="row">
        ${viewer.user
          ? html`<form action="/t/${canonicalHandle}/subscribe" method="post">
              <input type="hidden" name="on" value="${subscribed ? '0' : '1'}" />
              <button class="${subscribed ? 'btn btn-secondary btn-sm' : 'btn btn-outline btn-sm'}" type="submit">
                ${subscribed ? 'Following' : 'Follow'}
              </button>
            </form>`
          : ''}
        ${permissions.canReply && !topic.isLocked
          ? LinkButton('Reply', `/t/${canonicalHandle}/reply`, { size: 'sm' })
          : ''}
      </div>
    </div>
    ${trusted(above)}
    ${views.map((view, i) =>
      html`${PostArticle({
        post: view,
        topicSlug: topic.slug,
        topicId: topic.id,
        viewer,
        number: (page - 1) * perPage + i + 1,
        canReply: permissions.canReply && !topic.isLocked,
      })}${i < views.length - 1 ? trusted(betweenPosts[i] ?? '') : ''}`,
    )}
    ${Pagination(page, pages, (p) => `/t/${canonicalHandle}?page=${p}`)}
    ${topic.isLocked
      ? html`<div class="alert"><div><div class="alert-title">This topic is locked</div>
          <div class="alert-description">New replies are not accepted.</div></div></div>`
      : permissions.canReply
        ? html`<div class="composer">${LinkButton('Write a reply', `/t/${canonicalHandle}/reply`)}</div>`
        : ''}
    ${trusted(below)}`;

  return render(c, services, {
    title: topic.title,
    canonical: new URL(`/t/${canonicalHandle}`, baseUrl).toString(),
    feedUrl: `/t/${canonicalHandle}/feed.xml`,
    body,
  });
}

export async function forbidden(
  c: Context<AppEnv>,
  services: Services,
  message: string,
) {
  return render(c, services, {
    title: 'Not allowed',
    status: 403,
    body: Card(CardContent(Empty('Not allowed', message))),
  });
}
