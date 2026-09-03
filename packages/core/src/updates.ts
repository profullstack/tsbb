import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadSettings, setSettings } from './settings.ts';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

/** The checkout this code runs from — the thing an update replaces. */
export const REPO_ROOT = resolve(HERE, '../../..');

/** Where releases are published. Overridable for a fork that cuts its own. */
export const UPDATE_REPO = process.env.TSBB_UPDATE_REPO ?? 'profullstack/tsbb';

/*
 * Updating a board is three commands a self-hoster would otherwise type by
 * hand every release: fetch the tag, check it out, install. This module runs
 * them, and records what it did in settings so the admin panel can show it —
 * the board is the only thing a self-hoster reliably looks at, so that is
 * where "there is a new version" and "the last update failed" have to appear.
 *
 * What it will NOT do is update a container. The Docker image is built from a
 * tree with no .git in it, so there is nothing to fetch into; an image is
 * updated by redeploying it, and the panel says so instead of trying.
 */

export type InstallKind = 'git' | 'image';

export interface Release {
  version: string;
  tag: string;
  url: string;
  publishedAt: string | null;
  notes: string;
}

export interface UpdateCheck {
  current: string;
  latest: Release | null;
  /** True when `latest` is newer than `current`. */
  available: boolean;
  kind: InstallKind;
  checkedAt: number;
}

export function currentVersion(root = REPO_ROOT): string {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    return String((JSON.parse(raw) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * Numeric compare of dotted versions: negative when a < b, positive when a > b.
 * A prerelease suffix sorts below the bare version it precedes, which is all
 * the release tags here ever need.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** A release tag the updater will act on. Anything else is ignored, not guessed at. */
export function isReleaseTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag);
}

/**
 * A git checkout can be moved to a tag; anything else was put here by a
 * process that will also be the one to replace it.
 */
export function installKind(root = REPO_ROOT): InstallKind {
  return existsSync(join(root, '.git')) ? 'git' : 'image';
}

export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
  repo = UPDATE_REPO,
): Promise<Release | null> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'tsbb-updater' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest release`);
  const body = (await response.json()) as {
    tag_name?: string;
    html_url?: string;
    published_at?: string | null;
    body?: string | null;
    draft?: boolean;
    prerelease?: boolean;
  };
  const tag = String(body.tag_name ?? '');
  if (!isReleaseTag(tag) || body.draft) return null;
  return {
    version: tag.replace(/^v/, ''),
    tag,
    url: String(body.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`),
    publishedAt: body.published_at ?? null,
    notes: String(body.body ?? ''),
  };
}

/**
 * Ask GitHub for the newest release and remember the answer.
 *
 * The result is written to settings rather than kept in memory so a board with
 * more than one process — or one that has just restarted — shows the same
 * answer everywhere, and so a failed check leaves a message rather than a blank.
 */
export async function checkForUpdate(
  options: { fetch?: typeof fetch; root?: string } = {},
): Promise<UpdateCheck> {
  const root = options.root ?? REPO_ROOT;
  const current = currentVersion(root);
  const checkedAt = Date.now();
  try {
    const latest = await fetchLatestRelease(options.fetch ?? fetch);
    await setSettings({
      'updates.latestVersion': latest?.version ?? null,
      'updates.latestUrl': latest?.url ?? null,
      'updates.checkedAt': checkedAt,
      'updates.checkError': null,
    });
    return {
      current,
      latest,
      available: latest !== null && compareVersions(latest.version, current) > 0,
      kind: installKind(root),
      checkedAt,
    };
  } catch (error) {
    await setSettings({
      'updates.checkedAt': checkedAt,
      'updates.checkError': error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** What the last check and the last apply left behind, for the panel. */
export interface UpdateState {
  current: string;
  kind: InstallKind;
  auto: boolean;
  latestVersion: string | null;
  latestUrl: string | null;
  checkedAt: number | null;
  checkError: string | null;
  available: boolean;
  appliedVersion: string | null;
  appliedAt: number | null;
  applyError: string | null;
}

export async function updateState(root = REPO_ROOT): Promise<UpdateState> {
  const settings = await loadSettings();
  const current = currentVersion(root);
  const latestVersion = (settings['updates.latestVersion'] as string | null | undefined) ?? null;
  return {
    current,
    kind: installKind(root),
    auto: settings['updates.auto'] !== false,
    latestVersion,
    latestUrl: (settings['updates.latestUrl'] as string | null | undefined) ?? null,
    checkedAt: (settings['updates.checkedAt'] as number | null | undefined) ?? null,
    checkError: (settings['updates.checkError'] as string | null | undefined) ?? null,
    available: latestVersion !== null && compareVersions(latestVersion, current) > 0,
    appliedVersion: (settings['updates.appliedVersion'] as string | null | undefined) ?? null,
    appliedAt: (settings['updates.appliedAt'] as number | null | undefined) ?? null,
    applyError: (settings['updates.applyError'] as string | null | undefined) ?? null,
  };
}

export interface ApplyOptions {
  root?: string;
  log?: (line: string) => void;
  /** Injected for tests; the real thing runs git and pnpm. */
  run?: (file: string, args: string[], cwd: string) => Promise<{ stdout: string }>;
}

async function realRun(file: string, args: string[], cwd: string): Promise<{ stdout: string }> {
  const { stdout } = await exec(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, env: process.env });
  return { stdout: String(stdout) };
}

/**
 * Move this checkout to a release tag and install its dependencies.
 *
 * Refuses rather than guesses: not a git checkout, a tag that is not a release,
 * or local edits in the tree all stop it before anything is touched. A tree
 * with local changes is somebody's work in progress, and an update that threw
 * it away would be the worst thing this code could do.
 *
 * If the install fails the checkout goes back to where it was, so a half-done
 * update never leaves new code without its dependencies. The caller restarts
 * the process; this only changes what is on disk.
 */
export async function applyUpdate(version: string, options: ApplyOptions = {}): Promise<void> {
  const root = options.root ?? REPO_ROOT;
  const log = options.log ?? (() => {});
  const run = options.run ?? realRun;
  const tag = version.startsWith('v') ? version : `v${version}`;

  if (!isReleaseTag(tag)) throw new Error(`${tag} is not a release tag`);
  if (installKind(root) !== 'git') {
    throw new Error('This board was not installed from a git checkout; update it by redeploying.');
  }

  const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'], root)).stdout.trim();
  if (dirty) throw new Error('The checkout has local changes; commit or discard them first.');

  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim();
  const previous = branch === 'HEAD' ? (await run('git', ['rev-parse', 'HEAD'], root)).stdout.trim() : branch;

  log(`fetching ${tag}`);
  await run('git', ['fetch', '--quiet', '--tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], root);
  log(`checking out ${tag}`);
  await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', tag], root);

  try {
    log('installing dependencies');
    await runPnpm(run, ['install', '--frozen-lockfile', '--ignore-scripts'], root);
  } catch (error) {
    log(`install failed, returning to ${previous}`);
    await run('git', ['checkout', '--quiet', previous], root).catch(() => {});
    await runPnpm(run, ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'], root).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    await setSettings({ 'updates.applyError': message });
    throw new Error(`Installing ${tag} failed and the previous version was restored: ${message}`);
  }

  await setSettings({
    'updates.appliedVersion': tag.replace(/^v/, ''),
    'updates.appliedAt': Date.now(),
    'updates.applyError': null,
  });
  log(`now at ${tag}`);
}

/**
 * pnpm by name if it is on the PATH, else through corepack, which the
 * repository's packageManager field points at anyway. A board that could be
 * installed had one of the two.
 */
async function runPnpm(run: NonNullable<ApplyOptions['run']>, args: string[], cwd: string) {
  try {
    return await run('pnpm', args, cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return run('corepack', ['pnpm', ...args], cwd);
  }
}
