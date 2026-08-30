import { all, now, one, run } from '@tsbb/db';
import type { Id, User } from '@tsbb/plugin-api';
import { renderSignature, type BodyFormat } from '@tsbb/markup';
import { loadSettings, type Settings } from './settings.ts';
import { slugify } from './util.ts';

export interface UserRow {
  id: number;
  username: string;
  username_lower: string;
  email: string;
  email_lower: string;
  display_name: string | null;
  avatar_kind: string;
  avatar_url: string | null;
  signature: string | null;
  title: string | null;
  location: string | null;
  website: string | null;
  bio: string | null;
  timezone: string;
  locale: string;
  post_count: number;
  topic_count: number;
  reaction_count: number;
  is_admin: number;
  is_moderator: number;
  is_banned: number;
  banned_until: number | null;
  ban_reason: string | null;
  is_deleted: number;
  created_at: number;
  last_seen_at: number | null;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    avatarKind: (row.avatar_kind as User['avatarKind']) ?? 'identicon',
    avatarUrl: row.avatar_url,
    signature: row.signature,
    title: row.title,
    location: row.location,
    website: row.website,
    bio: row.bio,
    timezone: row.timezone,
    locale: row.locale,
    postCount: row.post_count,
    topicCount: row.topic_count,
    reactionCount: row.reaction_count,
    isAdmin: row.is_admin === 1,
    isModerator: row.is_moderator === 1 || row.is_admin === 1,
    isBanned: row.is_banned === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

const SELECT = 'SELECT * FROM users WHERE is_deleted = 0';

export async function userById(id: Id): Promise<User | null> {
  const row = await one<UserRow>(`${SELECT} AND id = ?`, [id]);
  return row ? toUser(row) : null;
}

export async function userByUsername(username: string): Promise<User | null> {
  const row = await one<UserRow>(`${SELECT} AND username_lower = ?`, [username.toLowerCase()]);
  return row ? toUser(row) : null;
}

export async function userByEmail(email: string): Promise<User | null> {
  const row = await one<UserRow>(`${SELECT} AND email_lower = ?`, [email.toLowerCase()]);
  return row ? toUser(row) : null;
}

export async function usersByIds(ids: Id[]): Promise<Map<Id, User>> {
  if (!ids.length) return new Map();
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => '?').join(',');
  const rows = await all<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders})`, unique);
  return new Map(rows.map((row) => [row.id, toUser(row)]));
}

export async function usernameTaken(username: string): Promise<boolean> {
  const row = await one<{ id: number }>('SELECT id FROM users WHERE username_lower = ?', [
    username.toLowerCase(),
  ]);
  return row !== null;
}

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'moderator', 'mod', 'staff', 'support',
  'anonymous', 'guest', 'deleted', 'tsbb', 'api', 'me', 'you', 'null', 'undefined',
]);

export function validateUsername(
  username: string,
  settings: Settings,
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = username.trim();
  const min = Number(settings['registration.minUsernameLength'] ?? 3);
  const max = Number(settings['registration.maxUsernameLength'] ?? 24);
  if (value.length < min) return { ok: false, reason: `Usernames are at least ${min} characters.` };
  if (value.length > max) return { ok: false, reason: `Usernames are at most ${max} characters.` };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    return { ok: false, reason: 'Use letters, numbers, hyphens and underscores; start with a letter or number.' };
  }
  if (RESERVED.has(value.toLowerCase())) return { ok: false, reason: 'That name is reserved.' };
  return { ok: true, value };
}

/**
 * Derive a free username from an email address, for magic-link registration
 * where the visitor never chose one. They can change it afterwards.
 */
export async function suggestUsername(email: string): Promise<string> {
  const base = slugify(email.split('@')[0] ?? 'member', 'member').replace(/-/g, '_').slice(0, 20);
  if (!(await usernameTaken(base))) return base;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${base}${i}`;
    if (!(await usernameTaken(candidate))) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

export async function createUser(input: {
  username: string;
  email: string;
  isAdmin?: boolean;
}): Promise<User> {
  const timestamp = now();
  const result = await run(
    `INSERT INTO users (username, username_lower, email, email_lower, is_admin, is_moderator, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      input.username,
      input.username.toLowerCase(),
      input.email,
      input.email.toLowerCase(),
      input.isAdmin ? 1 : 0,
      input.isAdmin ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );
  const row = result.rows[0] as unknown as UserRow;
  await run('INSERT INTO user_prefs (user_id, updated_at) VALUES (?, ?)', [row.id, timestamp]);

  // Every new account joins the default groups, which is what carries its
  // permissions. A user in no group can see nothing.
  await run(
    `INSERT INTO group_members (group_id, user_id, created_at)
     SELECT id, ?, ? FROM groups WHERE is_default = 1`,
    [row.id, timestamp],
  );
  return toUser(row);
}

export async function touchLastSeen(userId: Id): Promise<void> {
  await run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now(), userId]);
}

/**
 * Signatures are earned, not granted.
 *
 * A brand-new account whose first post carries a signature full of links is the
 * shape of every piece of forum spam ever written, so a signature is not
 * rendered until its author has actually taken part. The threshold is a board
 * setting (ten posts by default) and a filter, so a plugin can raise it, lower
 * it, or make it conditional — a plugin that wants trust levels replaces this
 * rule without touching core.
 *
 * Note this gates *display*, not editing: a new member can write their
 * signature on day one and see it in their own settings. Hiding the editor
 * until they qualify would just read as a missing feature.
 */
export interface SignatureGate {
  visible: boolean;
  minPosts: number;
  remaining: number;
}

export function signatureGate(author: User, settings: Settings, minPostsOverride?: number): SignatureGate {
  const minPosts = minPostsOverride ?? Number(settings['signatures.minPosts'] ?? 10);
  const enabled = settings['signatures.enabled'] !== false;
  const remaining = Math.max(0, minPosts - author.postCount);
  return {
    visible: enabled && Boolean(author.signature?.trim()) && remaining === 0,
    minPosts,
    remaining,
  };
}

export function renderUserSignature(
  author: User,
  settings: Settings,
  options: { format?: BodyFormat; internalHosts?: string[]; mentionUrl?: (u: string) => string } = {},
): string | null {
  const gate = signatureGate(author, settings);
  if (!gate.visible || !author.signature) return null;
  return renderSignature(author.signature, options.format ?? 'markdown', {
    internalHosts: options.internalHosts,
    mentionUrl: options.mentionUrl,
  });
}

/** The highest rank a user's post count has earned, plus any special award. */
export async function rankFor(user: User): Promise<{ title: string; colour: string | null } | null> {
  const row = await one<{ title: string; colour: string | null }>(
    `SELECT title, colour FROM ranks
      WHERE is_special = 0 AND min_posts <= ?
      ORDER BY min_posts DESC LIMIT 1`,
    [user.postCount],
  );
  if (user.title) return { title: user.title, colour: null };
  return row;
}

export async function updateProfile(
  userId: Id,
  patch: Partial<{
    displayName: string | null;
    signature: string | null;
    location: string | null;
    website: string | null;
    bio: string | null;
    timezone: string;
    avatarKind: string;
    avatarUrl: string | null;
  }>,
): Promise<void> {
  const columns: Record<string, string> = {
    displayName: 'display_name',
    signature: 'signature',
    location: 'location',
    website: 'website',
    bio: 'bio',
    timezone: 'timezone',
    avatarKind: 'avatar_kind',
    avatarUrl: 'avatar_url',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    values.push((patch as Record<string, unknown>)[key] ?? null);
  }
  if (!sets.length) return;
  values.push(userId);
  await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values as never);
}

export async function recountUser(userId: Id): Promise<void> {
  // Counts are derived rather than incremented, so a deleted or hidden post
  // takes its contribution with it instead of leaving the total drifting.
  await run(
    `UPDATE users SET
       post_count = (SELECT COUNT(*) FROM posts WHERE user_id = ? AND is_deleted = 0 AND is_hidden = 0),
       topic_count = (SELECT COUNT(*) FROM topics WHERE user_id = ? AND is_deleted = 0 AND is_hidden = 0),
       reaction_count = (SELECT COUNT(*) FROM reactions r JOIN posts p ON p.id = r.post_id WHERE p.user_id = ?)
     WHERE id = ?`,
    [userId, userId, userId, userId],
  );
}

export async function listStaff(): Promise<User[]> {
  const rows = await all<UserRow>(
    `${SELECT} AND (is_admin = 1 OR is_moderator = 1) ORDER BY is_admin DESC, username_lower`,
  );
  return rows.map(toUser);
}

export { loadSettings };
