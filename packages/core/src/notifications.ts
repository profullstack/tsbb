import { all, now, one, run } from '@tsbb/db';
import type { HookBus } from '@tsbb/plugin-host';
import type { Id, Notification, Post, Topic, Viewer } from '@tsbb/plugin-api';
import { excerpt, extractMentions } from '@tsbb/markup';
import { loadSettings } from './settings.ts';

export type NotificationKind =
  | 'reply'
  | 'mention'
  | 'quote'
  | 'reaction'
  | 'pm'
  | 'solved'
  | 'moderation'
  | 'group_invite';

export const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
  reply: 'Replies to topics I follow',
  mention: 'Someone mentions me',
  quote: 'Someone quotes my post',
  reaction: 'Someone reacts to my post',
  pm: 'Private messages',
  solved: 'My answer is marked as the solution',
  moderation: 'Moderation notices about my content',
  group_invite: 'Group invitations',
};

interface NotificationRow {
  id: number;
  user_id: number;
  kind: string;
  actor_id: number | null;
  subject_type: string | null;
  subject_id: number | null;
  url: string | null;
  title: string | null;
  excerpt: string | null;
  data: string | null;
  read_at: number | null;
  created_at: number;
}

function toNotification(row: NotificationRow): Notification {
  let data: Record<string, unknown> = {};
  try {
    data = row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    actorId: row.actor_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    url: row.url,
    title: row.title,
    excerpt: row.excerpt,
    data,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface CreateNotification {
  userId: Id;
  kind: string;
  actorId?: Id | null;
  subjectType?: string;
  subjectId?: Id;
  url?: string;
  title?: string;
  excerpt?: string;
  dedupeKey?: string;
  data?: Record<string, unknown>;
}

/**
 * Raise one notification.
 *
 * `dedupeKey` collapses repeats while the row is still unread, so "six people
 * replied" is one line in the inbox rather than six. The partial unique index
 * that backs it only covers unread rows, so once the user has read the thread a
 * new reply notifies again — which is the behaviour people expect and the
 * reason the index is partial rather than plain.
 */
export async function notify(input: CreateNotification): Promise<Notification | null> {
  // Nobody is notified about their own action.
  if (input.actorId && input.actorId === input.userId) return null;

  const blocked = await one<{ user_id: number }>(
    'SELECT user_id FROM blocks WHERE user_id = ? AND blocked_id = ?',
    [input.userId, input.actorId ?? -1],
  );
  if (blocked) return null;

  const prefs = await one<{ in_app: number }>(
    'SELECT in_app FROM notification_prefs WHERE user_id = ? AND kind = ?',
    [input.userId, input.kind],
  );
  if (prefs && prefs.in_app === 0) return null;

  const result = await run(
    `INSERT INTO notifications
       (user_id, kind, actor_id, subject_type, subject_id, url, title, excerpt, data, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND read_at IS NULL
     DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt,
                   actor_id = excluded.actor_id, url = excluded.url,
                   created_at = excluded.created_at
     RETURNING *`,
    [
      input.userId,
      input.kind,
      input.actorId ?? null,
      input.subjectType ?? null,
      input.subjectId ?? null,
      input.url ?? null,
      input.title ?? null,
      input.excerpt ?? null,
      JSON.stringify(input.data ?? {}),
      input.dedupeKey ?? null,
      now(),
    ],
  );
  const row = result.rows[0] as unknown as NotificationRow | undefined;
  return row ? toNotification(row) : null;
}

export async function listNotifications(
  userId: Id,
  options: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
): Promise<Notification[]> {
  const rows = await all<NotificationRow>(
    `SELECT * FROM notifications
      WHERE user_id = ? ${options.unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [userId, options.limit ?? 30, options.offset ?? 0],
  );
  return rows.map(toNotification);
}

export async function unreadCount(userId: Id): Promise<number> {
  const row = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId],
  );
  return Number(row?.n ?? 0);
}

export async function markNotificationsRead(userId: Id, ids?: Id[]): Promise<void> {
  if (ids?.length) {
    await run(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL
        AND id IN (${ids.map(() => '?').join(',')})`,
      [now(), userId, ...ids],
    );
    return;
  }
  await run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [
    now(),
    userId,
  ]);
}

/**
 * Fan out the notifications a new post causes.
 *
 * Order matters: a person who is both mentioned in a post and subscribed to the
 * topic gets the mention, not the reply. Mentioning somebody is addressing them
 * directly, and being told about it twice is how a notification inbox becomes
 * something people switch off.
 */
export async function notifyNewPost(args: {
  post: Post;
  topic: Topic;
  viewer: Viewer;
  baseUrl: string;
  bus?: HookBus;
}): Promise<void> {
  const settings = await loadSettings();
  const actorId = args.viewer.user?.id ?? null;
  const url = `/t/${args.topic.slug}-${args.topic.id}/p/${args.post.id}`;
  const preview = excerpt(args.post.body, args.post.bodyFormat, 160);
  const notified = new Set<Id>();
  if (actorId) notified.add(actorId);

  // 1. Mentions.
  if (settings['notifications.mentionsEnabled'] !== false) {
    const names = extractMentions(args.post.body);
    if (names.length) {
      const rows = await all<{ id: number }>(
        `SELECT id FROM users WHERE is_deleted = 0 AND username_lower IN (${names.map(() => '?').join(',')})`,
        names,
      );
      for (const row of rows) {
        if (notified.has(row.id)) continue;
        notified.add(row.id);
        await notify({
          userId: row.id,
          kind: 'mention',
          actorId,
          subjectType: 'post',
          subjectId: args.post.id,
          url,
          title: args.topic.title,
          excerpt: preview,
        });
      }
    }
  }

  // 2. The author of the post being replied to.
  if (args.post.replyToId) {
    const parent = await one<{ user_id: number | null }>('SELECT user_id FROM posts WHERE id = ?', [
      args.post.replyToId,
    ]);
    if (parent?.user_id && !notified.has(parent.user_id)) {
      notified.add(parent.user_id);
      await notify({
        userId: parent.user_id,
        kind: 'quote',
        actorId,
        subjectType: 'post',
        subjectId: args.post.id,
        url,
        title: args.topic.title,
        excerpt: preview,
      });
    }
  }

  // 3. Everyone subscribed to the topic or to its forum.
  let subscriberIds = (
    await all<{ user_id: number }>(
      // The two subscription sources are parenthesised as a unit. Without the
      // outer brackets AND binds tighter than OR, so the ignore check would
      // apply only to forum subscribers and anyone who had explicitly left the
      // topic would keep being notified about it.
      `SELECT DISTINCT s.user_id FROM subscriptions s
        WHERE (
              (s.target_type = 'topic' AND s.target_id = ?)
           OR (s.target_type = 'forum' AND s.target_id = ?)
        )
          AND NOT EXISTS (
            SELECT 1 FROM ignores i
             WHERE i.user_id = s.user_id
               AND i.target_type = 'topic'
               AND i.target_id = ?
          )`,
      [args.topic.id, args.topic.forumId, args.topic.id],
    )
  ).map((r) => r.user_id);

  if (args.bus) {
    subscriberIds = await args.bus.applyFilter('notify:recipients', subscriberIds, {
      kind: 'reply',
      subjectType: 'topic',
      subjectId: args.topic.id,
    });
  }

  for (const userId of subscriberIds) {
    if (notified.has(userId)) continue;
    notified.add(userId);
    await notify({
      userId,
      kind: 'reply',
      actorId,
      subjectType: 'topic',
      subjectId: args.topic.id,
      url,
      title: args.topic.title,
      excerpt: preview,
      // One unread row per topic, however many replies arrive.
      dedupeKey: `reply:${args.topic.id}`,
    });
  }
}

export interface PendingEmail {
  id: number;
  to_email: string;
  to_user_id: number | null;
  subject: string;
  html: string;
  text: string;
  kind: string;
  attempts: number;
}

export async function queueEmail(input: {
  to: string;
  userId?: Id | null;
  subject: string;
  html: string;
  text: string;
  kind: string;
  dedupeKey?: string;
  delayMs?: number;
}): Promise<void> {
  const timestamp = now();
  await run(
    `INSERT INTO email_queue
       (to_email, to_user_id, subject, html, text, kind, dedupe_key, scheduled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      input.to,
      input.userId ?? null,
      input.subject,
      input.html,
      input.text,
      input.kind,
      input.dedupeKey ?? null,
      timestamp + (input.delayMs ?? 0),
      timestamp,
    ],
  );
}

export async function claimDueEmails(limit = 20): Promise<PendingEmail[]> {
  // Claimed by flipping status in one statement, so two workers cannot take the
  // same row. RETURNING makes the read and the claim a single round trip.
  const result = await run(
    `UPDATE email_queue SET status = 'sending', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM email_queue
         WHERE status = 'pending' AND scheduled_at <= ? AND attempts < 5
         ORDER BY scheduled_at LIMIT ?
      )
      RETURNING id, to_email, to_user_id, subject, html, text, kind, attempts`,
    [now(), limit],
  );
  return result.rows as unknown as PendingEmail[];
}

export async function markEmailSent(id: Id): Promise<void> {
  await run("UPDATE email_queue SET status = 'sent', sent_at = ? WHERE id = ?", [now(), id]);
}

export async function markEmailFailed(id: Id, error: string): Promise<void> {
  // Back to pending with a backoff until the attempt cap is reached, then it
  // stays failed rather than retrying forever against a dead address.
  await run(
    `UPDATE email_queue
        SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
            last_error = ?,
            scheduled_at = ?
      WHERE id = ?`,
    [error.slice(0, 500), now() + 60_000, id],
  );
}

/** Notifications that still need an email, for the worker's digest pass. */
export async function unemailedNotifications(limit = 200): Promise<
  (Notification & { email: string; username: string; digest: string })[]
> {
  const rows = await all<
    NotificationRow & { email: string; username: string; digest: string; email_pref: number | null }
  >(
    `SELECT n.*, u.email, u.username,
            COALESCE(p.email_digest, 'instant') AS digest,
            np.email AS email_pref
       FROM notifications n
       JOIN users u ON u.id = n.user_id
       LEFT JOIN user_prefs p ON p.user_id = n.user_id
       LEFT JOIN notification_prefs np ON np.user_id = n.user_id AND np.kind = n.kind
      WHERE n.emailed_at IS NULL
        AND n.read_at IS NULL
        AND u.is_deleted = 0
        AND u.is_banned = 0
        AND COALESCE(np.email, 1) = 1
      ORDER BY n.created_at
      LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    ...toNotification(row),
    email: row.email,
    username: row.username,
    digest: row.digest,
  }));
}

export async function markNotificationsEmailed(ids: Id[]): Promise<void> {
  if (!ids.length) return;
  await run(
    `UPDATE notifications SET emailed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    [now(), ...ids],
  );
}
