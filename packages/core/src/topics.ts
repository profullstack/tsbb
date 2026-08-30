import { all, now, one, run } from '@tsbb/db';
import type { Id, Topic, Viewer } from '@tsbb/plugin-api';
import { slugify } from './util.ts';

export interface TopicRow {
  id: number;
  forum_id: number;
  user_id: number | null;
  title: string;
  slug: string;
  kind: string;
  is_locked: number;
  is_hidden: number;
  is_deleted: number;
  is_solved: number;
  solved_post_id: number | null;
  view_count: number;
  reply_count: number;
  first_post_id: number | null;
  last_post_id: number | null;
  last_post_at: number | null;
  last_poster_id: number | null;
  moved_to_id: number | null;
  bumped_at: number;
  created_at: number;
}

export function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    forumId: row.forum_id,
    userId: row.user_id,
    title: row.title,
    slug: row.slug,
    kind: (row.kind as Topic['kind']) ?? 'normal',
    isLocked: row.is_locked === 1,
    isHidden: row.is_hidden === 1,
    isDeleted: row.is_deleted === 1,
    isSolved: row.is_solved === 1,
    viewCount: row.view_count,
    replyCount: row.reply_count,
    firstPostId: row.first_post_id,
    lastPostId: row.last_post_id,
    lastPostAt: row.last_post_at,
    bumpedAt: row.bumped_at,
    createdAt: row.created_at,
  };
}

/**
 * Hidden and deleted are two independent flags with different owners: a
 * moderator sets is_hidden, an author sets is_deleted. Every public query must
 * test both, so the guard lives here and is interpolated rather than spelled
 * out at each call site — three read paths in a previous project drifted apart
 * and quietly stopped filtering anything.
 */
export function visibleTopic(alias = 't'): string {
  return `${alias}.is_deleted = 0 AND ${alias}.is_hidden = 0`;
}

export function visiblePost(alias = 'p'): string {
  return `${alias}.is_deleted = 0 AND ${alias}.is_hidden = 0`;
}

export interface TopicListItem extends Topic {
  authorName: string | null;
  authorId: Id | null;
  lastPosterName: string | null;
  lastPosterId: Id | null;
  unread: boolean;
  hasPoll: boolean;
}

export interface ListTopicsOptions {
  forumId?: Id;
  forumIds?: Id[];
  userId?: Id;
  limit?: number;
  offset?: number;
  viewerId?: Id | null;
  includeHidden?: boolean;
  order?: 'recent' | 'created' | 'replies';
}

export async function listTopics(options: ListTopicsOptions = {}): Promise<TopicListItem[]> {
  const where: string[] = [];
  const args: unknown[] = [];

  if (!options.includeHidden) where.push(visibleTopic('t'));
  else where.push('t.is_deleted = 0');

  if (options.forumId !== undefined) {
    where.push('t.forum_id = ?');
    args.push(options.forumId);
  }
  if (options.forumIds) {
    if (!options.forumIds.length) return [];
    where.push(`t.forum_id IN (${options.forumIds.map(() => '?').join(',')})`);
    args.push(...options.forumIds);
  }
  if (options.userId !== undefined) {
    where.push('t.user_id = ?');
    args.push(options.userId);
  }

  const order =
    options.order === 'created'
      ? 't.created_at DESC'
      : options.order === 'replies'
        ? 't.reply_count DESC'
        : 't.bumped_at DESC';

  // Announcements and stickies float, in that order, then the chosen sort.
  const kindRank = `CASE t.kind WHEN 'global' THEN 0 WHEN 'announcement' THEN 1 WHEN 'sticky' THEN 2 ELSE 3 END`;

  const viewerId = options.viewerId ?? null;
  const rows = await all<TopicRow & {
    author_name: string | null;
    last_poster_name: string | null;
    last_read_post_id: number | null;
    poll_id: number | null;
  }>(
    `SELECT t.*, ua.username AS author_name, ul.username AS last_poster_name,
            tr.last_post_id AS last_read_post_id, pl.id AS poll_id
       FROM topics t
       LEFT JOIN users ua ON ua.id = t.user_id
       LEFT JOIN users ul ON ul.id = t.last_poster_id
       LEFT JOIN topic_reads tr ON tr.topic_id = t.id AND tr.user_id = ?
       LEFT JOIN polls pl ON pl.topic_id = t.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${kindRank}, ${order}
      LIMIT ? OFFSET ?`,
    [viewerId, ...args, options.limit ?? 30, options.offset ?? 0],
  );

  return rows.map((row) => ({
    ...toTopic(row),
    authorId: row.user_id,
    authorName: row.author_name,
    lastPosterId: row.last_poster_id,
    lastPosterName: row.last_poster_name,
    // A guest has no read state, so nothing is ever marked unread for them —
    // an unread badge on every row is noise, not information.
    unread:
      viewerId !== null &&
      row.last_post_id !== null &&
      (row.last_read_post_id === null || row.last_read_post_id < row.last_post_id),
    hasPoll: row.poll_id !== null,
  }));
}

export async function countTopics(options: ListTopicsOptions = {}): Promise<number> {
  const where: string[] = [options.includeHidden ? 't.is_deleted = 0' : visibleTopic('t')];
  const args: unknown[] = [];
  if (options.forumId !== undefined) {
    where.push('t.forum_id = ?');
    args.push(options.forumId);
  }
  if (options.forumIds) {
    if (!options.forumIds.length) return 0;
    where.push(`t.forum_id IN (${options.forumIds.map(() => '?').join(',')})`);
    args.push(...options.forumIds);
  }
  if (options.userId !== undefined) {
    where.push('t.user_id = ?');
    args.push(options.userId);
  }
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM topics t WHERE ${where.join(' AND ')}`,
    args as never,
  );
  return Number(row?.n ?? 0);
}

export async function topicById(id: Id, includeHidden = false): Promise<Topic | null> {
  const guard = includeHidden ? 'is_deleted = 0' : 'is_deleted = 0 AND is_hidden = 0';
  const row = await one<TopicRow>(`SELECT * FROM topics WHERE id = ? AND ${guard}`, [id]);
  return row ? toTopic(row) : null;
}

export async function topicBySlug(
  forumId: Id,
  slug: string,
  includeHidden = false,
): Promise<Topic | null> {
  const guard = includeHidden ? 'is_deleted = 0' : 'is_deleted = 0 AND is_hidden = 0';
  const row = await one<TopicRow>(
    `SELECT * FROM topics WHERE forum_id = ? AND slug = ? AND ${guard}`,
    [forumId, slug],
  );
  return row ? toTopic(row) : null;
}

export async function uniqueTopicSlug(forumId: Id, title: string): Promise<string> {
  const base = slugify(title, 'topic');
  let candidate = base;
  for (let i = 2; i < 500; i += 1) {
    const clash = await one<{ id: number }>(
      'SELECT id FROM topics WHERE forum_id = ? AND slug = ?',
      [forumId, candidate],
    );
    if (!clash) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * A view is counted once per viewer per topic per hour, tracked in the read
 * state that already exists. Counting every request makes the number a measure
 * of how often somebody refreshed.
 */
export async function recordView(topicId: Id, viewerId: Id | null): Promise<void> {
  if (viewerId === null) {
    await run('UPDATE topics SET view_count = view_count + 1 WHERE id = ?', [topicId]);
    return;
  }
  const seen = await one<{ read_at: number }>(
    'SELECT read_at FROM topic_reads WHERE user_id = ? AND topic_id = ?',
    [viewerId, topicId],
  );
  if (!seen || now() - Number(seen.read_at) > 3_600_000) {
    await run('UPDATE topics SET view_count = view_count + 1 WHERE id = ?', [topicId]);
  }
}

export async function markRead(topicId: Id, userId: Id, lastPostId: Id): Promise<void> {
  await run(
    `INSERT INTO topic_reads (user_id, topic_id, last_post_id, read_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, topic_id) DO UPDATE SET
       last_post_id = MAX(excluded.last_post_id, topic_reads.last_post_id),
       read_at = excluded.read_at`,
    [userId, topicId, lastPostId, now()],
  );
}

export async function recountTopic(topicId: Id): Promise<void> {
  await run(
    `UPDATE topics SET
       reply_count = MAX(0, (SELECT COUNT(*) FROM posts WHERE topic_id = ? AND is_deleted = 0 AND is_hidden = 0) - 1),
       first_post_id = (SELECT id FROM posts WHERE topic_id = ? AND is_deleted = 0 ORDER BY position, id LIMIT 1),
       last_post_id  = (SELECT id FROM posts WHERE topic_id = ? AND is_deleted = 0 AND is_hidden = 0 ORDER BY position DESC, id DESC LIMIT 1),
       last_post_at  = (SELECT created_at FROM posts WHERE topic_id = ? AND is_deleted = 0 AND is_hidden = 0 ORDER BY position DESC, id DESC LIMIT 1),
       last_poster_id = (SELECT user_id FROM posts WHERE topic_id = ? AND is_deleted = 0 AND is_hidden = 0 ORDER BY position DESC, id DESC LIMIT 1)
     WHERE id = ?`,
    [topicId, topicId, topicId, topicId, topicId, topicId],
  );
}

export async function setTopicFlags(
  topicId: Id,
  flags: Partial<{ isLocked: boolean; isHidden: boolean; kind: Topic['kind']; isSolved: boolean; solvedPostId: Id | null }>,
): Promise<void> {
  const columns: Record<string, string> = {
    isLocked: 'is_locked',
    isHidden: 'is_hidden',
    kind: 'kind',
    isSolved: 'is_solved',
    solvedPostId: 'solved_post_id',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in flags)) continue;
    const value = (flags as Record<string, unknown>)[key];
    sets.push(`${column} = ?`);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null));
  }
  if (!sets.length) return;
  values.push(topicId);
  await run(`UPDATE topics SET ${sets.join(', ')} WHERE id = ?`, values as never);
}

export async function isSubscribed(userId: Id, topicId: Id): Promise<boolean> {
  const row = await one<{ user_id: number }>(
    "SELECT user_id FROM subscriptions WHERE user_id = ? AND target_type = 'topic' AND target_id = ?",
    [userId, topicId],
  );
  return row !== null;
}

export async function setSubscribed(userId: Id, topicId: Id, on: boolean): Promise<void> {
  if (on) {
    await run(
      `INSERT INTO subscriptions (user_id, target_type, target_id, created_at)
       VALUES (?, 'topic', ?, ?) ON CONFLICT DO NOTHING`,
      [userId, topicId, now()],
    );
    await run(
      "DELETE FROM ignores WHERE user_id = ? AND target_type = 'topic' AND target_id = ?",
      [userId, topicId],
    );
  } else {
    await run(
      "DELETE FROM subscriptions WHERE user_id = ? AND target_type = 'topic' AND target_id = ?",
      [userId, topicId],
    );
    // Unsubscribing is also a statement of intent: auto-subscribe must not put
    // the user straight back in the next time they reply.
    await run(
      `INSERT INTO ignores (user_id, target_type, target_id, created_at)
       VALUES (?, 'topic', ?, ?) ON CONFLICT DO NOTHING`,
      [userId, topicId, now()],
    );
  }
}
