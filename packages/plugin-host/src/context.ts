import { all, now, one, run } from '@tsbb/db';
import type {
  Id,
  Notification,
  Plugin,
  PluginContext,
  PluginData,
  PluginRouteHandler,
  PluginSettings,
  RouteOptions,
  HttpMethod,
} from '@tsbb/plugin-api';
import { defaultSettings } from '@tsbb/plugin-api';
import type { HookBus } from './bus.ts';

export interface RegisteredRoute {
  slug: string;
  method: HttpMethod;
  /** Already prefixed with `/p/<slug>`. */
  path: string;
  handler: PluginRouteHandler;
  options: RouteOptions;
}

export interface ContextDeps {
  bus: HookBus;
  routes: RegisteredRoute[];
  baseUrl: string;
  /** Written back by `settings.set` so the in-memory copy stays current. */
  configCache: Map<string, Record<string, unknown>>;
}

function makeSettings(slug: string, plugin: Plugin, deps: ContextDeps): PluginSettings {
  const defaults = defaultSettings(plugin.manifest);
  const read = () => ({ ...defaults, ...(deps.configCache.get(slug) ?? {}) });
  return {
    get<T = unknown>(key: string) {
      return read()[key] as T | undefined;
    },
    all() {
      return read();
    },
    async set(key: string, value: unknown) {
      const next = { ...(deps.configCache.get(slug) ?? {}), [key]: value };
      deps.configCache.set(slug, next);
      await run('UPDATE plugins SET config = ?, updated_at = ? WHERE slug = ?', [
        JSON.stringify(next),
        now(),
        slug,
      ]);
    },
  };
}

function makeData(slug: string): PluginData {
  return {
    async get<T = unknown>(key: string) {
      const row = await one<{ value: string }>(
        'SELECT value FROM plugin_data WHERE plugin_slug = ? AND key = ?',
        [slug, key],
      );
      if (!row) return undefined;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return undefined;
      }
    },
    async set(key: string, value: unknown) {
      await run(
        `INSERT INTO plugin_data (plugin_slug, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (plugin_slug, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [slug, key, JSON.stringify(value ?? null), now()],
      );
    },
    async delete(key: string) {
      await run('DELETE FROM plugin_data WHERE plugin_slug = ? AND key = ?', [slug, key]);
    },
    async keys(prefix = '') {
      const rows = await all<{ key: string }>(
        'SELECT key FROM plugin_data WHERE plugin_slug = ? AND key LIKE ? ORDER BY key',
        [slug, `${prefix}%`],
      );
      return rows.map((r) => r.key);
    },
  };
}

/**
 * `query` is deliberately read-only. A plugin that needs to write owns tables of
 * its own through a migration, which keeps a plugin's writes visible in the
 * schema rather than hidden inside arbitrary SQL.
 */
const WRITE_SQL = /^\s*(insert|update|delete|drop|alter|create|replace|attach|pragma|vacuum)\b/i;

export function buildContext(plugin: Plugin, deps: ContextDeps): PluginContext {
  const slug = plugin.manifest.slug;
  const prefix = `/p/${slug}`;

  return {
    manifest: plugin.manifest,
    settings: makeSettings(slug, plugin, deps),
    data: makeData(slug),
    log: {
      info: (m, d) => console.log(`[plugin:${slug}] ${m}`, d ?? ''),
      warn: (m, d) => console.warn(`[plugin:${slug}] ${m}`, d ?? ''),
      error: (m, d) => console.error(`[plugin:${slug}] ${m}`, d ?? ''),
    },

    filter(hook, handler, weight) {
      deps.bus.addFilter(slug, hook, handler, weight);
    },
    on(hook, handler) {
      deps.bus.addAction(slug, hook, handler);
    },
    slot(name, handler, weight) {
      deps.bus.addSlot(slug, name, handler, weight);
    },

    route(method, path, handler, options = {}) {
      const suffix = path.startsWith('/') ? path : `/${path}`;
      deps.routes.push({ slug, method, path: `${prefix}${suffix}`, handler, options });
    },

    async notify(input): Promise<Notification> {
      const createdAt = now();
      const kind = `plugin:${slug}`;
      const result = await run(
        `INSERT INTO notifications
           (user_id, kind, actor_id, subject_type, subject_id, url, title, excerpt, data, dedupe_key, created_at)
         VALUES (?, ?, NULL, 'plugin', NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND read_at IS NULL
         DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt, created_at = excluded.created_at
         RETURNING id`,
        [
          input.userId,
          kind,
          input.url ?? null,
          input.title,
          input.excerpt ?? null,
          JSON.stringify(input.data ?? {}),
          input.dedupeKey ?? null,
          createdAt,
        ],
      );
      const id = Number(result.rows[0]?.id ?? 0);
      return {
        id,
        userId: input.userId,
        kind,
        actorId: null,
        subjectType: 'plugin',
        subjectId: null,
        url: input.url ?? null,
        title: input.title,
        excerpt: input.excerpt ?? null,
        data: input.data ?? {},
        readAt: null,
        createdAt,
      };
    },

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      if (WRITE_SQL.test(sql)) {
        throw new Error(
          `[plugin:${slug}] ctx.query is read-only. Declare a migration and own your tables.`,
        );
      }
      return all<T>(sql, params as never);
    },

    url(path: string) {
      return new URL(path, deps.baseUrl).toString();
    },
  };
}

export type { Id };
