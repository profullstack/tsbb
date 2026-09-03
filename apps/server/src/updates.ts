import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { applyUpdate, checkForUpdate, installKind, loadSettings } from '@tsbb/core';

/*
 * The board keeps itself current.
 *
 * A minute after boot, and every five minutes after that, it asks GitHub for
 * the newest release. When there is one and the board runs from a git
 * checkout with `updates.auto` left on, it fetches the tag, installs, and
 * restarts itself. A container gets the check but not the apply — there is no
 * checkout inside it to move — so the admin panel shows the new version and
 * the operator redeploys.
 *
 * TSBB_UPDATES=off stops the check as well as the apply, for a board whose
 * operator would rather it never phoned anywhere.
 */

const FIRST_CHECK_MS = 60_000;
const INTERVAL_MS = 5 * 60_000;

type Closable = Pick<Server, 'close' | 'closeAllConnections'>;

let listening: Closable | null = null;
let restarting = false;

export function updatesEnabled(): boolean {
  return !['off', '0', 'false'].includes(String(process.env.TSBB_UPDATES ?? '').toLowerCase());
}

/** Remember the listener so a restart can stop taking requests before it exits. */
export function registerServer(server: Closable): void {
  listening = server;
}

/**
 * Hand the port to a fresh copy of this process and leave.
 *
 * The replacement is spawned detached with the same command line and
 * environment, so `pnpm start` in a terminal, nohup, tmux and the like all
 * carry on with the new code. Under a supervisor that restarts on exit
 * (systemd with Restart=always, pm2, Docker) the exit alone is enough, and
 * TSBB_RESTART=exit skips the spawn so the supervisor's copy is the only one.
 */
export function restartProcess(reason: string): void {
  if (restarting) return;
  restarting = true;
  console.log(`[tsbb] restarting: ${reason}`);

  const finish = () => {
    if (String(process.env.TSBB_RESTART ?? 'respawn').toLowerCase() !== 'exit') {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: 'inherit',
      });
      child.unref();
    }
    process.exit(0);
  };

  if (!listening) {
    finish();
    return;
  }
  // Stop accepting, let in-flight requests finish, then cut what is left.
  const server = listening;
  server.close(() => finish());
  setTimeout(() => {
    server.closeAllConnections?.();
    finish();
  }, 5_000).unref();
}

/**
 * One check, and the apply if it is due. Returns what it did, for the log and
 * for the admin "Check now" button, which runs exactly this.
 */
export async function runUpdateCycle(options: { apply?: boolean } = {}): Promise<string> {
  const check = await checkForUpdate();
  if (!check.available || !check.latest) return `up to date at ${check.current}`;

  const settings = await loadSettings();
  const auto = options.apply ?? settings['updates.auto'] !== false;
  if (!auto) return `${check.latest.version} is available; automatic updates are off`;
  if (installKind() !== 'git') return `${check.latest.version} is available; redeploy to get it`;

  await applyUpdate(check.latest.version, { log: (line) => console.log(`[tsbb] update: ${line}`) });
  restartProcess(`updated to ${check.latest.version}`);
  return `updated to ${check.latest.version}, restarting`;
}

export function startUpdater(): void {
  if (!updatesEnabled()) {
    console.log('[tsbb] updates: off (TSBB_UPDATES)');
    return;
  }
  const tick = async () => {
    try {
      const outcome = await runUpdateCycle();
      console.log(`[tsbb] updates: ${outcome}`);
    } catch (error) {
      console.warn(`[tsbb] updates: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), INTERVAL_MS).unref();
  }, FIRST_CHECK_MS).unref();
}
