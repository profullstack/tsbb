import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, isPostgres, now, pgPool } from './client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_MIGRATIONS = join(HERE, 'migrations');
const CORE_MIGRATIONS_PG = join(HERE, 'migrations-pg');

export type MigrationFile = { name: string; sql: string };

/**
 * The core migrations for the configured engine. The Postgres set mirrors the
 * SQLite one file for file, under the same names, so one ledger describes a
 * board whichever engine it runs on — and a board copied from SQLite to
 * Postgres (or back) arrives with its ledger already right.
 */
export function coreMigrationsDir(): string {
  return isPostgres() ? CORE_MIGRATIONS_PG : CORE_MIGRATIONS;
}

export function readMigrations(dir: string = coreMigrationsDir()): MigrationFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    return [];
  }
  // Forward-only and filename-ordered. A migration is never renamed once it has
  // been applied anywhere, because the filename IS the key.
  names.sort();
  return names.map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

async function ensureLedger(table: string): Promise<void> {
  await db().execute(
    `CREATE TABLE IF NOT EXISTS ${table} (
       name       TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
}

async function appliedNames(table: string): Promise<Set<string>> {
  const result = await db().execute(`SELECT name FROM ${table}`);
  return new Set(result.rows.map((r) => String(r.name)));
}

/**
 * Run one migration script inside its own transaction.
 *
 * On SQLite the script is handed to `executeMultiple` whole rather than being
 * split on semicolons here: a `CREATE TRIGGER` body contains its own
 * statements, and every naive splitter cuts one in half.
 *
 * On Postgres a `native` script (the core `migrations-pg` set: Postgres DDL,
 * trigger functions with dollar-quoted bodies) goes verbatim down one pooled
 * connection as a single simple query, which Postgres runs statement by
 * statement itself. A plugin's script is SQLite DDL and takes the other road:
 * a client transaction, where `@profullstack/libsql-pg` converts each
 * `CREATE TABLE` on the way through.
 */
async function applyScript(sql: string, { native = false } = {}): Promise<void> {
  const pool = pgPool();
  if (pool && native) {
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(sql);
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
    return;
  }
  if (pool) {
    const tx = await db().transaction('write');
    try {
      await tx.executeMultiple(sql);
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
    return;
  }
  try {
    await db().executeMultiple(`BEGIN;\n${sql}\nCOMMIT;`);
  } catch (error) {
    try {
      await db().executeMultiple('ROLLBACK;');
    } catch {
      // Nothing to roll back if the failure was the BEGIN itself.
    }
    throw error;
  }
}

/** Apply every migration in `dir` that this database has not seen. */
export async function migrate(
  dir?: string,
  { ledger = '_migrations', quiet = false } = {},
): Promise<string[]> {
  const from = dir ?? coreMigrationsDir();
  await ensureLedger(ledger);
  const done = await appliedNames(ledger);
  const pending = readMigrations(from).filter((m) => !done.has(m.name));
  const applied: string[] = [];

  for (const migration of pending) {
    try {
      await applyScript(migration.sql, { native: from === CORE_MIGRATIONS_PG });
    } catch (error) {
      throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    await db().execute({
      sql: `INSERT INTO ${ledger} (name, applied_at) VALUES (?, ?)`,
      args: [migration.name, now()],
    });
    applied.push(migration.name);
    if (!quiet) console.log(`  applied ${migration.name}`);
  }

  return applied;
}

/** Apply a plugin's own migrations, tracked in `plugin_migrations`. */
export async function migratePlugin(slug: string, dir: string): Promise<string[]> {
  const result = await db().execute({
    sql: 'SELECT name FROM plugin_migrations WHERE plugin_slug = ?',
    args: [slug],
  });
  const done = new Set(result.rows.map((r) => String(r.name)));
  const applied: string[] = [];

  for (const migration of readMigrations(dir)) {
    if (done.has(migration.name)) continue;
    try {
      await applyScript(migration.sql);
    } catch (error) {
      throw new Error(
        `plugin ${slug} migration ${migration.name} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
    await db().execute({
      sql: 'INSERT INTO plugin_migrations (plugin_slug, name, applied_at) VALUES (?, ?, ?)',
      args: [slug, migration.name, now()],
    });
    applied.push(migration.name);
  }

  return applied;
}

if (import.meta.filename === process.argv[1]) {
  const applied = await migrate();
  console.log(applied.length ? `${applied.length} migration(s) applied.` : 'Already up to date.');
  process.exit(0);
}
