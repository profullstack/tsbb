import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { all, now, run } from '@tsbb/db';
import { migratePlugin } from '@tsbb/db/migrate';
import type { Plugin, PluginManifest } from '@tsbb/plugin-api';
import { HookBus } from './bus.ts';
import { buildContext, type ContextDeps, type RegisteredRoute } from './context.ts';

export interface DiscoveredPlugin {
  slug: string;
  root: string;
  entry: string;
  source: 'bundled' | 'local' | 'package';
  manifest: PluginManifest | null;
  module: Plugin | null;
  error: string | null;
}

export interface PluginRow {
  slug: string;
  name: string;
  version: string;
  source: string;
  enabled: number;
  config: string;
  last_error: string | null;
}

/**
 * Where plugins come from, in precedence order:
 *
 *   bundled  `plugins/` in the tsbb checkout — ships with the board
 *   local    `TSBB_PLUGIN_DIR` (default `./plugins` beside the working dir)
 *   package  any dependency named `tsbb-plugin-*` or `@scope/tsbb-plugin-*`
 *
 * A later source with the same slug wins, so an operator can shadow a bundled
 * plugin with a patched copy without editing the checkout.
 */
export function pluginSearchPaths(bundledRoot: string): { dir: string; source: DiscoveredPlugin['source'] }[] {
  const paths: { dir: string; source: DiscoveredPlugin['source'] }[] = [];
  if (existsSync(bundledRoot)) paths.push({ dir: bundledRoot, source: 'bundled' });
  const local = resolve(process.env.TSBB_PLUGIN_DIR ?? './plugins');
  if (local !== bundledRoot && existsSync(local)) paths.push({ dir: local, source: 'local' });
  return paths;
}

function readManifestFile(root: string): Partial<PluginManifest> | null {
  for (const name of ['plugin.json', 'tsbb.plugin.json']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Partial<PluginManifest>;
    } catch {
      return null;
    }
  }
  return null;
}

function entryPointFor(root: string): string | null {
  for (const candidate of ['src/index.ts', 'index.ts', 'src/index.js', 'index.js', 'dist/index.js']) {
    const file = join(root, candidate);
    if (existsSync(file)) return file;
  }
  return null;
}

export async function discover(bundledRoot: string): Promise<DiscoveredPlugin[]> {
  const found = new Map<string, DiscoveredPlugin>();

  for (const { dir, source } of pluginSearchPaths(bundledRoot)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const root = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(root).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const entry = entryPointFor(root);
      if (!entry) continue;

      const record: DiscoveredPlugin = {
        slug: name,
        root,
        entry,
        source,
        manifest: null,
        module: null,
        error: null,
      };

      try {
        const mod = (await import(pathToFileURL(entry).href)) as {
          default?: Plugin;
          plugin?: Plugin;
        };
        const plugin = mod.default ?? mod.plugin ?? null;
        if (!plugin?.manifest || typeof plugin.setup !== 'function') {
          record.error = 'module does not default-export a plugin with a manifest and setup()';
        } else {
          // A plugin.json, if present, fills in anything the module left out.
          const file = readManifestFile(root);
          record.manifest = { ...file, ...plugin.manifest } as PluginManifest;
          record.slug = record.manifest.slug || name;
          record.module = plugin;
        }
      } catch (error) {
        record.error = (error as Error).message;
      }

      found.set(record.slug, record);
    }
  }

  return [...found.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface Registry {
  bus: HookBus;
  routes: RegisteredRoute[];
  plugins: Map<string, DiscoveredPlugin>;
  enabled: Set<string>;
  errors: Map<string, string>;
  reload(): Promise<void>;
  setEnabled(slug: string, enabled: boolean): Promise<void>;
  config(slug: string): Record<string, unknown>;
}

/**
 * Load every discovered plugin, honouring the database's enable flags.
 *
 * `defaultEnabled` is consulted only the first time a plugin is seen. After
 * that the row wins, so an admin who turns something off keeps it off across
 * upgrades — including the ads plugin, which ships on.
 */
export async function loadPlugins(options: {
  bundledRoot: string;
  baseUrl: string;
}): Promise<Registry> {
  const configCache = new Map<string, Record<string, unknown>>();
  const errors = new Map<string, string>();
  const enabled = new Set<string>();
  let plugins = new Map<string, DiscoveredPlugin>();

  const bus = new HookBus((slug, hook, error) => {
    const message = error instanceof Error ? error.message : String(error);
    errors.set(slug, `${hook}: ${message}`);
    console.error(`[plugin:${slug}] ${hook} failed:`, error);
    void run('UPDATE plugins SET last_error = ? WHERE slug = ?', [`${hook}: ${message}`, slug]);
  });
  const routes: RegisteredRoute[] = [];
  const deps: ContextDeps = { bus, routes, baseUrl: options.baseUrl, configCache };

  const registry: Registry = {
    bus,
    routes,
    plugins,
    enabled,
    errors,
    config: (slug) => configCache.get(slug) ?? {},

    async reload() {
      routes.length = 0;
      enabled.clear();
      errors.clear();
      for (const slug of plugins.keys()) bus.removePlugin(slug);

      const discovered = await discover(options.bundledRoot);
      plugins = new Map(discovered.map((p) => [p.slug, p]));
      registry.plugins = plugins;

      const rows = await all<PluginRow>('SELECT * FROM plugins');
      const known = new Map(rows.map((r) => [r.slug, r]));

      for (const found of discovered) {
        if (found.error || !found.manifest || !found.module) {
          if (found.error) errors.set(found.slug, found.error);
          continue;
        }
        const manifest = found.manifest;
        const row = known.get(found.slug);
        const isNew = !row;
        const shouldEnable = isNew ? manifest.defaultEnabled === true : row.enabled === 1;

        const config = row ? safeParse(row.config) : {};
        configCache.set(found.slug, config);

        await run(
          `INSERT INTO plugins (slug, name, version, source, entry, enabled, config, installed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (slug) DO UPDATE SET
             name = excluded.name, version = excluded.version,
             source = excluded.source, entry = excluded.entry, updated_at = excluded.updated_at`,
          [
            found.slug,
            manifest.name,
            manifest.version,
            found.source,
            found.entry,
            shouldEnable ? 1 : 0,
            JSON.stringify(config),
            now(),
            now(),
          ],
        );

        if (!shouldEnable) continue;

        try {
          if (manifest.migrations) {
            await migratePlugin(found.slug, join(found.root, manifest.migrations));
          }
          await found.module.setup(buildContext(found.module, deps));
          enabled.add(found.slug);
          await run('UPDATE plugins SET last_error = NULL WHERE slug = ?', [found.slug]);
        } catch (error) {
          const message = (error as Error).message;
          errors.set(found.slug, message);
          bus.removePlugin(found.slug);
          // A plugin that throws in setup is left registered but off, so the
          // board boots and the admin panel can say which one failed and why.
          await run('UPDATE plugins SET enabled = 0, last_error = ? WHERE slug = ?', [
            message,
            found.slug,
          ]);
          console.error(`[plugin:${found.slug}] setup failed, disabling:`, error);
        }
      }
    },

    async setEnabled(slug: string, on: boolean) {
      await run('UPDATE plugins SET enabled = ?, updated_at = ?, last_error = NULL WHERE slug = ?', [
        on ? 1 : 0,
        now(),
        slug,
      ]);
      await registry.reload();
    },
  };

  await registry.reload();
  return registry;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
