import { all, now, one, run } from '@tsbb/db';
import type { Id, User, Viewer } from '@tsbb/plugin-api';
import { hashIp, humanCode, randomToken, sha256 } from './util.ts';
import { createUser, suggestUsername, toUser, touchLastSeen, userByEmail, type UserRow } from './users.ts';

const SESSION_DAYS = 30;
const MAGIC_LINK_MINUTES = 20;
const DEVICE_CODE_MINUTES = 10;

export const GUEST: Viewer = {
  user: null,
  groupIds: [],
  isAdmin: false,
  isModerator: false,
  viaToken: false,
};

/**
 * Authentication is emailed magic link plus passkey. The link proves the
 * address, and proving the address is the entire account — a password would add
 * a second, weaker secret whose recovery path collapses back to "email them a
 * link" anyway.
 *
 * The link doubles as registration: an unknown address makes the account rather
 * than being turned away. There is no separate sign-up flow to keep in step.
 */
export async function startMagicLink(input: {
  email: string;
  ip?: string | null;
  redirectTo?: string | null;
}): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const expiresAt = now() + MAGIC_LINK_MINUTES * 60_000;
  await run(
    `INSERT INTO magic_links (token_hash, email_lower, created_at, expires_at, ip_hash, redirect_to)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      sha256(token),
      input.email.trim().toLowerCase(),
      now(),
      expiresAt,
      hashIp(input.ip),
      input.redirectTo ?? null,
    ],
  );
  return { token, expiresAt };
}

/**
 * Rate limit link requests per address. The caller reports a limit refusal as
 * success, exactly like an accepted request, because a different answer would
 * turn this endpoint into a way to enumerate who has an account.
 */
export async function magicLinkRateLimited(email: string, max = 5, windowMs = 3_600_000): Promise<boolean> {
  const row = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM magic_links WHERE email_lower = ? AND created_at > ?',
    [email.trim().toLowerCase(), now() - windowMs],
  );
  return Number(row?.n ?? 0) >= max;
}

export async function consumeMagicLink(
  token: string,
): Promise<{ user: User; redirectTo: string | null } | null> {
  const hash = sha256(token);
  const row = await one<{
    email_lower: string;
    expires_at: number;
    consumed_at: number | null;
    redirect_to: string | null;
  }>('SELECT email_lower, expires_at, consumed_at, redirect_to FROM magic_links WHERE token_hash = ?', [
    hash,
  ]);
  if (!row || row.consumed_at !== null || Number(row.expires_at) < now()) return null;

  await run('UPDATE magic_links SET consumed_at = ? WHERE token_hash = ?', [now(), hash]);

  const existing = await userByEmail(row.email_lower);
  const user = existing ?? (await createUser({
    username: await suggestUsername(row.email_lower),
    email: row.email_lower,
    // The very first account on a fresh board is its administrator. Without
    // this there is no way in to the admin panel at all.
    isAdmin: (await userCount()) === 0,
  }));
  return { user, redirectTo: row.redirect_to };
}

export async function userCount(): Promise<number> {
  const row = await one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE is_deleted = 0');
  return Number(row?.n ?? 0);
}

export async function createSession(
  userId: Id,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ id: string; expiresAt: number }> {
  const id = randomToken(32);
  const expiresAt = now() + SESSION_DAYS * 86_400_000;
  await run(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, user_agent, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, now(), expiresAt, now(), meta.userAgent?.slice(0, 300) ?? null, hashIp(meta.ip)],
  );
  await touchLastSeen(userId);
  return { id, expiresAt };
}

export async function destroySession(id: string): Promise<void> {
  await run('DELETE FROM sessions WHERE id = ?', [id]);
}

export async function pruneExpired(): Promise<void> {
  await run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
  await run('DELETE FROM magic_links WHERE expires_at < ?', [now() - 86_400_000]);
  await run("DELETE FROM device_codes WHERE expires_at < ? AND status != 'claimed'", [now()]);
}

async function groupIdsFor(userId: Id): Promise<Id[]> {
  const rows = await all<{ group_id: number }>(
    'SELECT group_id FROM group_members WHERE user_id = ?',
    [userId],
  );
  return rows.map((r) => r.group_id);
}

export async function viewerFromSession(sessionId: string | null | undefined): Promise<Viewer> {
  if (!sessionId) return GUEST;
  const row = await one<UserRow & { expires_at: number }>(
    `SELECT u.*, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ? AND u.is_deleted = 0`,
    [sessionId, now()],
  );
  if (!row) return GUEST;
  const user = toUser(row);
  return {
    user,
    groupIds: await groupIdsFor(user.id),
    isAdmin: user.isAdmin,
    isModerator: user.isModerator,
    viaToken: false,
  };
}

/** Guest viewers still belong to the guest group, so permissions can name them. */
export async function guestViewer(): Promise<Viewer> {
  const row = await one<{ id: number }>("SELECT id FROM groups WHERE slug = 'guests'");
  return { ...GUEST, groupIds: row ? [row.id] : [] };
}

// --- API tokens, for the TUI and any other client of a centralised install ---

export async function mintToken(input: {
  userId: Id;
  label?: string;
  scopes?: string;
  expiresInDays?: number;
}): Promise<string> {
  const token = `tsbb_${randomToken(24)}`;
  await run(
    `INSERT INTO api_tokens (token_hash, user_id, label, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      sha256(token),
      input.userId,
      input.label ?? null,
      input.scopes ?? 'read write',
      now(),
      input.expiresInDays ? now() + input.expiresInDays * 86_400_000 : null,
    ],
  );
  return token;
}

export async function viewerFromToken(token: string | null | undefined): Promise<Viewer> {
  if (!token) return GUEST;
  const row = await one<UserRow & { scopes: string; token_id: number }>(
    `SELECT u.*, t.scopes, t.id AS token_id FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?)
        AND u.is_deleted = 0`,
    [sha256(token), now()],
  );
  if (!row) return GUEST;
  await run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [now(), row.token_id]);
  const user = toUser(row);
  return {
    user,
    groupIds: await groupIdsFor(user.id),
    // A token can never widen itself: administrative power needs a real session,
    // so no token — however it was minted — reaches the admin panel.
    isAdmin: false,
    isModerator: user.isModerator && row.scopes.includes('moderate'),
    viaToken: true,
  };
}

export async function revokeToken(userId: Id, tokenId: Id): Promise<void> {
  await run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?', [
    now(),
    tokenId,
    userId,
  ]);
}

// --- Device authorisation, for the terminal client -------------------------

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  verifyUrl: string;
}

/**
 * A terminal cannot hold a browser session, so the TUI shows a short code, a
 * human approves it in a browser, and the TUI polls for the token. The code the
 * human reads out is deliberately short and unambiguous; the device code that
 * authorises the poll is long and never shown.
 */
export async function startDeviceAuth(input: {
  publicKey: string;
  label?: string;
  baseUrl: string;
}): Promise<DeviceGrant> {
  const deviceCode = randomToken(32);
  const userCode = humanCode(8);
  const expiresAt = now() + DEVICE_CODE_MINUTES * 60_000;
  await run(
    `INSERT INTO device_codes (device_code, user_code, public_key, created_at, expires_at, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [deviceCode, userCode, input.publicKey, now(), expiresAt, input.label ?? null],
  );
  return {
    deviceCode,
    userCode,
    expiresAt,
    verifyUrl: new URL(`/link?code=${encodeURIComponent(userCode)}`, input.baseUrl).toString(),
  };
}

export async function approveDeviceCode(userCode: string, userId: Id): Promise<boolean> {
  const row = await one<{ device_code: string; expires_at: number; status: string; label: string | null }>(
    'SELECT device_code, expires_at, status, label FROM device_codes WHERE user_code = ?',
    [userCode.trim().toUpperCase()],
  );
  if (!row || row.status !== 'pending' || Number(row.expires_at) < now()) return false;

  const token = await mintToken({ userId, label: row.label ?? 'Terminal', scopes: 'read write' });
  await run(
    "UPDATE device_codes SET status = 'approved', user_id = ?, approved_at = ?, sealed_token = ? WHERE device_code = ?",
    [userId, now(), token, row.device_code],
  );
  return true;
}

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'approved'; token: string };

export async function pollDeviceCode(deviceCode: string): Promise<DevicePoll> {
  const row = await one<{ status: string; expires_at: number; sealed_token: string | null }>(
    'SELECT status, expires_at, sealed_token FROM device_codes WHERE device_code = ?',
    [deviceCode],
  );
  if (!row) return { status: 'expired' };
  if (row.status === 'approved' && row.sealed_token) {
    // The token is handed over exactly once, then removed from the row, so a
    // leaked device code cannot be replayed to collect it a second time.
    await run("UPDATE device_codes SET status = 'claimed', sealed_token = NULL WHERE device_code = ?", [
      deviceCode,
    ]);
    return { status: 'approved', token: row.sealed_token };
  }
  if (Number(row.expires_at) < now()) return { status: 'expired' };
  return { status: 'pending' };
}
