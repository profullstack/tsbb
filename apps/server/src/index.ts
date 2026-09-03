import { serve } from '@hono/node-server';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@tsbb/db/migrate';
import { loadSettings, pruneExpired } from '@tsbb/core';
import { loadPlugins } from '@tsbb/plugin-host';
import { startWorker } from '../../worker/src/index.ts';
import { createApp } from './app.ts';
import { registerServer, startUpdater } from './updates.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

export async function boot(options: { port?: number; listen?: boolean } = {}) {
  const baseUrl = process.env.TSBB_BASE_URL ?? `http://localhost:${options.port ?? 3000}`;

  // Migrations run at boot rather than in a deploy step, so a self-hoster who
  // pulls a new version and restarts is never running old schema against new
  // code — the failure mode that turns an upgrade into an outage.
  const applied = await migrate(undefined, { quiet: true });
  if (applied.length) console.log(`[tsbb] applied ${applied.length} migration(s)`);

  await loadSettings(true);
  await pruneExpired();

  const registry = await loadPlugins({
    bundledRoot: join(REPO_ROOT, 'plugins'),
    baseUrl,
  });
  const enabled = [...registry.enabled];
  console.log(`[tsbb] plugins: ${enabled.length ? enabled.join(', ') : 'none enabled'}`);
  for (const [slug, error] of registry.errors) console.warn(`[tsbb] plugin ${slug}: ${error}`);

  await registry.bus.emit('boot', { startedAt: Date.now() });

  const app = createApp(registry, baseUrl);
  if (options.listen === false) return { app, registry, baseUrl };

  /*
   * The worker runs in-process by default, so a self-hoster gets working email
   * from one command. Set TSBB_WORKER=external once the board is big enough to
   * want it on its own box, and run `pnpm worker` there instead.
   */
  if (process.env.TSBB_WORKER !== 'external') {
    startWorker({ baseUrl, bus: registry.bus });
    console.log('[tsbb] worker running in-process');
  }

  /*
   * PORT is what every platform-as-a-service injects, and binding the wrong one
   * fails as a healthcheck timeout with a perfectly healthy process — the
   * platform is knocking on a port nothing is listening to. TSBB_PORT stays
   * first so a self-hoster can be explicit.
   */
  const port = options.port ?? Number(process.env.TSBB_PORT ?? process.env.PORT ?? 3000);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[tsbb] listening on http://localhost:${info.port}  (base URL ${baseUrl})`);
  });

  // The board checks for a new release once it is up, and installs it unless
  // an administrator has said not to. See updates.ts for what "installs" means
  // for a checkout versus a container.
  registerServer(server as unknown as Parameters<typeof registerServer>[0]);
  startUpdater();
  return { app, registry, baseUrl, server };
}

if (import.meta.filename === process.argv[1]) {
  await boot();
}
