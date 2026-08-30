import { serve } from '@hono/node-server';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@tsbb/db/migrate';
import { loadSettings, pruneExpired } from '@tsbb/core';
import { loadPlugins } from '@tsbb/plugin-host';
import { startWorker } from '../../worker/src/index.ts';
import { createApp } from './app.ts';

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
    startWorker({ baseUrl });
    console.log('[tsbb] worker running in-process');
  }

  const port = options.port ?? Number(process.env.TSBB_PORT ?? 3000);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[tsbb] listening on http://localhost:${info.port}  (base URL ${baseUrl})`);
  });
  return { app, registry, baseUrl, server };
}

if (import.meta.filename === process.argv[1]) {
  await boot();
}
