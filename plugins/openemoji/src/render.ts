/**
 * Emoji in rendered posts, drawn with OpenEmoji artwork.
 *
 * Pure functions over the set's index, so the plugin and the tests share them.
 * A post body keeps the Unicode character (that is what email, the TUI and
 * search see); only the HTML swaps it for an image with the character as alt.
 */

export interface EmojiIndex {
  groups: string[];
  /** [char, name, group index, search words] */
  emoji: [string, string, number, string][];
}

export interface EmojiSet {
  keys: Set<string>;
  /** shortcode (no colons) → key */
  shortcodes: Map<string, string>;
  /** key → char and name */
  byKey: Map<string, { char: string; name: string; code: string }>;
}

/** Familiar shortcodes from chat apps, on top of one per emoji name. */
const ALIASES: Record<string, string> = {
  '+1': '👍', '-1': '👎', thumbsup: '👍', thumbsdown: '👎', heart: '❤️', smile: '😄', smiley: '😃',
  grin: '😁', joy: '😂', laughing: '😆', wink: '😉', blush: '😊', cry: '😢', sob: '😭', tada: '🎉',
  pray: '🙏', thinking: '🤔', '100': '💯', ok_hand: '👌', clap: '👏', wave: '👋', shrug: '🤷',
  facepalm: '🤦', sweat_smile: '😅', heart_eyes: '😍', sunglasses: '😎', poop: '💩', star: '⭐',
};

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const SHORTCODE = /:([a-z0-9_+-]{1,64}):/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** OpenEmoji key: the codepoints, lowercase hex, hyphen-joined. */
export function emojiKey(char: string): string {
  return [...char].map((c) => c.codePointAt(0)!.toString(16)).join('-');
}

/** "flag: Côte d’Ivoire" → "flag_cote_d_ivoire". */
export function shortcodeFor(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function buildSet(index: EmojiIndex): EmojiSet {
  const set: EmojiSet = { keys: new Set(), shortcodes: new Map(), byKey: new Map() };
  for (const [char, name] of index.emoji) {
    const key = emojiKey(char);
    const code = shortcodeFor(name);
    set.keys.add(key);
    set.byKey.set(key, { char, name, code });
    if (!set.shortcodes.has(code)) set.shortcodes.set(code, key);
  }
  for (const [code, char] of Object.entries(ALIASES)) {
    const key = artworkKey(set, char);
    if (key && !set.shortcodes.has(code)) set.shortcodes.set(code, key);
  }
  return set;
}

/** The key we have artwork for, trying with and without U+FE0F. */
export function artworkKey(set: EmojiSet, char: string): string | null {
  const key = emojiKey(char);
  if (set.keys.has(key)) return key;
  const bare = key.split('-').filter((p) => p !== 'fe0f');
  if (set.keys.has(bare.join('-'))) return bare.join('-');
  const qualified = [bare[0], 'fe0f', ...bare.slice(1)].join('-');
  return set.keys.has(qualified) ? qualified : null;
}

const attr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');

function img(set: EmojiSet, key: string, base: string): string {
  const e = set.byKey.get(key)!;
  return `<img class="oe" src="${base}/64/${key}.webp" alt="${attr(e.char)}" title=":${attr(e.code)}:" width="20" height="20" loading="lazy" decoding="async">`;
}

function renderText(text: string, set: EmojiSet, base: string, shortcodes: boolean): string {
  const parts = shortcodes ? text.split(SHORTCODE) : [text];
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const key = set.shortcodes.get(part);
        return key ? img(set, key, base) : `:${part}:`;
      }
      if (!PICTOGRAPHIC.test(part)) return part;
      let out = '';
      for (const { segment } of segmenter.segment(part)) {
        const key = PICTOGRAPHIC.test(segment) ? artworkKey(set, segment) : null;
        out += key ? img(set, key, base) : segment;
      }
      return out;
    })
    .join('');
}

/**
 * Swap emoji and :shortcodes: in rendered HTML for OpenEmoji images. Only text
 * between tags is touched, so attributes (an href, an alt) never change, and
 * nothing inside <pre> or <code> does: code stays exactly as written.
 */
export function renderEmoji(
  html: string,
  set: EmojiSet,
  options: { base: string; shortcodes?: boolean },
): string {
  const shortcodes = options.shortcodes !== false;
  if (!PICTOGRAPHIC.test(html) && !(shortcodes && html.includes(':'))) return html;
  let inCode = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<(pre|code)\b/i.test(part)) inCode++;
        else if (/^<\/(pre|code)\s*>/i.test(part)) inCode = Math.max(0, inCode - 1);
        return part;
      }
      return inCode > 0 || part === '' ? part : renderText(part, set, options.base, shortcodes);
    })
    .join('');
}
