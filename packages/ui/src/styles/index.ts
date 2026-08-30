import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = join(HERE, '../../../design-tokens/src/tokens.css');

/**
 * One stylesheet, assembled at boot and served with a content hash in its URL.
 *
 * A hashed filename is what makes a long cache lifetime safe: the URL changes
 * whenever the bytes do, so a CSS fix reaches a returning reader immediately
 * instead of waiting out whatever max-age the last deploy set. A stylesheet
 * cached for an hour under a stable name is a fix nobody can see.
 */
const PARTS = ['base.css', 'components.css', 'forum.css'];

let cached: { css: string; hash: string } | null = null;

export function stylesheet(): { css: string; hash: string } {
  if (cached) return cached;
  const chunks = [readFileSync(TOKENS, 'utf8')];
  for (const part of PARTS) chunks.push(readFileSync(join(HERE, part), 'utf8'));
  const css = chunks.join('\n');
  const hash = createHash('sha256').update(css).digest('hex').slice(0, 12);
  cached = { css, hash };
  return cached;
}

export function stylesheetUrl(): string {
  return `/assets/app.${stylesheet().hash}.css`;
}
