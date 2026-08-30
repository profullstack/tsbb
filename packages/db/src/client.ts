import { createClient, type Client, type InArgs, type Row } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let cached: Client | null = null;

/**
 * Resolve the database URL. A bare path or a `file:` URL is a local SQLite
 * file, which is the default so `tsbb init` works with no configuration at
 * all; a `libsql://` URL points at Turso or any libSQL server.
 */
export function databaseUrl(): string {
  const raw = process.env.TSBB_DATABASE_URL?.trim();
  if (!raw) return `file:${resolve('./data/tsbb.db')}`;
  if (/^(libsql|https?|wss?):\/\//.test(raw)) return raw;
  // libSQL cannot open a relative `file:` URL, and the failure is a bare
  // SQLITE_CANTOPEN with no hint that the path was the problem. Resolve it here
  // so a board configured with `file:./data/tsbb.db` just works.
  const path = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
  const [file = '', query] = path.split('?');
  return `file:${resolve(file)}${query ? `?${query}` : ''}`;
}

function ensureLocalDirectory(url: string): void {
  if (!url.startsWith('file:')) return;
  const path = url.slice('file:'.length).split('?')[0] ?? '';
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // A pre-existing directory is the normal case; anything else surfaces on connect.
  }
}

export function db(): Client {
  if (cached) return cached;
  const url = databaseUrl();
  ensureLocalDirectory(url);
  const authToken = process.env.TSBB_DATABASE_AUTH_TOKEN?.trim() || undefined;
  cached = createClient(authToken ? { url, authToken } : { url });
  return cached;
}

/** Replace the process-wide client. Tests use this to point at a scratch file. */
export function setDb(client: Client | null): void {
  cached = client;
}

/**
 * libSQL's remote client throws on an `undefined` bound argument while a local
 * file binds it as null, so a bug of this shape only ever shows up in
 * production. Normalise on the way in and it can never happen at all.
 */
export function args(values: InArgs): InArgs {
  if (Array.isArray(values)) return values.map((v) => (v === undefined ? null : v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === undefined ? null : v;
  return out as InArgs;
}

export async function all<T = Row>(sql: string, values: InArgs = []): Promise<T[]> {
  const result = await db().execute({ sql, args: args(values) });
  return result.rows as unknown as T[];
}

export async function one<T = Row>(sql: string, values: InArgs = []): Promise<T | null> {
  const rows = await all<T>(sql, values);
  return rows[0] ?? null;
}

export async function run(sql: string, values: InArgs = []) {
  return db().execute({ sql, args: args(values) });
}

/** Monotonic-enough millisecond clock, used for every `*_at` column. */
export function now(): number {
  return Date.now();
}
