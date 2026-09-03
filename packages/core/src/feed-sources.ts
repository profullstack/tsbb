import { all, now, one, run } from '@tsbb/db';
import type { HookBus } from '@tsbb/plugin-host';
import type { Id, Viewer } from '@tsbb/plugin-api';
import { htmlToText, parseFeed, type FeedItem } from './feed-parser.ts';
import { forumById } from './forums.ts';
import { notifyNewPost } from './notifications.ts';
import { createTopic, PostError } from './posts.ts';
import { loadSettings } from './settings.ts';
import { userById } from './users.ts';
import { clamp } from './util.ts';

/**
 * Feed sources: an RSS or Atom feed that fills a forum with topics.
 *
 * The worker polls whatever is due; an administrator can also fetch one on
 * demand from the forum's admin page. Every item a feed has ever shown us is
 * remembered by guid, so a feed that republishes, reorders or pads its items
 * never posts the same story twice — and the first fetch of a long feed posts
 * only the newest few, recording the rest as already seen.
 */

export const FEED_FETCH_TIMEOUT_MS = 15_000;
export const FEED_MAX_BYTES = 5_000_000;
export const FEED_MIN_INTERVAL_MINUTES = 5;
export const FEED_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const FEED_MAX_ITEMS_CAP = 100;
/** Body text beyond this is cut; the link to the original carries the rest. */
const EXCERPT_LENGTH = 4_000;

export interface FeedSource {
  id: Id;
  forumId: Id;
  userId: Id | null;
  url: string;
  title: string | null;
  isEnabled: boolean;
  intervalMinutes: number;
  maxItems: number;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number | null;
  nextFetchAt: number | null;
  lastStatus: 'ok' | 'unchanged' | 'error' | null;
  lastError: string | null;
  itemCount: number;
  createdAt: number;
  /** The posting account's name, or null when that account is gone. */
  postAs: string | null;
}

interface FeedSourceRow {
  id: number;
  forum_id: number;
  user_id: number | null;
  url: string;
  title: string | null;
  is_enabled: number;
  interval_minutes: number;
  max_items: number;
  etag: string | null;
  last_modified: string | null;
  fetched_at: number | null;
  next_fetch_at: number | null;
  last_status: string | null;
  last_error: string | null;
  item_count: number;
  created_at: number;
  post_as: string | null;
}

function toFeedSource(row: FeedSourceRow): FeedSource {
  const status = row.last_status;
  return {
    id: row.id,
    forumId: row.forum_id,
    userId: row.user_id,
    url: row.url,
    title: row.title,
    isEnabled: row.is_enabled === 1,
    intervalMinutes: row.interval_minutes,
    maxItems: row.max_items,
    etag: row.etag,
    lastModified: row.last_modified,
    fetchedAt: row.fetched_at,
    nextFetchAt: row.next_fetch_at,
    lastStatus: status === 'ok' || status === 'unchanged' || status === 'error' ? status : null,
    lastError: row.last_error,
    itemCount: row.item_count,
    createdAt: row.created_at,
    postAs: row.post_as,
  };
}

const SELECT = `SELECT s.*, u.username AS post_as
                  FROM feed_sources s
                  LEFT JOIN users u ON u.id = s.user_id AND u.is_deleted = 0`;

export async function listFeedSources(forumId?: Id): Promise<FeedSource[]> {
  const rows =
    forumId === undefined
      ? await all<FeedSourceRow>(`${SELECT} ORDER BY s.forum_id, s.id`)
      : await all<FeedSourceRow>(`${SELECT} WHERE s.forum_id = ? ORDER BY s.id`, [forumId]);
  return rows.map(toFeedSource);
}

export async function feedSourceById(id: Id): Promise<FeedSource | null> {
  const row = await one<FeedSourceRow>(`${SELECT} WHERE s.id = ?`, [id]);
  return row ? toFeedSource(row) : null;
}

/** How many sources each forum has, for the forums table. */
export async function feedSourceCounts(): Promise<Map<Id, number>> {
  const rows = await all<{ forum_id: number; n: number }>(
    'SELECT forum_id, COUNT(*) AS n FROM feed_sources GROUP BY forum_id',
  );
  return new Map(rows.map((r) => [r.forum_id, Number(r.n)]));
}

export class FeedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedSourceError';
  }
}

/** Only http(s), and only something the URL parser accepts. */
export function normaliseFeedUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new FeedSourceError('That is not a URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FeedSourceError('A feed URL starts with http:// or https://.');
  }
  url.hash = '';
  return url.toString();
}

export async function createFeedSource(input: {
  forumId: Id;
  url: string;
  userId: Id;
  intervalMinutes?: number;
  maxItems?: number;
  createdBy?: Id | null;
}): Promise<FeedSource> {
  const forum = await forumById(input.forumId);
  if (!forum || forum.kind !== 'forum')
    throw new FeedSourceError('Feeds fill a forum, not a category.');
  const url = normaliseFeedUrl(input.url);
  const clash = await one<{ id: number }>(
    'SELECT id FROM feed_sources WHERE forum_id = ? AND url = ?',
    [forum.id, url],
  );
  if (clash) throw new FeedSourceError('That feed is already on this forum.');

  const timestamp = now();
  const result = await run(
    `INSERT INTO feed_sources
       (forum_id, user_id, url, interval_minutes, max_items, next_fetch_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      forum.id,
      input.userId,
      url,
      clamp(input.intervalMinutes ?? 30, FEED_MIN_INTERVAL_MINUTES, FEED_MAX_INTERVAL_MINUTES),
      clamp(input.maxItems ?? 10, 1, FEED_MAX_ITEMS_CAP),
      timestamp, // due now: the first fetch happens on the worker's next tick
      input.createdBy ?? null,
      timestamp,
    ],
  );
  const id = Number((result.rows[0] as unknown as { id: number }).id);
  return (await feedSourceById(id)) as FeedSource;
}

export async function updateFeedSource(
  id: Id,
  patch: Partial<{ isEnabled: boolean; intervalMinutes: number; maxItems: number; userId: Id }>,
): Promise<FeedSource | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.isEnabled !== undefined) {
    sets.push('is_enabled = ?');
    values.push(patch.isEnabled ? 1 : 0);
    if (patch.isEnabled) {
      // Re-enabling is a request to catch up, not to wait out the old schedule.
      sets.push('next_fetch_at = ?');
      values.push(now());
    }
  }
  if (patch.intervalMinutes !== undefined) {
    sets.push('interval_minutes = ?');
    values.push(clamp(patch.intervalMinutes, FEED_MIN_INTERVAL_MINUTES, FEED_MAX_INTERVAL_MINUTES));
  }
  if (patch.maxItems !== undefined) {
    sets.push('max_items = ?');
    values.push(clamp(patch.maxItems, 1, FEED_MAX_ITEMS_CAP));
  }
  if (patch.userId !== undefined) {
    sets.push('user_id = ?');
    values.push(patch.userId);
  }
  if (sets.length) {
    values.push(id);
    await run(`UPDATE feed_sources SET ${sets.join(', ')} WHERE id = ?`, values as never);
  }
  return feedSourceById(id);
}

export async function deleteFeedSource(id: Id): Promise<void> {
  // The topics it posted stay: they are the forum's content now, not the feed's.
  await run('DELETE FROM feed_sources WHERE id = ?', [id]);
}

export interface FetchResult {
  status: 'ok' | 'unchanged' | 'error';
  /** Topics created by this fetch. */
  added: number;
  error?: string;
}

export interface FetchOptions {
  baseUrl: string;
  bus?: HookBus;
  /** Swapped in by tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch one source now, whether or not it is due, and post what is new.
 *
 * Every outcome is written back to the row — status, error, the next due
 * time — so the admin page always shows what happened last, and a source that
 * errors keeps its schedule rather than being retried on every tick.
 */
export async function fetchFeedSource(
  source: FeedSource,
  options: FetchOptions,
): Promise<FetchResult> {
  const startedAt = now();
  const settle = async (result: FetchResult, extra: Record<string, unknown> = {}) => {
    await run(
      `UPDATE feed_sources SET
         fetched_at = ?, next_fetch_at = ?, last_status = ?, last_error = ?,
         item_count = item_count + ?,
         title = COALESCE(?, title), etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified)
       WHERE id = ?`,
      [
        startedAt,
        startedAt + source.intervalMinutes * 60_000,
        result.status,
        result.error ?? null,
        result.added,
        (extra.title as string | null | undefined) ?? null,
        (extra.etag as string | null | undefined) ?? null,
        (extra.lastModified as string | null | undefined) ?? null,
        source.id,
      ],
    );
    return result;
  };

  const user = source.userId === null ? null : await userById(source.userId);
  if (!user || user.isBanned) {
    return settle({
      status: 'error',
      added: 0,
      error: 'The posting account is gone or banned. Choose another.',
    });
  }
  const forum = await forumById(source.forumId);
  if (!forum || forum.kind !== 'forum') {
    return settle({ status: 'error', added: 0, error: 'The forum no longer exists.' });
  }
  if (forum.isLocked) {
    return settle({ status: 'error', added: 0, error: 'The forum is locked.' });
  }

  let text: string;
  let etag: string | null = null;
  let lastModified: string | null = null;
  try {
    const headers: Record<string, string> = {
      accept:
        'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      'user-agent': `tsbb (+${options.baseUrl})`,
    };
    if (source.etag) headers['if-none-match'] = source.etag;
    if (source.lastModified) headers['if-modified-since'] = source.lastModified;

    const response = await (options.fetchImpl ?? fetch)(source.url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    });
    if (response.status === 304) return settle({ status: 'unchanged', added: 0 });
    if (!response.ok) {
      return settle({
        status: 'error',
        added: 0,
        error: `The feed answered HTTP ${response.status}.`,
      });
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > FEED_MAX_BYTES) {
      return settle({ status: 'error', added: 0, error: 'The feed is larger than 5 MB.' });
    }
    text = await response.text();
    if (text.length > FEED_MAX_BYTES) {
      return settle({ status: 'error', added: 0, error: 'The feed is larger than 5 MB.' });
    }
    etag = response.headers.get('etag');
    lastModified = response.headers.get('last-modified');
  } catch (error) {
    const reason =
      (error as Error).name === 'TimeoutError'
        ? 'The feed took too long to answer.'
        : (error as Error).message;
    return settle({ status: 'error', added: 0, error: reason });
  }

  const feed = parseFeed(text);
  if (!feed) {
    return settle({ status: 'error', added: 0, error: 'That URL is not an RSS or Atom feed.' });
  }

  const seen = new Set(
    (
      await all<{ guid: string }>('SELECT guid FROM feed_items WHERE source_id = ?', [source.id])
    ).map((r) => r.guid),
  );
  const fresh = feed.items.filter((item) => !seen.has(item.guid));

  // Newest first, with document order as the tiebreak: a feed lists its newest
  // item first, and a feed without dates is trusted to.
  const ordered = fresh
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.publishedAt ?? 0) - (a.item.publishedAt ?? 0) || a.index - b.index)
    .map((entry) => entry.item);
  const toPost = ordered.slice(0, source.maxItems);
  const toSkip = ordered.slice(source.maxItems);

  const timestamp = now();
  for (const item of toSkip) {
    await rememberItem(source.id, item, null, timestamp);
  }

  const viewer: Viewer = {
    user,
    groupIds: [],
    isAdmin: user.isAdmin,
    isModerator: user.isModerator,
    viaToken: false,
  };
  let added = 0;
  // Oldest first, so the newest story is the one bumped to the top.
  for (const item of toPost.reverse()) {
    try {
      const { topic, post } = await createTopic({
        forum,
        viewer,
        title: topicTitle(item),
        body: topicBody(item, feed.title),
        format: 'markdown',
        origin: 'feed',
        bus: options.bus,
      });
      await rememberItem(source.id, item, topic.id, timestamp);
      await notifyNewPost({ post, topic, viewer, baseUrl: options.baseUrl, bus: options.bus });
      added += 1;
    } catch (error) {
      // A story the board refuses (a plugin rejected it, say) is remembered so
      // it is not offered again on every fetch; anything else is a real fault.
      if (error instanceof PostError) {
        await rememberItem(source.id, item, null, timestamp);
        continue;
      }
      return settle(
        { status: 'error', added, error: (error as Error).message },
        { title: feed.title },
      );
    }
  }

  return settle({ status: 'ok', added }, { title: feed.title, etag, lastModified });
}

async function rememberItem(sourceId: Id, item: FeedItem, topicId: Id | null, timestamp: number) {
  await run(
    `INSERT INTO feed_items (source_id, guid, topic_id, link, published_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (source_id, guid) DO NOTHING`,
    [sourceId, item.guid, topicId, item.link, item.publishedAt, timestamp],
  );
}

export function topicTitle(item: FeedItem): string {
  const title = htmlToText(item.title).replace(/\s+/g, ' ').trim();
  if (title) return title;
  const fromBody =
    htmlToText(item.summary ?? item.content)
      .split('\n')[0]
      ?.trim() ?? '';
  return fromBody.slice(0, 80) || item.link || 'Untitled';
}

/**
 * The post is the item's text, cut to a readable length, and a link back.
 *
 * Plain text rather than the feed's HTML: the markdown renderer escapes raw
 * HTML anyway, and a story is a thing to discuss here and read there.
 */
export function topicBody(item: FeedItem, feedTitle: string | null): string {
  let text = htmlToText(item.content ?? item.summary);
  if (text.length > EXCERPT_LENGTH) {
    const cut = text.lastIndexOf(' ', EXCERPT_LENGTH);
    text = `${text.slice(0, cut > EXCERPT_LENGTH / 2 ? cut : EXCERPT_LENGTH).trimEnd()}…`;
  }
  const lines: string[] = [];
  if (text) lines.push(text);
  const credit = [item.author ? `By ${item.author}` : null, feedTitle ? `via ${feedTitle}` : null]
    .filter(Boolean)
    .join(', ');
  if (item.link) lines.push(`Read the original${credit ? ` (${credit})` : ''}: ${item.link}`);
  else if (credit) lines.push(credit);
  return lines.join('\n\n') || topicTitle(item);
}

/**
 * Fetch every enabled source whose time has come. Called from the worker's
 * tick; a handful per tick keeps one slow host from holding up the mail.
 */
export async function pollFeedSources(
  options: FetchOptions & { limit?: number },
): Promise<{ fetched: number; added: number; errors: number }> {
  const settings = await loadSettings();
  if (settings['feeds.importEnabled'] === false) return { fetched: 0, added: 0, errors: 0 };

  const rows = await all<FeedSourceRow>(
    `${SELECT} WHERE s.is_enabled = 1 AND (s.next_fetch_at IS NULL OR s.next_fetch_at <= ?)
      ORDER BY s.next_fetch_at LIMIT ?`,
    [now(), options.limit ?? 5],
  );

  let added = 0;
  let errors = 0;
  for (const row of rows) {
    const result = await fetchFeedSource(toFeedSource(row), options);
    added += result.added;
    if (result.status === 'error') errors += 1;
  }
  return { fetched: rows.length, added, errors };
}
