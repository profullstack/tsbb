import { all } from '@tsbb/db';
import type { Forum, Id, Permissions, Viewer } from '@tsbb/plugin-api';

export const PERMISSION_KEYS = [
  'canView',
  'canRead',
  'canPost',
  'canReply',
  'canEditOwn',
  'canDeleteOwn',
  'canAttach',
  'canPoll',
  'canModerate',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const COLUMN: Record<PermissionKey, string> = {
  canView: 'can_view',
  canRead: 'can_read',
  canPost: 'can_post',
  canReply: 'can_reply',
  canEditOwn: 'can_edit_own',
  canDeleteOwn: 'can_delete_own',
  canAttach: 'can_attach',
  canPoll: 'can_poll',
  canModerate: 'can_moderate',
};

/** What a viewer gets before any group row is consulted. */
export const GUEST_DEFAULTS: Permissions = {
  canView: true,
  canRead: true,
  canPost: false,
  canReply: false,
  canEditOwn: false,
  canDeleteOwn: false,
  canAttach: false,
  canPoll: false,
  canModerate: false,
};

export const MEMBER_DEFAULTS: Permissions = {
  canView: true,
  canRead: true,
  canPost: true,
  canReply: true,
  canEditOwn: true,
  canDeleteOwn: true,
  canAttach: true,
  canPoll: true,
  canModerate: false,
};

export const ALL_ALLOWED: Permissions = {
  canView: true,
  canRead: true,
  canPost: true,
  canReply: true,
  canEditOwn: true,
  canDeleteOwn: true,
  canAttach: true,
  canPoll: true,
  canModerate: true,
};

interface PermissionRow {
  forum_id: number | null;
  group_id: number;
  can_view: number | null;
  can_read: number | null;
  can_post: number | null;
  can_reply: number | null;
  can_edit_own: number | null;
  can_delete_own: number | null;
  can_attach: number | null;
  can_poll: number | null;
  can_moderate: number | null;
}

/**
 * Resolve a viewer's permissions on one forum.
 *
 * Rows are tri-state: 1 allow, 0 deny, NULL inherit. Two rules decide the
 * outcome, and both are the ones phpBB administrators already have in their
 * heads:
 *
 *   more specific wins  — a row on this forum beats one on its parent, which
 *                         beats the board-wide row (forum_id IS NULL).
 *   deny wins ties      — where several of the viewer's groups speak at the
 *                         same level, an explicit 0 beats an explicit 1.
 *
 * The second rule is what makes a "banned from this forum" group work at all:
 * without it, membership of any other group would hand the permission back.
 */
export async function resolvePermissions(
  viewer: Viewer,
  forum: Forum | null,
  ancestry: Id[] = [],
): Promise<Permissions> {
  if (viewer.isAdmin) return { ...ALL_ALLOWED };

  const base = viewer.user ? { ...MEMBER_DEFAULTS } : { ...GUEST_DEFAULTS };
  if (viewer.user?.isBanned) {
    return { ...GUEST_DEFAULTS, canPost: false, canReply: false };
  }
  if (viewer.isModerator) base.canModerate = true;

  if (!viewer.groupIds.length) return base;

  // Levels, least specific first: board-wide, then each ancestor, then the
  // forum itself. Applying them in order means the last write wins, which is
  // exactly "more specific wins".
  const levels: (number | null)[] = [null, ...ancestry];
  if (forum) levels.push(forum.id);

  const groupPlaceholders = viewer.groupIds.map(() => '?').join(',');
  const forumIds = levels.filter((l): l is number => l !== null);
  const forumClause = forumIds.length
    ? `(forum_id IS NULL OR forum_id IN (${forumIds.map(() => '?').join(',')}))`
    : 'forum_id IS NULL';

  const rows = await all<PermissionRow>(
    `SELECT * FROM forum_permissions
      WHERE group_id IN (${groupPlaceholders}) AND ${forumClause}`,
    [...viewer.groupIds, ...forumIds],
  );

  const byLevel = new Map<number | null, PermissionRow[]>();
  for (const row of rows) {
    const list = byLevel.get(row.forum_id) ?? [];
    list.push(row);
    byLevel.set(row.forum_id, list);
  }

  const result = { ...base };
  for (const level of levels) {
    const levelRows = byLevel.get(level);
    if (!levelRows?.length) continue;
    for (const key of PERMISSION_KEYS) {
      const column = COLUMN[key];
      let decision: boolean | null = null;
      for (const row of levelRows) {
        const value = row[column as keyof PermissionRow] as number | null;
        if (value === null || value === undefined) continue;
        if (value === 0) {
          decision = false;
          break; // a deny at this level is final
        }
        decision = true;
      }
      if (decision !== null) result[key] = decision;
    }
  }

  // A moderator's flag is a floor, never something a forum row can take away.
  if (viewer.isModerator) result.canModerate = true;
  return result;
}

/** The ids of every ancestor of a forum, outermost first. */
export async function ancestryOf(forumId: Id, parents?: Map<Id, Id | null>): Promise<Id[]> {
  const map = parents ?? (await parentMap());
  return ancestryFrom(forumId, map);
}

export async function parentMap(): Promise<Map<Id, Id | null>> {
  const rows = await all<{ id: number; parent_id: number | null }>(
    'SELECT id, parent_id FROM forums',
  );
  return new Map(rows.map((r) => [r.id, r.parent_id]));
}

function ancestryFrom(forumId: Id, parents: Map<Id, Id | null>): Id[] {
  const chain: Id[] = [];
  const seen = new Set<Id>([forumId]);
  let current = parents.get(forumId) ?? null;
  while (current !== null && current !== undefined && !seen.has(current)) {
    chain.unshift(current);
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return chain;
}

/**
 * Ids of every forum a viewer may see, for board-wide listings and search.
 *
 * The forum tree is read once and the ancestry of each node computed from that
 * one copy. Resolving each forum independently would re-read the whole table
 * per forum, which is a query per forum on the busiest page on the board.
 */
export async function visibleForumIds(viewer: Viewer): Promise<Id[]> {
  const forums = await all<{ id: number; parent_id: number | null; is_hidden: number }>(
    "SELECT id, parent_id, is_hidden FROM forums WHERE kind = 'forum'",
  );
  if (viewer.isAdmin) return forums.map((f) => f.id);

  const parents = await parentMap();
  const allowed: Id[] = [];
  for (const forum of forums) {
    if (forum.is_hidden === 1 && !viewer.isModerator) continue;
    const perms = await resolvePermissions(
      viewer,
      { id: forum.id, parentId: forum.parent_id } as Forum,
      ancestryFrom(forum.id, parents),
    );
    if (perms.canView && perms.canRead) allowed.push(forum.id);
  }
  return allowed;
}

export function canEditPost(
  viewer: Viewer,
  permissions: Permissions,
  post: { userId: Id | null; createdAt: number },
  editWindowMinutes: number,
): boolean {
  if (permissions.canModerate) return true;
  if (!viewer.user || post.userId !== viewer.user.id) return false;
  if (!permissions.canEditOwn) return false;
  if (editWindowMinutes > 0 && Date.now() - post.createdAt > editWindowMinutes * 60_000) {
    return false;
  }
  return true;
}
