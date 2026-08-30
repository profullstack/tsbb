import { renderBbcode, type BbcodeOptions } from './bbcode.ts';
import { renderMarkdown, renderInline, type MarkdownOptions } from './markdown.ts';
import { escapeHtml } from './escape.ts';

export { escapeHtml, escapeAttr, safeUrl, jsonForScript } from './escape.ts';
export { renderMarkdown, renderInline } from './markdown.ts';
export { renderBbcode } from './bbcode.ts';
export type { MarkdownOptions } from './markdown.ts';
export type { BbcodeOptions } from './bbcode.ts';

export type BodyFormat = 'markdown' | 'bbcode';
export type RenderOptions = MarkdownOptions & BbcodeOptions;

export function render(body: string, format: BodyFormat, options: RenderOptions = {}): string {
  return format === 'bbcode' ? renderBbcode(body, options) : renderMarkdown(body, options);
}

/**
 * Signatures are rendered with a much smaller grammar than posts: inline only,
 * no headings, no block quotes, no tables and no images. A signature appears on
 * every post its author has ever written, so anything that can take vertical
 * space is a way to shout down a whole thread.
 */
export function renderSignature(
  body: string,
  format: BodyFormat,
  options: RenderOptions = {},
): string {
  const trimmed = body.replace(/\r\n?/g, '\n').split('\n').slice(0, SIGNATURE_LINES).join('\n');
  if (format === 'bbcode') {
    return renderBbcode(stripBlockBbcode(trimmed), options);
  }
  // Markdown images are removed whole. Removing only the syntax would leave the
  // URL behind as text, which the autolinker then turns into a live link.
  const inline = trimmed.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  return renderInline(inline, options).replace(/\n/g, '<br />');
}

/** Four lines is the whole budget; a signature sits under every post. */
const SIGNATURE_LINES = 4;

/**
 * Remove the tags a signature may not use, along with everything between a
 * matched pair. Stripping the tags alone would leave an image URL as bare text
 * for the autolinker to pick up — which is how the first version of this leaked
 * `https://host/pic.png[/img]` into a live anchor.
 */
function stripBlockBbcode(input: string): string {
  return input
    .replace(/\[(img|quote|code|list|spoiler)[^\]]*\][\s\S]*?\[\/\1\]/gi, '')
    .replace(/\[\/?(img|quote|code|list|ol|spoiler|\*)[^\]]*\]/gi, '');
}

/** Usernames referenced with @ in a body, lowercased and deduplicated. */
export function extractMentions(body: string, limit = 20): string[] {
  const found = new Set<string>();
  // Skip fenced and inline code so a code sample cannot notify anybody.
  const withoutCode = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const stripped = withoutCode.replace(/\[code[^\]]*\][\s\S]*?\[\/code\]/gi, ' ');
  for (const match of stripped.matchAll(/(?:^|[^\w/])@([a-zA-Z0-9_-]{2,32})\b/g)) {
    const name = match[1];
    if (name) found.add(name.toLowerCase());
    if (found.size >= limit) break;
  }
  return [...found];
}

/** Plain text of a body, for search snippets, email and the TUI. */
export function toPlainText(body: string, format: BodyFormat): string {
  let text = body;
  if (format === 'bbcode') {
    text = text.replace(/\[\/?[a-zA-Z*]+(?:=[^\]]*)?\]/g, ' ');
  } else {
    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/[*_~]{1,3}/g, '');
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function excerpt(body: string, format: BodyFormat, length = 200): string {
  const text = toPlainText(body, format);
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > length * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Build the body of a reply that quotes another post, in the format the
 * replying user writes in — not the format the quoted post was written in.
 */
export function quoteBody(input: {
  author: string;
  body: string;
  sourceFormat: BodyFormat;
  targetFormat: BodyFormat;
}): string {
  const text = toPlainText(input.body, input.sourceFormat).slice(0, 1200);
  if (input.targetFormat === 'bbcode') {
    return `[quote=${input.author}]${text}[/quote]\n\n`;
  }
  const quoted = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `**${input.author} wrote:**\n${quoted}\n\n`;
}

/** Highlight search terms in an already-plain excerpt. */
export function highlight(text: string, terms: string[]): string {
  const escaped = escapeHtml(text);
  const wanted = terms.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!wanted.length) return escaped;
  return escaped.replace(new RegExp(`(${wanted.join('|')})`, 'gi'), '<mark>$1</mark>');
}
