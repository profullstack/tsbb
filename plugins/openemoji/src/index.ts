import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { definePlugin } from '@tsbb/plugin-api';
import { buildSet, emojiKey, renderEmoji, type EmojiIndex } from './render.ts';

/**
 * Emoji drawn with our own sets: OpenEmoji for the emoji, OpenIcon for the
 * picker's buttons. On by default.
 *
 * - Posts and signatures show emoji (typed, pasted or picked) and :shortcodes:
 *   as OpenEmoji images. The stored body keeps the Unicode character.
 * - Every composer gets an emoji picker. Without script it is a row of popular
 *   emoji with their shortcodes; /p/openemoji/a/picker.js (allowed by the
 *   board's `script-src 'self'`) adds search, groups, recents and insert at
 *   the caret.
 * - Every file is served from this plugin, so nothing loads from another origin.
 */

const ASSETS = join(import.meta.dirname, '..', 'assets');
const BASE = '/p/openemoji/a';

const index = JSON.parse(readFileSync(join(ASSETS, 'index.json'), 'utf8')) as EmojiIndex;
const set = buildSet(index);

/** Shown in the picker before any script runs, and as its first row after. */
const POPULAR = ['😀', '😂', '😊', '😍', '🤔', '😅', '😭', '😎', '👍', '👎', '👏', '🙏', '🔥', '🎉', '❤️', '💯', '🚀', '👀', '✅', '❌'];

const FILES: Record<string, { type: string; maxAge: number }> = {
  'index.json': { type: 'application/json; charset=utf-8', maxAge: 86400 },
  'sprite.svg': { type: 'image/svg+xml', maxAge: 86400 },
  'picker.js': { type: 'text/javascript; charset=utf-8', maxAge: 3600 },
  'openemoji.css': { type: 'text/css; charset=utf-8', maxAge: 3600 },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function icon(name: string): string {
  return `<svg class="oe-icon" width="18" height="18" aria-hidden="true" focusable="false"><use href="${BASE}/sprite.svg#oi-${name}"/></svg>`;
}

function popularRow(): string {
  return POPULAR.map((char) => {
    const key = emojiKey(char);
    const e = set.byKey.get(key);
    if (!e) return '';
    return `<button type="button" class="oe-cell" data-char="${esc(char)}" title=":${esc(e.code)}:" aria-label="${esc(e.name)}"><img src="${BASE}/64/${key}.webp" alt="${esc(char)}" width="24" height="24" loading="lazy"></button>`;
  }).join('');
}

export default definePlugin({
  manifest: {
    slug: 'openemoji',
    name: 'OpenEmoji',
    version: '0.1.0',
    description: 'An emoji picker in every composer, and emoji drawn with OpenEmoji in posts and signatures.',
    license: 'MIT',
    defaultEnabled: true,
    capabilities: ['render:pages'],
    settings: [
      { key: 'images', label: 'Draw emoji in posts with OpenEmoji images', type: 'boolean', default: true },
      { key: 'shortcodes', label: 'Turn :shortcodes: (like :rocket:) into emoji', type: 'boolean', default: true },
      { key: 'picker', label: 'Show the emoji picker in composers', type: 'boolean', default: true },
    ],
  },

  async setup(ctx) {
    const render = (html: string) =>
      ctx.settings.get('images') === false
        ? html
        : renderEmoji(html, set, { base: BASE, shortcodes: ctx.settings.get('shortcodes') !== false });

    ctx.filter('post:render', (html) => render(html));
    ctx.filter('signature:render', (html) => render(html));

    ctx.slot('layout:head', () => `<link rel="stylesheet" href="${BASE}/openemoji.css">`);

    ctx.slot('composer:toolbar', () => {
      if (ctx.settings.get('picker') === false) return null;
      return `<details class="oe-picker" data-base="${BASE}">
  <summary class="oe-summary" title="Emoji">${icon('smile')}<span>Emoji</span></summary>
  <div class="oe-panel">
    <div class="oe-popular">${popularRow()}</div>
    <p class="oe-hint">Or type a shortcode such as <code>:rocket:</code>. <a href="/p/openemoji/list">Every shortcode</a></p>
  </div>
</details><script src="${BASE}/picker.js" defer></script>`;
    });

    ctx.route('GET', '/a/*', async (req) => {
      const name = req.params['*'] ?? '';
      const webp = /^64\/([0-9a-f]+(?:-[0-9a-f]+)*)\.webp$/.exec(name);
      const file = webp ? (set.keys.has(webp[1] ?? '') ? { type: 'image/webp', maxAge: 604800 } : null) : FILES[name];
      if (!file) return new Response('Not found', { status: 404 });
      return new Response(await readFile(join(ASSETS, name)), {
        headers: {
          'Content-Type': file.type,
          'Cache-Control': `public, max-age=${file.maxAge}`,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });

    ctx.route('GET', '/list', () => {
      const rows = index.groups
        .map((group, g) => {
          const cells = index.emoji
            .filter((e) => e[2] === g)
            .map(([char, name]) => {
              const key = emojiKey(char);
              const code = set.byKey.get(key)!.code;
              return `<li><img src="${BASE}/64/${key}.webp" alt="${esc(char)}" width="24" height="24" loading="lazy"> <code>:${esc(code)}:</code> <span>${esc(name)}</span></li>`;
            })
            .join('');
          return `<h2>${esc(group)}</h2><ul class="oe-list">${cells}</ul>`;
        })
        .join('');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Emoji shortcodes</title><link rel="stylesheet" href="${BASE}/openemoji.css"></head><body class="oe-list-page"><h1>Emoji shortcodes</h1><p>Type any of these in a post. Emoji by <a href="https://github.com/profullstack/openemoji">OpenEmoji</a> (CC BY 4.0, Profullstack, Inc.).</p>${rows}</body></html>`;
    });

    ctx.log.info(`OpenEmoji: ${set.keys.size} emoji, ${set.shortcodes.size} shortcodes`);
  },
});
