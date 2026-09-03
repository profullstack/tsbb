import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandCss } from './brand.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = join(HERE, '../../../design-tokens/src/tokens.css');

/**
 * The board ships three skins over one set of markup.
 *
 *   modern    cards, generous spacing, soft shadows
 *   classic   a 2000s bulletin board: boxy, dense, gradient title bars
 *   terminal  neutral surfaces, hairline rules, monospace chrome
 *
 * Each is a LAYER on top of the modern sheet rather than a replacement, so
 * there is exactly one place where a component's structure is defined and the
 * skin only argues about how it looks. A second full stylesheet would drift
 * from the first within a week.
 */
export type Skin = 'modern' | 'classic' | 'terminal';

export const SKINS: readonly Skin[] = ['modern', 'classic', 'terminal'];

const BASE = ['base.css', 'components.css', 'forum.css'];
const LAYER: Partial<Record<Skin, string>> = {
  classic: 'classic.css',
  terminal: 'terminal.css',
};

export interface Brand {
  /** `board.accent` as a hex value. Anything unparseable is ignored. */
  accent?: string | null;
}

/**
 * The browser-chrome colour for each skin, light and dark.
 *
 * Two values rather than one: a single theme-color paints a light bar above a
 * dark page on every mobile browser. These track each skin's --background,
 * because that is the surface the chrome is pretending to continue.
 */
export const SKIN_THEME_COLOR: Record<Skin, { light: string; dark: string }> = {
  modern: { light: '#fffcf9', dark: '#1a120c' },
  classic: { light: '#fffcf9', dark: '#1a120c' },
  terminal: { light: '#fefefe', dark: '#0b0b0b' },
};

/**
 * One stylesheet per skin and accent, assembled on demand and served under a
 * content hash.
 *
 * A hashed filename is what makes a long cache lifetime safe: the URL changes
 * whenever the bytes do, so a CSS fix — or a change of accent in the admin
 * panel — reaches a returning reader immediately instead of waiting out
 * whatever max-age the last deploy set. A stylesheet cached for an hour under
 * a stable name is a fix nobody can see.
 *
 * The accent is baked into the sheet rather than written as an inline <style>
 * because the board's Content-Security-Policy carries no 'unsafe-inline' in
 * style-src, and widening a policy for a handful of custom properties would be
 * a poor trade.
 */
const cache = new Map<string, { css: string; hash: string }>();

/**
 * Every sheet this process has built, by hash.
 *
 * A reader mid-navigation when the board changes skin or accent must still get
 * the sheet their page asked for, and that sheet is no longer any current
 * setting's — so it is remembered here rather than re-derived from settings.
 */
const byHash = new Map<string, { css: string; hash: string }>();

export function stylesheet(
  skin: Skin = 'modern',
  brand: Brand = {},
): { css: string; hash: string } {
  const accent = brand.accent ?? '';
  const key = `${skin}|${accent}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const chunks = [readFileSync(TOKENS, 'utf8')];
  for (const part of BASE) chunks.push(readFileSync(join(HERE, part), 'utf8'));
  const layer = LAYER[skin];
  if (layer) chunks.push(readFileSync(join(HERE, layer), 'utf8'));
  // The accent goes last so it wins over both the base tokens and the skin's
  // own palette: a skin says how the board is shaped, the accent says what
  // colour it is.
  const tail = brandCss(accent);
  if (tail) chunks.push(tail);

  const css = chunks.join('\n');
  const hash = createHash('sha256').update(css).digest('hex').slice(0, 12);
  const built = { css, hash };
  cache.set(key, built);
  byHash.set(hash, built);
  return built;
}

/** Any sheet this process has served, so an older page's URL still resolves. */
export function stylesheetForHash(hash: string): { css: string; hash: string } | null {
  const hit = byHash.get(hash);
  if (hit) return hit;
  // A skin whose sheet has not been built yet in this process: the first
  // request after a restart can arrive carrying a hash from before it.
  for (const skin of SKINS) {
    const sheet = stylesheet(skin);
    if (sheet.hash === hash) return sheet;
  }
  return null;
}

export function stylesheetUrl(skin: Skin = 'modern', brand: Brand = {}): string {
  return `/assets/app.${stylesheet(skin, brand).hash}.css`;
}

export function isSkin(value: unknown): value is Skin {
  return SKINS.includes(value as Skin);
}
