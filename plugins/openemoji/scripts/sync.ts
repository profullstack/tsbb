/**
 * Copy our own emoji and icon sets into the plugin:
 *
 *   node plugins/openemoji/scripts/sync.ts [--openemoji <dir>] [--openicon <dir>]
 *
 * The directories are checkouts of github.com/profullstack/openemoji and
 * github.com/profullstack/openicon, defaulting to siblings of this repository.
 * Writes only generated files, all under plugins/openemoji/assets:
 *
 *   64/<key>.webp   every base emoji (skin-tone variants stay native text)
 *   index.json      names, groups and search words: the picker and the renderer
 *   sprite.svg      the OpenIcon symbols the picker draws
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const plugin = resolve(import.meta.dirname, '..');
const repo = resolve(plugin, '..', '..');

function arg(name: string, fallback: string): string {
  const value = process.argv[process.argv.indexOf(`--${name}`) + 1];
  return process.argv.includes(`--${name}`) && value ? resolve(value) : fallback;
}

const emojiDir = arg('openemoji', resolve(repo, '..', 'openemoji'));
const iconDir = arg('openicon', resolve(repo, '..', 'openicon'));

export const ICONS = [
  'smile', 'search', 'close', 'clock', 'users', 'leaf', 'coffee', 'globe', 'trophy', 'lightbulb', 'hash', 'flag',
];

for (const [label, dir, file] of [
  ['openemoji', emojiDir, 'openemoji.json'],
  ['openicon', iconDir, 'openicon.json'],
] as const) {
  if (!existsSync(join(dir, file))) {
    console.error(`No ${file} in ${dir}. Pass --${label} <checkout of github.com/profullstack/${label}>.`);
    process.exit(1);
  }
}

interface Entry {
  key: string;
  char: string;
  name: string;
  group: string;
  keywords?: string[];
  webp: string;
  base?: string;
}

const set = JSON.parse(readFileSync(join(emojiDir, 'openemoji.json'), 'utf8')) as {
  openemoji: string;
  version: string;
  license: string;
  emoji: Entry[];
};
const base = set.emoji.filter((e) => !e.base);
const groups = [...new Set(base.map((e) => e.group))];

const assets = join(plugin, 'assets');
rmSync(join(assets, '64'), { recursive: true, force: true });
mkdirSync(join(assets, '64'), { recursive: true });
for (const e of base) {
  copyFileSync(join(emojiDir, e.webp.replace('{size}', '64')), join(assets, '64', `${e.key}.webp`));
}

writeFileSync(
  join(assets, 'index.json'),
  JSON.stringify({
    openemoji: set.openemoji,
    version: set.version,
    license: set.license,
    credit: 'OpenEmoji by Profullstack, Inc.',
    groups,
    // [char, name, group index, search words]; the key is the char's codepoints.
    emoji: base.map((e) => [e.char, e.name, groups.indexOf(e.group), (e.keywords ?? []).join(' ')]),
  }),
);

const sprite = readFileSync(join(iconDir, 'sprite.svg'), 'utf8');
const symbols = ICONS.map((key) => {
  const match = sprite.match(new RegExp(`<symbol id="oi-${key}"[\\s\\S]*?</symbol>`));
  if (!match) throw new Error(`OpenIcon has no "${key}"`);
  return match[0];
});
writeFileSync(
  join(assets, 'sprite.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- OpenIcon (MIT), github.com/profullstack/openicon -->\n${symbols.join('\n')}\n</svg>\n`,
);

console.log(`OpenEmoji ${set.version}: ${base.length} emoji in ${groups.length} groups; OpenIcon: ${symbols.length} symbols`);
