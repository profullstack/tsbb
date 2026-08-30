import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the terminal keeps which board it talks to and the token for it.
 *
 * Tokens are credentials, so the file is written 0600 and the directory 0700.
 * Several boards can be configured at once — people belong to more than one
 * forum — keyed by server URL, with one marked current.
 */
export interface BoardConfig {
  server: string;
  token: string | null;
  username?: string | null;
}

export interface Config {
  current: string | null;
  boards: Record<string, BoardConfig>;
}

const EMPTY: Config = { current: null, boards: {} };

export function configPath(): string {
  const base =
    process.env.TSBB_CONFIG_DIR ??
    process.env.XDG_CONFIG_HOME ??
    join(homedir(), '.config');
  return join(base, 'tsbb', 'config.json');
}

export function loadConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<Config>;
    return {
      current: parsed.current ?? null,
      boards: parsed.boards ?? {},
    };
  } catch {
    // A missing or unreadable config is the first-run case, not an error.
    return { ...EMPTY, boards: {} };
  }
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    // writeFileSync only applies its mode when it creates the file, so an
    // existing config written before this rule would keep its old permissions.
    chmodSync(path, 0o600);
  } catch {
    // Best effort: a filesystem that refuses chmod is not a reason to fail.
  }
}

export function normaliseServer(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  // A bare hostname is almost always meant as https; localhost almost never is.
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(trimmed) ? 'http' : 'https';
  return `${scheme}://${trimmed}`;
}

export function currentBoard(config: Config): BoardConfig | null {
  if (!config.current) return null;
  return config.boards[config.current] ?? null;
}

export function rememberBoard(board: BoardConfig): Config {
  const config = loadConfig();
  const server = normaliseServer(board.server);
  config.boards[server] = { ...board, server };
  config.current = server;
  saveConfig(config);
  return config;
}
