import { all, now, one, run } from '@tsbb/db';
import type { HookBus } from '@tsbb/plugin-host';
import type { BodyFormat, Forum, Id, Post, PostDraft, Topic, Viewer } from '@tsbb/plugin-api';
import { extractMentions, render } from '@tsbb/markup';
import { loadSettings, type Settings } from './settings.ts';
import { recountForum } from './forums.ts';
import { recountTopic, uniqueTopicSlug, visiblePost } from './topics.ts';
import { recountUser } from './users.ts';
import { hashIp } from './util.ts';

export interface PostRow {
  id: number;
  topic_id: number;
  forum_id: number;
  user_id: number | null;
  reply_to_id: number | null;
  body: string;
  body_format: string;
  position: number;
  is_hidden: number;
  is_deleted: number;
  edit_count: number;
  edited_at: number | null;
  edited_by: number | null;
  edit_reason: string | null;
  ip_hash: string | null;
  created_at: number;
}

export function toPost(row: PostRow): Post {
  return {
    id: row.id,
    topicId: row.topic_id,
    forumId: row.forum_id,
    userId: row.user_id,
    replyToId: row.reply_to_id,
    body: row.body,
    bodyFormat: (row.body_format as BodyFormat) ?? 'markdown',
    position: row.position,
    isHidden: row.is_hidden === 1,
    isDeleted: row.is_deleted === 1,
    editCount: row.edit_count,
    editedAt: row.edited_at,
    createdAt: row.created_at,
  };
}

export type PostErrorCode =
  | 'too_short'
  | 'too_long'
  | 'flooding'
  | 'locked'
  | 'forbidden'
  | 'rejected';

/**
 * Assigned in the body rather than declared as a constructor parameter
 * property. The whole codebase runs unbuilt through Node's type stripping,
 * which erases types but cannot synthesise the assignment a parameter property
 * implies — `erasableSyntaxOnly` in tsconfig.json is what keeps that honest.
 */
export class PostError extends Error {
  code: PostErrorCode;

  constructor(message: string, code: PostErrorCode) {
    super(message);
    this.name = 'PostError';
    this.code = code;
  }
}

/**
 * Flood control is counted off `audit_events` rather than a table of its own.
 * Every write already records an audit row in the same transaction, so
 * throttling costs no extra write anywhere.
 */
export async function checkFlood(userId: Id, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  const row = await one<{ created_at: number }>(
    `SELECT created_at FROM audit_events
      WHERE user_id = ? AND action IN ('post.create', 'topic.create')
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!row) return;
  const waited = now() - Number(row.created_at);
  if (waited < seconds * 1000) {
    const remaining = Math.ceil((seconds * 1000 - waited) / 1000);
    throw new PostError(`Please wait ${remaining}s before posting again.`, 'flooding');
  }
}

export async function audit(input: {
  userId: Id | null;
  action: string;
  targetType?: string;
  targetId?: Id;
  ip?: string | null;
  detail?: unknown;
}): Promise<void> {
  await run(
    `INSERT INTO audit_events (user_id, action, target_type, target_id, ip_hash, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      hashIp(input.ip),
      input.detail === undefined ? null : JSON.stringify(input.detail),
      now(),
    ],
  );
}

function validateBody(body: string, settings: Settings): string {
  const trimmed = body.trim();
  const min = Number(settings['posts.minLength'] ?? 2);
  const max = Number(settings['posts.maxLength'] ?? 60_000);
  if (trimmed.length < min) throw new PostError(`Posts are at least ${min} characters.`, 'too_short');
  if (trimmed.length > max) throw new PostError(`Posts are at most ${max} characters.`, 'too_long');
  return trimmed;
}

export interface CreateTopicInput {
  forum: Forum;
  viewer: Viewer;
  title: string;
  body: string;
  format?: BodyFormat;
  ip?: string | null;
  bus?: HookBus;
}

export async function createTopic(input: CreateTopicInput): Promise<{ topic: Topic; post: Post }> {
  const settings = await loadSettings();
  const viewer = input.viewer;
  if (!viewer.user) throw new PostError('Sign in to post.', 'forbidden');
  if (input.forum.isLocked) throw new PostError('This forum is locked.', 'locked');

  await checkFlood(viewer.user.id, Number(settings['posts.floodSeconds'] ?? 15));

  const maxTitle = Number(settings['topics.titleMaxLength'] ?? 160);
  let title = input.title.trim().replace(/\s+/g, ' ').slice(0, maxTitle);
  if (title.length < 3) throw new PostError('Give the topic a title.', 'too_short');
  if (input.bus) {
    title = await input.bus.applyFilter('topic:before_save', title, { viewer, forum: input.forum });
  }

  const body = validateBody(input.body, settings);
  const format = (input.format ?? settings['posts.defaultFormat'] ?? 'markdown') as BodyFormat;
  const timestamp = now();
  const slug = await uniqueTopicSlug(input.forum.id, title);

  const topicResult = await run(
    `INSERT INTO topics (forum_id, user_id, title, slug, bumped_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    [input.forum.id, viewer.user.id, title, slug, timestamp, timestamp],
  );
  const topicRow = topicResult.rows[0] as unknown as { id: number };
  const topicId = Number(topicRow.id);

  const post = await insertPost({
    draft: {
      topicId,
      forumId: input.forum.id,
      userId: viewer.user.id,
      replyToId: null,
      body,
      bodyFormat: format,
    },
    viewer,
    ip: input.ip ?? null,
    bus: input.bus,
    position: 0,
  });

  await run('UPDATE topics SET first_post_id = ?, last_post_id = ?, last_post_at = ?, last_poster_id = ? WHERE id = ?', [
    post.id,
    post.id,
    timestamp,
    viewer.user.id,
    topicId,
  ]);
  await recountTopic(topicId);
  await recountForum(input.forum.id);
  await recountUser(viewer.user.id);
  await audit({ userId: viewer.user.id, action: 'topic.create', targetType: 'topic', targetId: topicId, ip: input.ip });

  // The author of a topic is subscribed to it unless they have said otherwise.
  if (settings['notifications.emailEnabled'] !== false) {
    await run(
      `INSERT INTO subscriptions (user_id, target_type, target_id, created_at)
       SELECT ?, 'topic', ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM ignores WHERE user_id = ? AND target_type = 'topic' AND target_id = ?)
       ON CONFLICT DO NOTHING`,
      [viewer.user.id, topicId, timestamp, viewer.user.id, topicId],
    );
  }

  const topic = { ...toTopicShape(topicResult.rows[0] as never), id: topicId } as Topic;
  await input.bus?.emit('topic:created', { topic, forum: input.forum, viewer });
  await input.bus?.emit('post:created', { post, topic, viewer });
  return { topic, post };
}

function toTopicShape(row: Record<string, unknown>): Topic {
  return {
    id: Number(row.id),
    forumId: Number(row.forum_id),
    userId: row.user_id === null ? null : Number(row.user_id),
    title: String(row.title),
    slug: String(row.slug),
    kind: (row.kind as Topic['kind']) ?? 'normal',
    isLocked: row.is_locked === 1,
    isHidden: row.is_hidden === 1,
    isDeleted: row.is_deleted === 1,
    isSolved: row.is_solved === 1,
    viewCount: Number(row.view_count ?? 0),
    replyCount: Number(row.reply_count ?? 0),
    firstPostId: row.first_post_id === null ? null : Number(row.first_post_id),
    lastPostId: row.last_post_id === null ? null : Number(row.last_post_id),
    lastPostAt: row.last_post_at === null ? null : Number(row.last_post_at),
    bumpedAt: Number(row.bumped_at ?? Date.now()),
    createdAt: Number(row.created_at ?? Date.now()),
  };
}

export interface ReplyInput {
  topic: Topic;
  viewer: Viewer;
  body: string;
  format?: BodyFormat;
  replyToId?: Id | null;
  ip?: string | null;
  bus?: HookBus;
}

export async function reply(input: ReplyInput): Promise<Post> {
  const settings = await loadSettings();
  const viewer = input.viewer;
  if (!viewer.user) throw new PostError('Sign in to reply.', 'forbidden');
  if (input.topic.isLocked) throw new PostError('This topic is locked.', 'locked');

  await checkFlood(viewer.user.id, Number(settings['posts.floodSeconds'] ?? 15));
  const body = validateBody(input.body, settings);
  const format = (input.format ?? settings['posts.defaultFormat'] ?? 'markdown') as BodyFormat;

  const last = await one<{ position: number }>(
    'SELECT position FROM posts WHERE topic_id = ? ORDER BY position DESC LIMIT 1',
    [input.topic.id],
  );

  const post = await insertPost({
    draft: {
      topicId: input.topic.id,
      forumId: input.topic.forumId,
      userId: viewer.user.id,
      replyToId: input.replyToId ?? null,
      body,
      bodyFormat: format,
    },
    viewer,
    ip: input.ip ?? null,
    bus: input.bus,
    position: Number(last?.position ?? 0) + 1,
  });

  await run('UPDATE topics SET bumped_at = ? WHERE id = ?', [post.createdAt, input.topic.id]);
  await recountTopic(input.topic.id);
  await recountForum(input.topic.forumId);
  await recountUser(viewer.user.id);
  await audit({ userId: viewer.user.id, action: 'post.create', targetType: 'post', targetId: post.id, ip: input.ip });

  if (settings['notifications.emailEnabled'] !== false) {
    await run(
      `INSERT INTO subscriptions (user_id, target_type, target_id, created_at)
       SELECT ?, 'topic', ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM ignores WHERE user_id = ? AND target_type = 'topic' AND target_id = ?)
       ON CONFLICT DO NOTHING`,
      [viewer.user.id, input.topic.id, post.createdAt, viewer.user.id, input.topic.id],
    );
  }

  await input.bus?.emit('post:created', { post, topic: input.topic, viewer });
  return post;
}

async function insertPost(args: {
  draft: PostDraft;
  viewer: Viewer;
  ip: string | null;
  bus?: HookBus;
  position: number;
}): Promise<Post> {
  let draft = args.draft;
  if (args.bus) {
    // A plugin may rewrite the draft or refuse it outright by throwing. The
    // filter runs before anything is written, so a refusal leaves no trace.
    draft = await args.bus.applyFilter('post:before_save', draft, {
      viewer: args.viewer,
      isEdit: false,
    });
  }

  const result = await run(
    `INSERT INTO posts (topic_id, forum_id, user_id, reply_to_id, body, body_format, position, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      draft.topicId,
      draft.forumId,
      draft.userId,
      draft.replyToId,
      draft.body,
      draft.bodyFormat,
      args.position,
      hashIp(args.ip),
      now(),
    ],
  );
  return toPost(result.rows[0] as unknown as PostRow);
}

export interface EditPostInput {
  post: Post;
  viewer: Viewer;
  body: string;
  reason?: string | null;
  bus?: HookBus;
}

export async function editPost(input: EditPostInput): Promise<Post> {
  const settings = await loadSettings();
  const body = validateBody(input.body, settings);
  const previous = input.post.body;

  // The previous version is kept before the new one lands, so an edit is always
  // recoverable and a moderator can see what was changed.
  await run(
    `INSERT INTO post_revisions (post_id, body, body_format, editor_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.post.id, previous, input.post.bodyFormat, input.viewer.user?.id ?? null, input.reason ?? null, now()],
  );

  const result = await run(
    `UPDATE posts SET body = ?, edit_count = edit_count + 1, edited_at = ?, edited_by = ?, edit_reason = ?
      WHERE id = ? RETURNING *`,
    [body, now(), input.viewer.user?.id ?? null, input.reason ?? null, input.post.id],
  );
  const post = toPost(result.rows[0] as unknown as PostRow);
  await audit({ userId: input.viewer.user?.id ?? null, action: 'post.edit', targetType: 'post', targetId: post.id });
  await input.bus?.emit('post:updated', { post, previousBody: previous, viewer: input.viewer });
  return post;
}

export async function deletePost(postId: Id, viewer: Viewer, bus?: HookBus): Promise<void> {
  const post = await postById(postId, true);
  if (!post) return;
  await run('UPDATE posts SET is_deleted = 1 WHERE id = ?', [postId]);
  await recountTopic(post.topicId);
  await recountForum(post.forumId);
  if (post.userId) await recountUser(post.userId);
  await audit({ userId: viewer.user?.id ?? null, action: 'post.delete', targetType: 'post', targetId: postId });
  await bus?.emit('post:deleted', { postId, topicId: post.topicId, viewer });
}

export async function postById(id: Id, includeHidden = false): Promise<Post | null> {
  const guard = includeHidden ? 'is_deleted = 0' : 'is_deleted = 0 AND is_hidden = 0';
  const row = await one<PostRow>(`SELECT * FROM posts WHERE id = ? AND ${guard}`, [id]);
  return row ? toPost(row) : null;
}

export interface PostWithAuthor extends Post {
  authorName: string | null;
  authorDisplayName: string | null;
  authorAvatarKind: string | null;
  authorAvatarUrl: string | null;
  authorEmail: string | null;
  authorSignature: string | null;
  authorPostCount: number;
  authorTitle: string | null;
  authorCreatedAt: number | null;
  authorIsAdmin: boolean;
  authorIsModerator: boolean;
  reactionCount: number;
  viewerReacted: boolean;
}

export async function listPosts(options: {
  topicId: Id;
  limit?: number;
  offset?: number;
  viewerId?: Id | null;
  includeHidden?: boolean;
}): Promise<PostWithAuthor[]> {
  const guard = options.includeHidden ? 'p.is_deleted = 0' : visiblePost('p');
  const rows = await all<
    PostRow & {
      username: string | null;
      display_name: string | null;
      avatar_kind: string | null;
      avatar_url: string | null;
      email: string | null;
      signature: string | null;
      author_post_count: number | null;
      title: string | null;
      author_created_at: number | null;
      is_admin: number | null;
      is_moderator: number | null;
      reaction_count: number;
      viewer_reacted: number;
    }
  >(
    `SELECT p.*, u.username, u.display_name, u.avatar_kind, u.avatar_url, u.email,
            u.signature, u.post_count AS author_post_count, u.title,
            u.created_at AS author_created_at, u.is_admin, u.is_moderator,
            (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id) AS reaction_count,
            (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.user_id = ?) AS viewer_reacted
       FROM posts p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.topic_id = ? AND ${guard}
      ORDER BY p.position, p.id
      LIMIT ? OFFSET ?`,
    [options.viewerId ?? null, options.topicId, options.limit ?? 20, options.offset ?? 0],
  );

  return rows.map((row) => ({
    ...toPost(row),
    authorName: row.username,
    authorDisplayName: row.display_name,
    authorAvatarKind: row.avatar_kind,
    authorAvatarUrl: row.avatar_url,
    authorEmail: row.email,
    authorSignature: row.signature,
    authorPostCount: Number(row.author_post_count ?? 0),
    authorTitle: row.title,
    authorCreatedAt: row.author_created_at,
    authorIsAdmin: row.is_admin === 1,
    authorIsModerator: row.is_moderator === 1 || row.is_admin === 1,
    reactionCount: Number(row.reaction_count ?? 0),
    viewerReacted: Number(row.viewer_reacted ?? 0) > 0,
  }));
}

/** Which page of a topic a given post falls on, for permalinks. */
export async function pageOfPost(postId: Id, perPage: number): Promise<number> {
  const post = await one<{ topic_id: number; position: number }>(
    'SELECT topic_id, position FROM posts WHERE id = ?',
    [postId],
  );
  if (!post) return 1;
  const before = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM posts
      WHERE topic_id = ? AND is_deleted = 0 AND is_hidden = 0 AND position < ?`,
    [post.topic_id, post.position],
  );
  return Math.floor(Number(before?.n ?? 0) / perPage) + 1;
}

export { extractMentions, render };
