import type { Id, Notification, Viewer } from './entities.ts';
import type {
  ActionHandler,
  ActionName,
  FilterHandler,
  FilterName,
  SlotHandler,
  SlotName,
} from './hooks.ts';
import type { PluginManifest } from './manifest.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The minimum a route handler needs, so a plugin does not import Hono itself. */
export interface PluginRequest {
  method: string;
  url: URL;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Headers;
  viewer: Viewer;
  json<T = unknown>(): Promise<T>;
  form(): Promise<Record<string, string>>;
  text(): Promise<string>;
}

export type PluginResponse = Response | string | object | null | void;
export type PluginRouteHandler = (req: PluginRequest) => PluginResponse | Promise<PluginResponse>;

export interface RouteOptions {
  /** Refuse the request unless the viewer clears this bar. Default 'guest'. */
  requires?: 'guest' | 'user' | 'moderator' | 'admin';
  /** Requests per minute per viewer. Counted off the shared audit ledger. */
  rateLimit?: number;
}

/** Typed settings access. Reads are cached per request; writes persist. */
export interface PluginSettings {
  get<T = unknown>(key: string): T | undefined;
  all(): Record<string, unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** A small key/value store so a plugin need not ship a migration to remember. */
export interface PluginData {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

export interface PluginLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/**
 * What `setup()` receives. Everything a plugin can do to the board goes through
 * here, which makes the surface auditable: reading this interface tells you the
 * whole of what a plugin is able to reach.
 *
 * Note the trust model. A plugin is code running in the board's own process,
 * exactly as in phpBB or WordPress — this context is an ergonomic API, not a
 * sandbox. Installing a plugin is installing code. The admin panel says so.
 */
export interface PluginContext {
  manifest: PluginManifest;
  settings: PluginSettings;
  data: PluginData;
  log: PluginLogger;

  /** Transform a value. Handlers run in registration order, each seeing the last one's output. */
  filter<K extends FilterName>(hook: K, handler: FilterHandler<K>, weight?: number): void;

  /** React to something that happened. Handlers run concurrently; a rejection is logged, not thrown. */
  on<K extends ActionName>(hook: K, handler: ActionHandler<K>): void;

  /** Contribute markup at a named place in a page. */
  slot<K extends SlotName>(name: K, handler: SlotHandler<K>, weight?: number): void;

  /** Mount a route under `/p/<slug>`. The prefix is added for you. */
  route(method: HttpMethod, path: string, handler: PluginRouteHandler, options?: RouteOptions): void;

  /** Raise a notification of kind `plugin:<slug>`. */
  notify(input: {
    userId: Id;
    title: string;
    excerpt?: string;
    url?: string;
    dedupeKey?: string;
    email?: boolean;
    data?: Record<string, unknown>;
  }): Promise<Notification>;

  /** Read-only board queries. A plugin that needs more uses its own tables. */
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T[]>;

  /** Absolute URL for a board-relative path, using the configured base URL. */
  url(path: string): string;
}

export interface Plugin {
  manifest: PluginManifest;
  setup(ctx: PluginContext): void | Promise<void>;
  teardown?(ctx: PluginContext): void | Promise<void>;
}

/** Helper that gives a plugin module its types without a cast. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
