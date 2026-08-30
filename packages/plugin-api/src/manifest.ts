/** A setting a plugin exposes in the admin panel. */
export type SettingSpec =
  | {
      key: string;
      label: string;
      type: 'string';
      default?: string;
      help?: string;
      placeholder?: string;
      secret?: boolean;
      /** The plugin does nothing without it; the admin panel says so when it is blank. */
      required?: boolean;
    }
  | { key: string; label: string; type: 'number'; default?: number; help?: string; min?: number; max?: number }
  | { key: string; label: string; type: 'boolean'; default?: boolean; help?: string }
  | { key: string; label: string; type: 'select'; default?: string; help?: string; options: { value: string; label: string }[] }
  | { key: string; label: string; type: 'text'; default?: string; help?: string; rows?: number };

export interface PluginManifest {
  /** Stable identifier. Also the URL prefix (`/p/<slug>`) and the config key. */
  slug: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  /** Semver range of tsbb core this plugin supports. */
  engines?: { tsbb?: string };
  /** Settings rendered in the admin panel and validated on save. */
  settings?: SettingSpec[];
  /** Directory of the plugin's own .sql migrations, relative to its root. */
  migrations?: string;
  /**
   * Bundled plugins may ask to be on from a fresh install. Only ever consulted
   * the first time a plugin is registered; after that the database wins, so
   * an admin who turns something off keeps it off across upgrades.
   */
  defaultEnabled?: boolean;
  /** Shown in the admin panel so an admin can see what a plugin can reach. */
  capabilities?: PluginCapability[];
}

export type PluginCapability =
  | 'read:posts'
  | 'write:posts'
  | 'read:users'
  | 'write:users'
  | 'render:pages'
  | 'send:mail'
  | 'network'
  | 'moderate';

export function defaultSettings(manifest: PluginManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of manifest.settings ?? []) {
    if (spec.default !== undefined) out[spec.key] = spec.default;
  }
  return out;
}
