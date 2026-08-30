import { all, run } from '@tsbb/db';
import {
  claimDueEmails,
  loadSettings,
  markEmailFailed,
  markEmailSent,
  markNotificationsEmailed,
  pruneExpired,
  queueEmail,
  unemailedNotifications,
} from '@tsbb/core';
import { notificationEmail, transport, type NotificationLine } from '@tsbb/mail';

/**
 * The background worker: turns unread notifications into email, drains the mail
 * queue, and prunes expired rows.
 *
 * It is a separate entry point but not a separate deployment requirement — the
 * server can run it in-process (see `startWorker`), so a self-hoster gets
 * working email from one command and can split it out later if the board grows.
 */

const TICK_MS = 15_000;

export interface WorkerOptions {
  baseUrl: string;
  intervalMs?: number;
}

/**
 * Turn unread, un-emailed notifications into queued mail.
 *
 * Notifications are grouped per recipient, so someone who was mentioned three
 * times while away gets one message rather than three. Anyone on a digest
 * schedule is skipped here and picked up by the digest pass instead.
 */
export async function fanOutNotificationEmails(baseUrl: string): Promise<number> {
  const settings = await loadSettings();
  if (settings['notifications.emailEnabled'] === false) return 0;

  const pending = await unemailedNotifications(200);
  if (!pending.length) return 0;

  const byUser = new Map<number, typeof pending>();
  for (const row of pending) {
    if (row.digest !== 'instant') continue;
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }

  const boardName = String(settings['board.name'] ?? 'tsbb');
  let queued = 0;

  for (const [userId, rows] of byUser) {
    const first = rows[0];
    if (!first) continue;

    const actorIds = rows.map((r) => r.actorId).filter((id): id is number => id !== null);
    const actors = actorIds.length
      ? new Map(
          (
            await all<{ id: number; username: string }>(
              `SELECT id, username FROM users WHERE id IN (${actorIds.map(() => '?').join(',')})`,
              actorIds,
            )
          ).map((r) => [r.id, r.username]),
        )
      : new Map<number, string>();

    const lines: NotificationLine[] = rows.map((row) => ({
      title: row.title ?? 'a topic',
      excerpt: row.excerpt,
      url: row.url ?? '/',
      kind: row.kind,
      actor: row.actorId ? (actors.get(row.actorId) ?? null) : null,
    }));

    const message = notificationEmail({
      boardName,
      baseUrl,
      username: first.username,
      lines,
      unsubscribeUrl: new URL('/settings/notifications', baseUrl).toString(),
    });

    await queueEmail({
      to: first.email,
      userId,
      subject: message.subject,
      html: message.html,
      text: message.text,
      kind: 'notification',
      // One message per recipient per batch. Without the key, a slow send that
      // is retried would queue the same digest twice.
      dedupeKey: `notify:${userId}:${rows.map((r) => r.id).join('-')}`,
    });

    await markNotificationsEmailed(rows.map((r) => r.id));
    queued += 1;
  }

  return queued;
}

/** Send whatever is due. Claiming and sending are separate so a crash retries. */
export async function drainMailQueue(): Promise<{ sent: number; failed: number }> {
  const due = await claimDueEmails(20);
  let sent = 0;
  let failed = 0;

  for (const email of due) {
    try {
      await transport().send({
        to: email.to_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      await markEmailSent(email.id);
      sent += 1;
    } catch (error) {
      // Back to pending with a delay until the attempt cap, then left failed
      // rather than retried forever against an address that does not exist.
      await markEmailFailed(email.id, (error as Error).message);
      failed += 1;
    }
  }

  return { sent, failed };
}

export async function tick(baseUrl: string): Promise<void> {
  try {
    await fanOutNotificationEmails(baseUrl);
    const result = await drainMailQueue();
    if (result.sent || result.failed) {
      console.log(`[worker] mail sent=${result.sent} failed=${result.failed}`);
    }
  } catch (error) {
    // A worker that dies on one bad row stops delivering everything.
    console.error('[worker] tick failed:', error);
  }
}

let houseKeepingAt = 0;

export function startWorker(options: WorkerOptions): { stop: () => void } {
  const interval = options.intervalMs ?? TICK_MS;
  let stopped = false;

  const loop = async () => {
    if (stopped) return;
    await tick(options.baseUrl);

    // Pruning is hourly, not every tick: it scans, and nothing depends on it
    // being prompt.
    if (Date.now() - houseKeepingAt > 3_600_000) {
      houseKeepingAt = Date.now();
      try {
        await pruneExpired();
        await run("DELETE FROM email_queue WHERE status = 'sent' AND sent_at < ?", [
          Date.now() - 7 * 86_400_000,
        ]);
      } catch (error) {
        console.error('[worker] housekeeping failed:', error);
      }
    }
  };

  const timer = setInterval(() => void loop(), interval);
  // The board should not be held open by the worker's timer alone.
  timer.unref?.();
  void loop();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

if (import.meta.filename === process.argv[1]) {
  const baseUrl = process.env.TSBB_BASE_URL ?? 'http://localhost:3000';
  console.log(`[worker] started, transport=${transport().name}`);
  startWorker({ baseUrl });
  // Keep the process alive; the interval is unref'd so it would exit otherwise.
  setInterval(() => {}, 1 << 30);
}
