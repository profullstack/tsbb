import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, databaseUrl, now, one, run } from '@tsbb/db';
import { migrate } from '@tsbb/db/migrate';
import { seed } from '@tsbb/db/seed';
import { loadSettings, queueEmail, startMagicLink, userByEmail } from '@tsbb/core';
import { magicLinkEmail } from '@tsbb/mail';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');

export interface CommandContext {
  args: string[];
  flags: Record<string, string | boolean>;
}

function ok(message: string): void {
  console.log(`  ${message}`);
}

/** Replace a KEY=… line, or append one if the template does not have it. */
function setEnvLine(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, line);
  return `${contents.replace(/\n*$/, '')}\n${line}\n`;
}

/**
 * `tsbb init` — make a board that runs.
 *
 * It writes a .env only if one is missing, and never overwrites an existing
 * one: running init twice on a live board must not rotate the session secret
 * and sign every member out.
 */
export async function init(): Promise<void> {
  console.log('Setting up a tsbb board.\n');

  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    ok('.env already exists — left alone');
  } else {
    const example = join(REPO_ROOT, '.env.example');
    let contents = existsSync(example) ? readFileSync(example, 'utf8') : '';
    contents = setEnvLine(
      contents,
      'TSBB_SESSION_SECRET',
      randomBytes(32).toString('base64url'),
    );

    /*
     * Anything already set in the environment is written through to the file.
     * Without this, running `TSBB_DATABASE_URL=… tsbb init` migrates one
     * database and then writes a .env pointing at a different one — so the
     * board that was just set up is not the board that starts, and the first
     * symptom is `no such table: settings`.
     */
    for (const key of ['TSBB_DATABASE_URL', 'TSBB_BASE_URL', 'TSBB_PORT', 'TSBB_MAIL_FROM', 'TSBB_MAIL_TRANSPORT']) {
      const value = process.env[key];
      if (value) contents = setEnvLine(contents, key, value);
    }

    writeFileSync(envPath, contents, { mode: 0o600 });
    ok('wrote .env with a fresh session secret');
  }

  ok(`database: ${databaseUrl()}`);
  const applied = await migrate(undefined, { quiet: true });
  ok(applied.length ? `applied ${applied.length} migrations` : 'schema already up to date');

  await seed({ quiet: true });
  ok('seeded groups, permissions, ranks and a starter forum tree');

  console.log(`
Done. Start the board with:

  pnpm start

Then open http://localhost:3000 and sign in with your email address.
The first account to sign in becomes the administrator.
`);
}

export async function migrateCommand(): Promise<void> {
  const applied = await migrate();
  console.log(applied.length ? `${applied.length} migration(s) applied.` : 'Already up to date.');
}

/** Promote someone to administrator, for when the first-account rule is not enough. */
export async function promote(email: string): Promise<void> {
  const user = await userByEmail(email);
  if (!user) {
    console.error(`No account for ${email}. They have to sign in once first.`);
    process.exitCode = 1;
    return;
  }
  await run('UPDATE users SET is_admin = 1, is_moderator = 1 WHERE id = ?', [user.id]);
  console.log(`${user.username} <${user.email}> is now an administrator.`);
}

export async function demote(email: string): Promise<void> {
  const user = await userByEmail(email);
  if (!user) {
    console.error(`No account for ${email}.`);
    process.exitCode = 1;
    return;
  }
  const others = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_deleted = 0 AND id != ?',
    [user.id],
  );
  // Refusing to remove the last administrator is the same rule the admin panel
  // enforces; a board with none cannot be configured again from inside itself.
  if (Number(others?.n ?? 0) === 0) {
    console.error('That is the only administrator. Promote somebody else first.');
    process.exitCode = 1;
    return;
  }
  await run('UPDATE users SET is_admin = 0 WHERE id = ?', [user.id]);
  console.log(`${user.username} is no longer an administrator.`);
}

/** Email somebody a sign-in link — how you invite the first people to a new board. */
export async function invite(email: string, baseUrl: string): Promise<void> {
  const settings = await loadSettings();
  const { token } = await startMagicLink({ email });
  const url = new URL(`/auth/${token}`, baseUrl).toString();
  const existing = await userByEmail(email);
  const message = magicLinkEmail({
    boardName: String(settings['board.name'] ?? 'tsbb'),
    url,
    minutes: 20,
    isNew: !existing,
  });
  await queueEmail({
    to: email,
    userId: existing?.id ?? null,
    subject: message.subject,
    html: message.html,
    text: message.text,
    kind: 'magic-link',
  });
  console.log(`Queued a sign-in link for ${email}.`);
  console.log(`The worker sends it within about 15 seconds. The link is:\n\n  ${url}\n`);
}

export async function listPlugins(): Promise<void> {
  const rows = await all<{ slug: string; name: string; version: string; enabled: number; source: string; last_error: string | null }>(
    'SELECT slug, name, version, enabled, source, last_error FROM plugins ORDER BY slug',
  );
  if (!rows.length) {
    console.log('No plugins registered yet. Start the board once so it can discover them.');
    return;
  }
  for (const row of rows) {
    const mark = row.enabled ? 'on ' : 'off';
    console.log(`  ${mark}  ${row.slug.padEnd(22)} v${row.version.padEnd(8)} ${row.source}`);
    if (row.last_error) console.log(`       ! ${row.last_error}`);
  }
}

export async function setPluginEnabled(slug: string, enabled: boolean): Promise<void> {
  const row = await one<{ slug: string }>('SELECT slug FROM plugins WHERE slug = ?', [slug]);
  if (!row) {
    console.error(`No plugin called ${slug}. Run: tsbb plugin ls`);
    process.exitCode = 1;
    return;
  }
  await run('UPDATE plugins SET enabled = ?, updated_at = ?, last_error = NULL WHERE slug = ?', [
    enabled ? 1 : 0,
    now(),
    slug,
  ]);
  console.log(`${slug} is now ${enabled ? 'enabled' : 'disabled'}. Restart the board to apply it.`);
}

export async function status(): Promise<void> {
  const settings = await loadSettings();
  const counts = await one<{ users: number; topics: number; posts: number; pending: number }>(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE is_deleted = 0) AS users,
       (SELECT COUNT(*) FROM topics WHERE is_deleted = 0) AS topics,
       (SELECT COUNT(*) FROM posts WHERE is_deleted = 0) AS posts,
       (SELECT COUNT(*) FROM email_queue WHERE status = 'pending') AS pending`,
  );
  console.log(`  board     ${settings['board.name']}`);
  console.log(`  database  ${databaseUrl()}`);
  console.log(`  mail      ${process.env.TSBB_MAIL_TRANSPORT ?? 'console'}`);
  console.log(`  members   ${counts?.users ?? 0}`);
  console.log(`  topics    ${counts?.topics ?? 0}`);
  console.log(`  posts     ${counts?.posts ?? 0}`);
  console.log(`  mail due  ${counts?.pending ?? 0}`);
}
