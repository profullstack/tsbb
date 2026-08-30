import { all, now, run } from '@tsbb/db';

/**
 * Board settings. Defaults live here rather than in the database so a fresh
 * install has a complete, working configuration before anybody opens the admin
 * panel — and so a new setting added in an upgrade has a value on every
 * existing board without a data migration.
 */
export const DEFAULT_SETTINGS = {
  'board.name': 'A tsbb board',
  'board.tagline': 'A TypeScript bulletin board',
  'board.description': '',
  'board.language': 'en',
  'board.timezone': 'UTC',
  'board.theme': 'system',
  'board.accent': '#4f46e5',
  'board.logoUrl': '',
  'board.faviconUrl': '',

  /** Registration: 'open' | 'invite' | 'closed' */
  'registration.mode': 'open',
  'registration.requireEmailConfirm': true,
  'registration.minUsernameLength': 3,
  'registration.maxUsernameLength': 24,

  'posts.defaultFormat': 'markdown',
  'posts.perPage': 20,
  'posts.editWindowMinutes': 0,
  'posts.minLength': 2,
  'posts.maxLength': 60_000,
  'posts.floodSeconds': 15,

  'topics.perPage': 30,
  'topics.titleMaxLength': 160,

  /**
   * Signatures are earned. A brand-new account with a signature is the shape of
   * every link-spam post ever written, so the default is ten posts before one
   * is shown at all.
   */
  'signatures.enabled': true,
  'signatures.minPosts': 10,
  'signatures.maxLength': 400,

  'avatars.enabled': true,
  'avatars.allowUpload': true,
  'avatars.allowGravatar': true,
  'avatars.maxBytes': 512_000,
  'avatars.size': 128,

  'attachments.enabled': true,
  'attachments.maxBytes': 5_000_000,
  'attachments.maxPerPost': 5,
  'attachments.allowedMime': 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain',

  'notifications.emailEnabled': true,
  'notifications.digest': 'instant',
  'notifications.mentionsEnabled': true,

  'search.enabled': true,
  'search.minLength': 2,

  'feeds.enabled': true,
  'feeds.itemLimit': 50,

  'privacy.showEmailToStaff': true,
  'privacy.storeIpHashes': true,
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

/**
 * `as const` above gives every default a LITERAL type, which is right for
 * documentation and wrong for reading: a setting typed `true` makes
 * `settings['x'] !== false` a comparison the compiler can prove, so the guard
 * silently becomes dead code. Widen each literal back to its base type.
 */
type Widen<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T;

export type Settings = Record<string, unknown> & {
  [K in SettingKey]: Widen<(typeof DEFAULT_SETTINGS)[K]>;
};

let cache: Settings | null = null;

export async function loadSettings(force = false): Promise<Settings> {
  if (cache && !force) return cache;
  const rows = await all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }
  cache = { ...DEFAULT_SETTINGS, ...stored } as Settings;
  return cache;
}

export function settingsCache(): Settings {
  return cache ?? ({ ...DEFAULT_SETTINGS } as Settings);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value ?? null), now()],
  );
  await loadSettings(true);
}

export async function setSettings(values: Record<string, unknown>): Promise<void> {
  const timestamp = now();
  for (const [key, value] of Object.entries(values)) {
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value ?? null), timestamp],
    );
  }
  await loadSettings(true);
}

export function invalidateSettings(): void {
  cache = null;
}
