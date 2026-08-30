import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now } from './client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_MIGRATIONS = join(HERE, 'migrations');

export type MigrationFile = { name: string; sql: string };

export function readMigrations(dir: string = CORE_MIGRATIONS): MigrationFile[] {
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
 * Apply every migration in `dir` that this database has not seen.
 *
 * The script is handed to `executeMultiple` whole rather than being split on
 * semicolons here: a `CREATE TRIGGER` body contains its own statements, and
 * every naive splitter cuts one in half.
 */
export async function migrate(
  dir: string = CORE_MIGRATIONS,
  { ledger = '_migrations', quiet = false } = {},
): Promise<string[]> {
  await ensureLedger(ledger);
  const done = await appliedNames(ledger);
  const pending = readMigrations(dir).filter((m) => !done.has(m.name));
  const applied: string[] = [];

  for (const migration of pending) {
    try {
      await db().executeMultiple(`BEGIN;\n${migration.sql}\nCOMMIT;`);
    } catch (error) {
      try {
        await db().executeMultiple('ROLLBACK;');
      } catch {
        // Nothing to roll back if the failure was the BEGIN itself.
      }
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
      await db().executeMultiple(`BEGIN;\n${migration.sql}\nCOMMIT;`);
    } catch (error) {
      try {
        await db().executeMultiple('ROLLBACK;');
      } catch {
        /* see above */
      }
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
