import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = join(HERE, '../../../design-tokens/src/tokens.css');

/**
 * The board ships two skins over one set of markup.
 *
 *   modern   cards, generous spacing, soft shadows
 *   classic  a 2000s bulletin board: boxy, dense, gradient title bars
 *
 * `classic` is a layer ON TOP of the modern sheet rather than a replacement, so
 * there is exactly one place where a component's structure is defined and the
 * skin only argues about how it looks. A second full stylesheet would drift
 * from the first within a week.
 */
export type Skin = 'modern' | 'classic';

const BASE = ['base.css', 'components.css', 'forum.css'];

/**
 * One stylesheet per skin, assembled at boot and served under a content hash.
 *
 * A hashed filename is what makes a long cache lifetime safe: the URL changes
 * whenever the bytes do, so a CSS fix reaches a returning reader immediately
 * instead of waiting out whatever max-age the last deploy set. A stylesheet
 * cached for an hour under a stable name is a fix nobody can see.
 */
const cache = new Map<Skin, { css: string; hash: string }>();

export function stylesheet(skin: Skin = 'modern'): { css: string; hash: string } {
  const hit = cache.get(skin);
  if (hit) return hit;

  const chunks = [readFileSync(TOKENS, 'utf8')];
  for (const part of BASE) chunks.push(readFileSync(join(HERE, part), 'utf8'));
  if (skin === 'classic') chunks.push(readFileSync(join(HERE, 'classic.css'), 'utf8'));

  const css = chunks.join('\n');
  const hash = createHash('sha256').update(css).digest('hex').slice(0, 12);
  const built = { css, hash };
  cache.set(skin, built);
  return built;
}

/** Every skin's hash, so the asset route can answer for any of them. */
export function stylesheetForHash(hash: string): { css: string; hash: string } | null {
  for (const skin of ['modern', 'classic'] as const) {
    const sheet = stylesheet(skin);
    if (sheet.hash === hash) return sheet;
  }
  return null;
}

export function stylesheetUrl(skin: Skin = 'modern'): string {
  return `/assets/app.${stylesheet(skin).hash}.css`;
}

export function isSkin(value: unknown): value is Skin {
  return value === 'modern' || value === 'classic';
}
