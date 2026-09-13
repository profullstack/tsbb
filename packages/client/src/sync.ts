/**
 * Settings sync: the boards you use, on every machine, through the board.
 *
 * ~/.config/tsbb/config.json holds two kinds of thing: which boards you
 * belong to and which is current (settings), and a token for each (a
 * credential). A credential never leaves the machine it was issued to, so
 * what syncs is a projection, `boards.json`, written beside the config from
 * everything but the tokens. Loading it on another machine adds the boards
 * it did not know, without tokens, and `tsbb login` fills those in.
 *
 * The mechanism is @profullstack/synconfig: one snapshot under a revision,
 * a conflict rather than a merge when two machines both saved, and a marker
 * so a load never overwrites an unsynced local edit. The current board's
 * API is the cloud.
 */
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createClient,
  load,
  save,
  status,
  type LoadResult,
  type SaveResult,
  type StatusResult,
  type SyncContext,
  type SyncPolicy,
} from '@profullstack/synconfig';
import { configPath, currentBoard, loadConfig, normaliseServer, saveConfig, type Config } from './config.ts';

/** The projection of config.json that may leave the machine. */
export const SETTINGS_FILE = 'boards.json';

export interface BoardSettings {
  current: string | null;
  boards: Record<string, { server: string; username?: string | null }>;
}

export const SYNC_POLICY: SyncPolicy = {
  files: [{ path: SETTINGS_FILE, json: true, label: 'boards' }],
  // The config itself carries tokens and is named here so no later edit can
  // let it through by accident; the marker is this machine's alone.
  never: ['config.json', 'sync.json'],
  neverSuffixes: ['.tmp', '.log'],
};

/** config.json minus every token. Pure. */
export function settingsFrom(config: Config): BoardSettings {
  const boards: BoardSettings['boards'] = {};
  for (const [key, board] of Object.entries(config.boards)) {
    boards[key] = { server: board.server, ...(board.username ? { username: board.username } : {}) };
  }
  return { current: config.current, boards };
}

/**
 * Fold synced settings into the local config: boards this machine has not
 * seen are added without a token, a username is filled in where the local
 * one is empty, and the current board is taken when none is set here. Tokens
 * are never touched. Pure; the caller saves. Returns what changed.
 */
export function applySettings(settings: BoardSettings, config: Config): { config: Config; added: string[]; current: string | null } {
  const next: Config = { current: config.current, boards: { ...config.boards } };
  const added: string[] = [];
  for (const [key, board] of Object.entries(settings.boards ?? {})) {
    if (typeof board?.server !== 'string' || !board.server) continue;
    const server = normaliseServer(board.server);
    const existing = next.boards[key] ?? next.boards[server];
    if (existing) {
      if (!existing.username && board.username) next.boards[key] = { ...existing, username: board.username };
      continue;
    }
    next.boards[server] = { server, token: null, ...(board.username ? { username: board.username } : {}) };
    added.push(server);
  }
  if (!next.current && settings.current && next.boards[settings.current]) next.current = settings.current;
  return { config: next, added, current: next.current };
}

export const settingsPath = (): string => `${dirname(configPath())}/${SETTINGS_FILE}`;

/** Write the projection beside the config, so the snapshot reads a file like any other. */
export function writeSettingsFile(config: Config = loadConfig()): string {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settingsFrom(config), null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function readSettingsFile(): BoardSettings | null {
  const path = settingsPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BoardSettings;
  } catch {
    return null;
  }
}

export interface SyncOptions {
  /** Sync through this board instead of the current one. */
  server?: string;
  fetch?: typeof fetch;
}

/** The board the snapshot lives at: the current one, with its token. Throws when there is none. */
export function syncContext(options: SyncOptions = {}): SyncContext {
  const config = loadConfig();
  const board = options.server ? config.boards[normaliseServer(options.server)] : currentBoard(config);
  if (!board?.token) throw new Error('Settings sync uses a board you are signed in to. Run `tsbb login <server>` first.');
  return {
    rootDir: dirname(configPath()),
    policy: SYNC_POLICY,
    client: createClient({ baseUrl: board.server, path: '/api/v1/settings', token: board.token, ...(options.fetch ? { fetchImpl: options.fetch } : {}) }),
    api: board.server,
    host: hostname(),
    app: 'tsbb',
  };
}

export async function syncSave(options: SyncOptions & { force?: boolean } = {}): Promise<SaveResult> {
  // The sign-in check comes first, so a machine with no board yet hears
  // "log in" rather than writing a projection of nothing.
  const ctx = syncContext(options);
  writeSettingsFile();
  return save(ctx, { force: options.force });
}

export async function syncLoad(options: SyncOptions & { force?: boolean; dryRun?: boolean } = {}): Promise<LoadResult & { added: string[] }> {
  const ctx = syncContext(options);
  writeSettingsFile();
  const result = await load(ctx, { force: options.force, dryRun: options.dryRun });
  let added: string[] = [];
  if (result.status === 'loaded' || result.status === 'same') {
    const synced = readSettingsFile();
    if (synced) {
      const applied = applySettings(synced, loadConfig());
      if (applied.added.length || applied.current !== loadConfig().current) saveConfig(applied.config);
      added = applied.added;
    }
  }
  return { ...result, added };
}

export async function syncStatus(options: SyncOptions = {}): Promise<StatusResult> {
  const ctx = syncContext(options);
  writeSettingsFile();
  return status(ctx);
}
