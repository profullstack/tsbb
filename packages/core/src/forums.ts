import { all, now, one, run } from '@tsbb/db';
import type { Forum, Id, MemberPosting, Viewer } from '@tsbb/plugin-api';
import { ancestryOf, parentMap, resolvePermissions } from './permissions.ts';
import { unreadTopicCounts } from './reads.ts';
import { slugify } from './util.ts';

export interface ForumRow {
  id: number;
  parent_id: number | null;
  kind: string;
  slug: string;
  name: string;
  description: string | null;
  link_url: string | null;
  icon: string | null;
  colour: string | null;
  position: number;
  is_locked: number;
  is_hidden: number;
  member_posting: string;
  topic_count: number;
  post_count: number;
  last_post_id: number | null;
  last_post_at: number | null;
  created_at: number;
}

export const MEMBER_POSTING: MemberPosting[] = ['topics', 'replies', 'none'];

export function isMemberPosting(value: unknown): value is MemberPosting {
  return typeof value === 'string' && (MEMBER_POSTING as string[]).includes(value);
}

export function toForum(row: ForumRow): Forum {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: (row.kind as Forum['kind']) ?? 'forum',
    slug: row.slug,
    name: row.name,
    description: row.description,
    linkUrl: row.link_url,
    icon: row.icon,
    colour: row.colour,
    position: row.position,
    isLocked: row.is_locked === 1,
    isHidden: row.is_hidden === 1,
    memberPosting: isMemberPosting(row.member_posting) ? row.member_posting : 'topics',
    topicCount: row.topic_count,
    postCount: row.post_count,
    lastPostAt: row.last_post_at,
  };
}

export interface ForumNode extends Forum {
  children: ForumNode[];
  lastPost: LastPost | null;
  /**
   * Unread topics in this forum and everything nested under it, for the
   * viewer the tree was built for. Always 0 for a guest, who has no read
   * state to be behind on.
   */
  unreadCount: number;
  unread: boolean;
}

export interface LastPost {
  postId: Id;
  topicId: Id;
  topicTitle: string;
  topicSlug: string;
  createdAt: number;
  authorId: Id | null;
  authorName: string | null;
}

export async function allForums(): Promise<Forum[]> {
  const rows = await all<ForumRow>('SELECT * FROM forums ORDER BY position, id');
  return rows.map(toForum);
}

export async function forumBySlug(slug: string): Promise<Forum | null> {
  const row = await one<ForumRow>('SELECT * FROM forums WHERE slug = ?', [slug]);
  return row ? toForum(row) : null;
}

export async function forumById(id: Id): Promise<Forum | null> {
  const row = await one<ForumRow>('SELECT * FROM forums WHERE id = ?', [id]);
  return row ? toForum(row) : null;
}

/**
 * The board index: the whole forum tree, filtered to what this viewer may see,
 * with each node's last post attached.
 *
 * The tree is read once and permissions resolved against one in-memory copy of
 * the parent map. A category whose every child is invisible is dropped, because
 * an empty category heading tells a visitor only that there is something they
 * cannot have.
 */
export async function forumTree(viewer: Viewer): Promise<ForumNode[]> {
  const rows = await all<ForumRow>('SELECT * FROM forums ORDER BY position, id');
  const parents = await parentMap();
  const [lastPosts, unread] = await Promise.all([
    lastPostsByForum(),
    unreadTopicCounts(viewer.user?.id ?? null),
  ]);

  const visible: ForumNode[] = [];
  for (const row of rows) {
    if (row.is_hidden === 1 && !viewer.isModerator && !viewer.isAdmin) continue;
    const forum = toForum(row);
    if (forum.kind === 'forum') {
      const perms = await resolvePermissions(viewer, forum, await ancestryOf(forum.id, parents));
      if (!perms.canView) continue;
    }
    const unreadCount = unread.get(forum.id) ?? 0;
    visible.push({
      ...forum,
      children: [],
      lastPost: lastPosts.get(forum.id) ?? null,
      unreadCount,
      unread: unreadCount > 0,
    });
  }

  const byId = new Map(visible.map((node) => [node.id, node]));
  const roots: ForumNode[] = [];
  for (const node of visible) {
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (parent) parent.children.push(node);
    else if (node.parentId === null) roots.push(node);
    // A node whose parent was filtered out is dropped with it, rather than
    // being promoted to the top level where it would escape its restriction.
  }

  // Unread rolls up: a category is lit when any forum under it is, so the
  // index answers "is there anything new down there?" without a click. Only
  // forums that survived the permission filter contribute, so a member is
  // never told about activity in a forum they cannot open.
  const prune = (nodes: ForumNode[]): ForumNode[] =>
    nodes
      .map((node) => {
        const children = prune(node.children);
        const unreadCount = children.reduce((sum, child) => sum + child.unreadCount, node.unreadCount);
        return { ...node, children, unreadCount, unread: unreadCount > 0 };
      })
      .filter((node) => node.kind !== 'category' || node.children.length > 0);

  return prune(roots);
}

/** Unread topics across every forum in the tree — the number on the board's "mark all read". */
export function unreadInTree(nodes: ForumNode[]): number {
  return nodes.reduce((sum, node) => sum + node.unreadCount, 0);
}

async function lastPostsByForum(): Promise<Map<Id, LastPost>> {
  const rows = await all<{
    forum_id: number;
    post_id: number;
    topic_id: number;
    title: string;
    slug: string;
    created_at: number;
    user_id: number | null;
    username: string | null;
  }>(
    `SELECT f.id AS forum_id, p.id AS post_id, t.id AS topic_id, t.title, t.slug,
            p.created_at, p.user_id, u.username
       FROM forums f
       JOIN posts p ON p.id = f.last_post_id
       JOIN topics t ON t.id = p.topic_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE t.is_deleted = 0 AND p.is_deleted = 0`,
  );
  return new Map(
    rows.map((r) => [
      r.forum_id,
      {
        postId: r.post_id,
        topicId: r.topic_id,
        topicTitle: r.title,
        topicSlug: r.slug,
        createdAt: r.created_at,
        authorId: r.user_id,
        authorName: r.username,
      },
    ]),
  );
}

export async function createForum(input: {
  name: string;
  parentId?: Id | null;
  kind?: Forum['kind'];
  description?: string;
  position?: number;
  slug?: string;
  memberPosting?: MemberPosting;
}): Promise<Forum> {
  const slug = await uniqueForumSlug(input.slug ?? slugify(input.name, 'forum'));
  const result = await run(
    `INSERT INTO forums (parent_id, kind, slug, name, description, position, member_posting, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      input.parentId ?? null,
      input.kind ?? 'forum',
      slug,
      input.name,
      input.description ?? null,
      input.position ?? 0,
      isMemberPosting(input.memberPosting) ? input.memberPosting : 'topics',
      now(),
    ],
  );
  return toForum(result.rows[0] as unknown as ForumRow);
}

/** Change what an administrator may change about a forum after it exists. */
export async function updateForum(
  id: Id,
  patch: Partial<{
    name: string;
    description: string | null;
    position: number;
    isLocked: boolean;
    isHidden: boolean;
    memberPosting: MemberPosting;
  }>,
): Promise<Forum | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    values.push(patch.description);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    values.push(patch.position);
  }
  if (patch.isLocked !== undefined) {
    sets.push('is_locked = ?');
    values.push(patch.isLocked ? 1 : 0);
  }
  if (patch.isHidden !== undefined) {
    sets.push('is_hidden = ?');
    values.push(patch.isHidden ? 1 : 0);
  }
  if (patch.memberPosting !== undefined && isMemberPosting(patch.memberPosting)) {
    sets.push('member_posting = ?');
    values.push(patch.memberPosting);
  }
  if (sets.length) {
    values.push(id);
    await run(`UPDATE forums SET ${sets.join(', ')} WHERE id = ?`, values as never);
  }
  return forumById(id);
}

async function uniqueForumSlug(base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; i < 200; i += 1) {
    const clash = await one<{ id: number }>('SELECT id FROM forums WHERE slug = ?', [candidate]);
    if (!clash) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Recompute a forum's counters and last post from its rows.
 *
 * Derived rather than incremented: a hidden, deleted or moved topic takes its
 * contribution with it, and a counter can never drift permanently out of step
 * with what is actually on the page.
 */
export async function recountForum(forumId: Id): Promise<void> {
  await run(
    `UPDATE forums SET
       topic_count = (SELECT COUNT(*) FROM topics WHERE forum_id = ? AND is_deleted = 0 AND is_hidden = 0),
       post_count  = (SELECT COUNT(*) FROM posts  WHERE forum_id = ? AND is_deleted = 0 AND is_hidden = 0),
       last_post_id = (
         SELECT p.id FROM posts p
           JOIN topics t ON t.id = p.topic_id
          WHERE p.forum_id = ? AND p.is_deleted = 0 AND p.is_hidden = 0
            AND t.is_deleted = 0 AND t.is_hidden = 0
          ORDER BY p.created_at DESC LIMIT 1
       ),
       last_post_at = (
         SELECT p.created_at FROM posts p
           JOIN topics t ON t.id = p.topic_id
          WHERE p.forum_id = ? AND p.is_deleted = 0 AND p.is_hidden = 0
            AND t.is_deleted = 0 AND t.is_hidden = 0
          ORDER BY p.created_at DESC LIMIT 1
       )
     WHERE id = ?`,
    [forumId, forumId, forumId, forumId, forumId],
  );
}

/** Breadcrumb trail for a forum, outermost first, including the forum itself. */
export async function breadcrumb(forumId: Id): Promise<Forum[]> {
  const parents = await parentMap();
  const ids = [...(await ancestryOf(forumId, parents)), forumId];
  const rows = await all<ForumRow>(
    `SELECT * FROM forums WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.id, toForum(r)]));
  return ids.map((id) => byId.get(id)).filter((f): f is Forum => Boolean(f));
}
