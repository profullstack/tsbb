import { all, toFtsQuery } from '@tsbb/db';
import type { Id, Viewer } from '@tsbb/plugin-api';
import { highlight } from '@tsbb/markup';
import { visibleForumIds } from './permissions.ts';

export interface SearchHit {
  postId: Id;
  topicId: Id;
  forumId: Id;
  userId: Id | null;
  title: string;
  slug: string;
  snippet: string;
  username: string | null;
  email: string | null;
  avatarKind: string | null;
  avatarUrl: string | null;
  createdAt: number;
  score: number;
}

/**
 * Search over post bodies, scoped to the forums this viewer may read.
 *
 * Two things about ranking. Results are ordered by `bm25()` directly rather
 * than by a `rank` column — bm25 lets the title be weighted above the body,
 * which is what makes searching for a topic's name find that topic rather than
 * every post that mentions it. And bm25 returns a *negative* score where more
 * relevant is more negative, so ascending order is the relevant one.
 */
export async function searchPosts(input: {
  query: string;
  viewer: Viewer;
  limit?: number;
  offset?: number;
  forumId?: Id;
  userId?: Id;
}): Promise<{ hits: SearchHit[]; terms: string[] }> {
  const match = toFtsQuery(input.query);
  if (!match) return { hits: [], terms: [] };

  const allowed = input.forumId ? [input.forumId] : await visibleForumIds(input.viewer);
  if (!allowed.length) return { hits: [], terms: [] };

  const args: unknown[] = [match, ...allowed];
  let userClause = '';
  if (input.userId !== undefined) {
    userClause = 'AND f.user_id = ?';
    args.push(input.userId);
  }
  args.push(input.limit ?? 25, input.offset ?? 0);

  const rows = await all<{
    post_id: number;
    topic_id: number;
    forum_id: number;
    user_id: number | null;
    title: string;
    slug: string;
    body: string;
    username: string | null;
    email: string | null;
    avatar_kind: string | null;
    avatar_url: string | null;
    created_at: number;
    score: number;
  }>(
    `SELECT f.post_id, f.topic_id, f.forum_id, f.user_id,
            t.title, t.slug, p.body, u.username,
            u.email, u.avatar_kind, u.avatar_url, p.created_at,
            bm25(posts_fts, 8.0, 1.0) AS score
       FROM posts_fts f
       JOIN posts p ON p.id = f.post_id
       JOIN topics t ON t.id = f.topic_id
       LEFT JOIN users u ON u.id = f.user_id
      WHERE posts_fts MATCH ?
        AND f.forum_id IN (${allowed.map(() => '?').join(',')})
        ${userClause}
        AND p.is_deleted = 0 AND p.is_hidden = 0
        AND t.is_deleted = 0 AND t.is_hidden = 0
      ORDER BY score
      LIMIT ? OFFSET ?`,
    args as never,
  );

  const terms = match.replace(/"/g, '').split(' AND ').map((t) => t.replace(/\*$/, ''));

  return {
    hits: rows.map((row) => ({
      postId: row.post_id,
      topicId: row.topic_id,
      forumId: row.forum_id,
      userId: row.user_id,
      title: row.title,
      slug: row.slug,
      snippet: highlight(snippetAround(row.body, terms), terms),
      username: row.username,
      email: row.email,
      avatarKind: row.avatar_kind,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      score: Number(row.score ?? 0),
    })),
    terms,
  };
}

/** A window of the body around the first matching term, so a hit shows context. */
function snippetAround(body: string, terms: string[], width = 220): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return flat.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const slice = flat.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${slice}${start + width < flat.length ? '…' : ''}`;
}

export async function searchUsers(query: string, limit = 10): Promise<
  { id: Id; username: string; displayName: string | null }[]
> {
  const match = toFtsQuery(query);
  if (!match) return [];
  const rows = await all<{ user_id: number; username: string; display_name: string | null }>(
    `SELECT f.user_id, u.username, u.display_name
       FROM users_fts f
       JOIN users u ON u.id = f.user_id
      WHERE users_fts MATCH ? AND u.is_deleted = 0
      ORDER BY bm25(users_fts) LIMIT ?`,
    [match, limit],
  );
  return rows.map((r) => ({ id: r.user_id, username: r.username, displayName: r.display_name }));
}
