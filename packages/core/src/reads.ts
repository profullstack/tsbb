import { all, now, run } from '@tsbb/db';
import type { Id } from '@tsbb/plugin-api';
import { parentMap } from './permissions.ts';

/**
 * Read state has two layers, and a topic is unread only when both say so.
 *
 * `topic_reads` is per topic and written every time a member opens one. It is
 * exact but it is also a row per topic, so "mark this forum read" cannot be
 * expressed in it without writing one row per topic — on a big forum that is
 * thousands of rows a click. `forum_reads` is the marker: one row per forum
 * saying "everything posted before this instant is read". Both layers are
 * consulted by every listing, so the same predicate is exported from here
 * rather than being spelled out again at each call site and drifting.
 *
 * Every query that uses it must join both tables under these aliases:
 *
 *   LEFT JOIN topic_reads tr ON tr.topic_id = t.id AND tr.user_id = ?
 *   LEFT JOIN forum_reads fr ON fr.forum_id = t.forum_id AND fr.user_id = ?
 */
export const UNREAD_PREDICATE = `t.last_post_id IS NOT NULL
   AND (tr.last_post_id IS NULL OR tr.last_post_id < t.last_post_id)
   AND (fr.read_at IS NULL OR t.last_post_at > fr.read_at)`;

/**
 * How many visible topics this member has not read, per forum.
 *
 * One query for the whole board rather than one per forum, because the board
 * index is the busiest page there is. Forums with nothing unread are absent
 * from the map, so a caller reads `get(id) ?? 0`. A guest has no read state
 * and gets an empty map: an unread badge on every row would be noise.
 */
export async function unreadTopicCounts(
  userId: Id | null,
  forumIds?: Id[],
): Promise<Map<Id, number>> {
  if (userId === null) return new Map();
  if (forumIds && !forumIds.length) return new Map();
  const scope = forumIds ? `AND t.forum_id IN (${forumIds.map(() => '?').join(',')})` : '';
  const rows = await all<{ forum_id: number; n: number }>(
    `SELECT t.forum_id, COUNT(*) AS n
       FROM topics t
       LEFT JOIN topic_reads tr ON tr.topic_id = t.id AND tr.user_id = ?
       LEFT JOIN forum_reads fr ON fr.forum_id = t.forum_id AND fr.user_id = ?
      WHERE t.is_deleted = 0 AND t.is_hidden = 0
        AND ${UNREAD_PREDICATE}
        ${scope}
      GROUP BY t.forum_id`,
    [userId, userId, ...(forumIds ?? [])] as never,
  );
  return new Map(rows.map((row) => [Number(row.forum_id), Number(row.n)]));
}

/**
 * Mark every topic in these forums read for one member, as of now.
 *
 * A marker per forum rather than a row per topic, so the cost is the number of
 * forums, not the number of topics. Anything posted after this instant is
 * unread again, which is what "mark read" has always meant on a board.
 */
export async function markForumsRead(userId: Id, forumIds: Id[]): Promise<void> {
  const at = now();
  for (const forumId of forumIds) {
    await run(
      `INSERT INTO forum_reads (user_id, forum_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, forum_id) DO UPDATE SET read_at = excluded.read_at`,
      [userId, forumId, at],
    );
  }
}

/**
 * A forum and every forum nested under it, however deep.
 *
 * Marking a forum read must cover its subforums, or the parent row stays lit
 * by a child the member never opened. Categories are included because they
 * can hold topics too if an admin turns one into a forum later; a marker on a
 * node with no topics costs one row and changes nothing.
 */
export async function forumWithDescendants(forumId: Id): Promise<Id[]> {
  const parents = await parentMap();
  const children = new Map<Id | null, Id[]>();
  for (const [id, parent] of parents) {
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const ids: Id[] = [];
  const queue: Id[] = [forumId];
  const seen = new Set<Id>();
  while (queue.length) {
    const id = queue.shift() as Id;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return ids;
}
