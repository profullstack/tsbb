import { Hono } from 'hono';
import {
  ancestryOf,
  breadcrumb,
  createTopic,
  forumBySlug,
  forumTree,
  listNotifications,
  listPosts,
  listTopics,
  markNotificationsRead,
  notifyNewPost,
  pollDeviceCode,
  PostError,
  reply,
  resolvePermissions,
  searchPosts,
  startDeviceAuth,
  topicById,
  unreadCount,
  visibleForumIds,
} from '@tsbb/core';
import { toPlainText } from '@tsbb/markup';
import type { AppEnv, Services } from '../context.ts';

/**
 * The REST API.
 *
 * This is what a client of a *centralised install* talks to — the terminal
 * client above all, but equally a script, a bot or another board. It is
 * deliberately the same data the HTML pages render, resolved through the same
 * permission checks, so a token can never see something the browser would hide.
 *
 * Authentication is a bearer token, resolved in the app-wide middleware. A
 * token is never an administrator, however it was minted.
 */
export function apiRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
  });

  app.get('/api/v1/me', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.json({ authenticated: false }, 200);
    return c.json({
      authenticated: true,
      user: {
        id: viewer.user.id,
        username: viewer.user.username,
        displayName: viewer.user.displayName,
        postCount: viewer.user.postCount,
        isAdmin: viewer.isAdmin,
        isModerator: viewer.isModerator,
      },
      unread: await unreadCount(viewer.user.id),
    });
  });

  app.get('/api/v1/board', async (c) => {
    const settings = c.get('settings');
    const tree = await forumTree(c.get('viewer'));
    return c.json({
      board: { name: settings['board.name'], tagline: settings['board.tagline'] },
      forums: tree.map(flattenForum),
    });
  });

  app.get('/api/v1/forums/:slug/topics', async (c) => {
    const viewer = c.get('viewer');
    const forum = await forumBySlug(c.req.param('slug'));
    if (!forum) return c.json({ error: 'not_found' }, 404);

    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canView || !permissions.canRead) return c.json({ error: 'forbidden' }, 403);

    const limit = clampLimit(c.req.query('limit'));
    const topics = await listTopics({
      forumId: forum.id,
      limit,
      offset: Number(c.req.query('offset') ?? 0),
      viewerId: viewer.user?.id ?? null,
    });
    return c.json({
      forum: { id: forum.id, slug: forum.slug, name: forum.name, description: forum.description },
      topics: topics.map(flattenTopic),
    });
  });

  app.get('/api/v1/latest', async (c) => {
    const viewer = c.get('viewer');
    const forumIds = await visibleForumIds(viewer);
    const topics = await listTopics({
      forumIds,
      limit: clampLimit(c.req.query('limit')),
      offset: Number(c.req.query('offset') ?? 0),
      viewerId: viewer.user?.id ?? null,
    });
    return c.json({ topics: topics.map(flattenTopic) });
  });

  app.get('/api/v1/topics/:id', async (c) => {
    const viewer = c.get('viewer');
    const topic = await topicById(Number(c.req.param('id')));
    if (!topic) return c.json({ error: 'not_found' }, 404);

    const forum = (await breadcrumb(topic.forumId)).at(-1);
    if (!forum) return c.json({ error: 'not_found' }, 404);
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canRead) return c.json({ error: 'forbidden' }, 403);

    const posts = await listPosts({
      topicId: topic.id,
      limit: clampLimit(c.req.query('limit'), 50),
      offset: Number(c.req.query('offset') ?? 0),
      viewerId: viewer.user?.id ?? null,
    });

    return c.json({
      topic: flattenTopic({ ...topic, authorName: null, lastPosterName: null, unread: false, hasPoll: false }),
      forum: { id: forum.id, slug: forum.slug, name: forum.name },
      canReply: permissions.canReply && !topic.isLocked,
      posts: posts.map((post) => ({
        id: post.id,
        author: post.authorName,
        authorTitle: post.authorTitle,
        createdAt: post.createdAt,
        editedAt: post.editedAt,
        format: post.bodyFormat,
        body: post.body,
        // A terminal cannot render HTML, so the plain form travels alongside
        // the source rather than making every client reimplement the parser.
        text: toPlainText(post.body, post.bodyFormat),
        reactions: post.reactionCount,
      })),
    });
  });

  app.post('/api/v1/topics/:id/posts', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.json({ error: 'unauthorized' }, 401);

    const topic = await topicById(Number(c.req.param('id')));
    if (!topic) return c.json({ error: 'not_found' }, 404);
    const forum = (await breadcrumb(topic.forumId)).at(-1);
    if (!forum) return c.json({ error: 'not_found' }, 404);
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canReply || topic.isLocked) return c.json({ error: 'forbidden' }, 403);

    const payload = await c.req.json<{ body?: string; format?: string }>().catch(() => ({}));
    try {
      const post = await reply({
        topic,
        viewer,
        body: String(payload.body ?? ''),
        format: payload.format === 'bbcode' ? 'bbcode' : 'markdown',
        bus: services.registry.bus,
      });
      await notifyNewPost({ post, topic, viewer, baseUrl: services.baseUrl, bus: services.registry.bus });
      return c.json({ id: post.id, url: `/t/${topic.slug}-${topic.id}/p/${post.id}` }, 201);
    } catch (error) {
      return apiError(c, error);
    }
  });

  app.post('/api/v1/forums/:slug/topics', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.json({ error: 'unauthorized' }, 401);
    const forum = await forumBySlug(c.req.param('slug'));
    if (!forum) return c.json({ error: 'not_found' }, 404);
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canPost || forum.isLocked) return c.json({ error: 'forbidden' }, 403);

    const payload = await c.req.json<{ title?: string; body?: string; format?: string }>().catch(() => ({}));
    try {
      const { topic, post } = await createTopic({
        forum,
        viewer,
        title: String(payload.title ?? ''),
        body: String(payload.body ?? ''),
        format: payload.format === 'bbcode' ? 'bbcode' : 'markdown',
        bus: services.registry.bus,
      });
      await notifyNewPost({ post, topic, viewer, baseUrl: services.baseUrl, bus: services.registry.bus });
      return c.json({ id: topic.id, slug: topic.slug, url: `/t/${topic.slug}-${topic.id}` }, 201);
    } catch (error) {
      return apiError(c, error);
    }
  });

  app.get('/api/v1/search', async (c) => {
    const query = c.req.query('q') ?? '';
    const { hits } = await searchPosts({
      query,
      viewer: c.get('viewer'),
      limit: clampLimit(c.req.query('limit')),
    });
    return c.json({
      query,
      hits: hits.map((hit) => ({
        postId: hit.postId,
        topicId: hit.topicId,
        title: hit.title,
        author: hit.username,
        createdAt: hit.createdAt,
        // The snippet carries <mark> for the browser; the API hands back the
        // text a terminal can print.
        snippet: hit.snippet.replace(/<\/?mark>/g, ''),
        url: `/t/${hit.slug}-${hit.topicId}/p/${hit.postId}`,
      })),
    });
  });

  app.get('/api/v1/notifications', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.json({ error: 'unauthorized' }, 401);
    const notifications = await listNotifications(viewer.user.id, {
      limit: clampLimit(c.req.query('limit')),
      unreadOnly: c.req.query('unread') === '1',
    });
    return c.json({ unread: await unreadCount(viewer.user.id), notifications });
  });

  app.post('/api/v1/notifications/read', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.json({ error: 'unauthorized' }, 401);
    await markNotificationsRead(viewer.user.id);
    return c.json({ ok: true });
  });

  // --- Device authorisation ----------------------------------------------
  // A terminal cannot hold a browser session, so it shows a short code, a human
  // approves it in a browser, and the terminal polls for the token.

  app.post('/api/v1/device/start', async (c) => {
    const payload = await c.req.json<{ label?: string; publicKey?: string }>().catch(() => ({}));
    const grant = await startDeviceAuth({
      publicKey: String(payload.publicKey ?? 'none'),
      label: payload.label ? String(payload.label).slice(0, 60) : 'Terminal',
      baseUrl: services.baseUrl,
    });
    return c.json({
      deviceCode: grant.deviceCode,
      userCode: grant.userCode,
      verifyUrl: grant.verifyUrl,
      expiresAt: grant.expiresAt,
      interval: 2,
    });
  });

  app.post('/api/v1/device/poll', async (c) => {
    const payload = await c.req.json<{ deviceCode?: string }>().catch(() => ({}));
    const result = await pollDeviceCode(String(payload.deviceCode ?? ''));
    return c.json(result, result.status === 'expired' ? 410 : 200);
  });

  return app;
}

function clampLimit(value: string | undefined, max = 100): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(max, Math.max(1, parsed));
}

function flattenForum(node: {
  id: number;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  topicCount: number;
  postCount: number;
  children: unknown[];
}): unknown {
  return {
    id: node.id,
    slug: node.slug,
    name: node.name,
    kind: node.kind,
    description: node.description,
    topics: node.topicCount,
    posts: node.postCount,
    children: (node.children as Parameters<typeof flattenForum>[0][]).map(flattenForum),
  };
}

function flattenTopic(topic: {
  id: number;
  slug: string;
  title: string;
  kind: string;
  isLocked: boolean;
  isSolved: boolean;
  replyCount: number;
  viewCount: number;
  createdAt: number;
  lastPostAt: number | null;
  authorName: string | null;
  lastPosterName: string | null;
  unread: boolean;
}): unknown {
  return {
    id: topic.id,
    slug: topic.slug,
    title: topic.title,
    kind: topic.kind,
    locked: topic.isLocked,
    solved: topic.isSolved,
    replies: topic.replyCount,
    views: topic.viewCount,
    createdAt: topic.createdAt,
    lastPostAt: topic.lastPostAt,
    author: topic.authorName,
    lastPoster: topic.lastPosterName,
    unread: topic.unread,
    url: `/t/${topic.slug}-${topic.id}`,
  };
}

function apiError(c: { json: (body: unknown, status: 400 | 500) => Response }, error: unknown) {
  if (error instanceof PostError) {
    return c.json({ error: error.code, message: error.message }, 400);
  }
  console.error('[api]', error);
  return c.json({ error: 'internal' }, 500);
}
