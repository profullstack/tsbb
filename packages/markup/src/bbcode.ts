import { escapeAttr, escapeHtml, safeUrl } from './escape.ts';

/**
 * BBCode, because a board people migrate to from phpBB or vBulletin will have
 * two decades of posts written in it.
 *
 * Same safety property as the markdown renderer: the input is escaped up front
 * and the parser only ever emits tags from the table below. An unknown or
 * unbalanced tag is left as the escaped text it already is, which is what every
 * other BBCode implementation does and what posters expect.
 */

export interface BbcodeOptions {
  internalHosts?: string[];
  mentionUrl?: (username: string) => string;
  /** Rendering a [quote] needs to know where a post lives to link to it. */
  postUrl?: (postId: number) => string;
}

type SimpleTag = { open: string; close: string };

/** Tags that take no argument and wrap their contents. */
const SIMPLE: Record<string, SimpleTag> = {
  b: { open: '<strong>', close: '</strong>' },
  i: { open: '<em>', close: '</em>' },
  u: { open: '<u>', close: '</u>' },
  s: { open: '<del>', close: '</del>' },
  center: { open: '<div class="bb-center">', close: '</div>' },
  right: { open: '<div class="bb-right">', close: '</div>' },
  sub: { open: '<sub>', close: '</sub>' },
  sup: { open: '<sup>', close: '</sup>' },
  list: { open: '<ul class="bb-list">', close: '</ul>' },
  ol: { open: '<ol class="bb-list">', close: '</ol>' },
  spoiler: {
    open: '<details class="bb-spoiler"><summary>Spoiler</summary><div>',
    close: '</div></details>',
  },
};

/** Tags whose contents are never parsed. */
const RAW = new Set(['code', 'noparse', 'plain']);

const TAG = /\[(\/?)([a-zA-Z*]+)(?:=("?)([^\]]*)\3)?\]/g;

/** A colour must look like a colour, or it is not emitted at all. */
const COLOUR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
const SIZE = /^\d{1,3}$/;

export function renderBbcode(source: string, options: BbcodeOptions = {}): string {
  const text = escapeHtml(source.replace(/\r\n?/g, '\n'));
  const out: string[] = [];
  const stack: StackEntry[] = [];
  let cursor = 0;

  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG.exec(text)) !== null) {
    const [raw, slash, rawName, , rawArg] = match;
    const name = (rawName ?? '').toLowerCase();
    const closing = slash === '/';
    const arg = rawArg ? unescapeEntities(rawArg) : undefined;

    // A raw tag swallows everything up to its own close, unparsed.
    if (!closing && RAW.has(name)) {
      const end = findClose(text, name, TAG.lastIndex);
      if (end === -1) continue;
      out.push(text.slice(cursor, match.index));
      const body = text.slice(TAG.lastIndex, end.start);
      out.push(renderRaw(name, body, arg));
      cursor = end.after;
      TAG.lastIndex = end.after;
      continue;
    }

    // [img]url[/img], [youtube]id[/youtube] and the argument-less [url] form
    // take their body AS their argument, so they are consumed whole rather than
    // opened and closed. Without this the body is emitted as bare text and the
    // href stays empty.
    if (!closing && isBodyTag(name, arg)) {
      const end = findClose(text, name, TAG.lastIndex);
      if (end === -1) continue;
      const body = text.slice(TAG.lastIndex, end.start);
      const rendered = renderBodyTag(name, body, options);
      if (rendered === null) continue;
      out.push(text.slice(cursor, match.index), rendered);
      cursor = end.after;
      TAG.lastIndex = end.after;
      continue;
    }

    const handled = closing ? renderClose(name, stack) : renderOpen(name, arg, stack, options);
    if (handled === null) continue; // unknown or invalid: leave it as text

    out.push(text.slice(cursor, match.index), handled);
    cursor = match.index + raw.length;
  }

  out.push(text.slice(cursor));

  // Anything still open at the end is closed here rather than left dangling,
  // so an unbalanced post cannot break the surrounding page layout.
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    out.push(entry.liOpen ? `</li>${entry.close}` : entry.close);
  }

  let html = out.join('');
  html = linkify(html, options);
  html = mentions(html, options);
  return paragraphs(html);
}

interface StackEntry {
  name: string;
  close: string;
  /** Set on a list while one of its <li> elements is still open. */
  liOpen?: boolean;
}

function renderOpen(
  name: string,
  arg: string | undefined,
  stack: StackEntry[],
  options: BbcodeOptions,
): string | null {
  if (stack.length > 24) return null; // refuse to nest forever

  const simple = SIMPLE[name];
  if (simple) {
    stack.push({ name, close: simple.close });
    return simple.open;
  }

  switch (name) {
    case '*': {
      // A list item has no closing tag in BBCode, so it is closed here by the
      // next item and in renderClose by the end of the list.
      const list = stack[stack.length - 1];
      if (!list || (list.name !== 'list' && list.name !== 'ol')) return null;
      const wasOpen = list.liOpen === true;
      list.liOpen = true;
      return wasOpen ? '</li><li>' : '<li>';
    }
    case 'url': {
      // Only the [url=target]label[/url] form reaches here; the argument-less
      // form is consumed as a body tag above.
      const href = safeUrl(arg ?? '');
      if (!href) return null;
      stack.push({ name, close: '</a>' });
      return `<a href="${escapeAttr(href)}"${relFor(href, options)}>`;
    }
    case 'quote': {
      const who = arg ? `<cite>${escapeHtml(arg)}</cite>` : '';
      stack.push({ name, close: '</blockquote>' });
      return `<blockquote class="bb-quote">${who}`;
    }
    case 'color':
    case 'colour': {
      if (!arg || !COLOUR.test(arg)) return null;
      stack.push({ name, close: '</span>' });
      return `<span style="color:${escapeAttr(arg)}">`;
    }
    case 'size': {
      if (!arg || !SIZE.test(arg)) return null;
      const px = Math.min(32, Math.max(10, Number(arg)));
      stack.push({ name, close: '</span>' });
      return `<span style="font-size:${px}px">`;
    }
    case 'hr':
      return '<hr />';
    default:
      return null;
  }
}

const BODY_TAGS = new Set(['img', 'youtube']);

function isBodyTag(name: string, arg: string | undefined): boolean {
  if (BODY_TAGS.has(name)) return true;
  return name === 'url' && arg === undefined;
}

/** The YouTube id is validated rather than interpolated, so no URL can be forged. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

function renderBodyTag(name: string, body: string, options: BbcodeOptions): string | null {
  const value = unescapeEntities(body.trim());

  if (name === 'url') {
    const href = safeUrl(value);
    if (!href) return null;
    return `<a href="${escapeAttr(href)}"${relFor(href, options)}>${escapeHtml(value)}</a>`;
  }

  if (name === 'img') {
    const src = safeUrl(value);
    if (!src) return null;
    return `<img src="${escapeAttr(src)}" alt="" loading="lazy" class="bb-image" />`;
  }

  // A YouTube embed needs a Referer to play: a frame sent with
  // referrerpolicy="no-referrer" is refused by the player with "Video
  // unavailable". Leave the default policy alone.
  const id = value.includes('/') ? youtubeId(value) : value;
  if (!id || !YOUTUBE_ID.test(id)) return null;
  return (
    `<div class="bb-video"><iframe src="https://www.youtube-nocookie.com/embed/${escapeAttr(id)}" ` +
    `title="YouTube video" loading="lazy" allowfullscreen ` +
    `allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"></iframe></div>`
  );
}

function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
    return parsed.searchParams.get('v') ?? parsed.pathname.split('/').pop() ?? null;
  } catch {
    return null;
  }
}

function renderClose(name: string, stack: StackEntry[]): string | null {
  const top = stack[stack.length - 1];
  if (!top || top.name !== name) return null;
  stack.pop();
  return top.liOpen ? `</li>${top.close}` : top.close;
}

function renderRaw(name: string, body: string, arg?: string): string {
  if (name === 'code') {
    const cls = arg ? ` class="language-${escapeAttr(arg)}"` : '';
    return `<pre class="bb-code"><code${cls}>${body}</code></pre>`;
  }
  return body;
}

function findClose(text: string, name: string, from: number): { start: number; after: number } | -1 {
  const needle = `[/${name}]`;
  const index = text.toLowerCase().indexOf(needle, from);
  if (index === -1) return -1;
  return { start: index, after: index + needle.length };
}

function relFor(href: string, options: BbcodeOptions): string {
  const hosts = options.internalHosts ?? [];
  if (href.startsWith('/') || href.startsWith('#')) return '';
  try {
    if (hosts.includes(new URL(href).host)) return '';
  } catch {
    /* not absolute; treated as external below */
  }
  return ' rel="nofollow ugc noopener" target="_blank"';
}

/**
 * Split the rendered HTML into text and markup, so the two passes below can
 * only ever touch text. Splitting on a capturing group interleaves the
 * delimiters into the result at the odd indices, which are left untouched.
 *
 * A complete anchor element is one alternative rather than just its tags:
 * without that, a URL that [url] has already linked gets linked a second time
 * and the output is an <a> nested inside an <a>.
 */
const MARKUP = /(<a\b[^>]*>[\s\S]*?<\/a>|<(?:pre|code)\b[^>]*>[\s\S]*?<\/(?:pre|code)>|<[^>]+>)/;

function onTextNodes(html: string, transform: (text: string) => string): string {
  return html
    .split(MARKUP)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join('');
}

/** Bare URLs in the remaining text. */
function linkify(html: string, options: BbcodeOptions): string {
  return onTextNodes(html, (text) =>
    text.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (match, lead: string, url: string) => {
      const href = safeUrl(unescapeEntities(url));
      if (!href) return match;
      return `${lead}<a href="${escapeAttr(href)}"${relFor(href, options)}>${url}</a>`;
    }),
  );
}

function mentions(html: string, options: BbcodeOptions): string {
  const mentionUrl = options.mentionUrl;
  if (!mentionUrl) return html;
  return onTextNodes(html, (text) =>
    text.replace(/(^|[^\w/])@([a-zA-Z0-9_-]{2,32})\b/g, (_m, lead: string, name: string) => {
      const href = safeUrl(mentionUrl(name));
      if (!href) return `${lead}@${name}`;
      return `${lead}<a class="mention" href="${escapeAttr(href)}">@${escapeHtml(name)}</a>`;
    }),
  );
}

/** Blank lines become paragraphs; single newlines become breaks. */
function paragraphs(html: string): string {
  const blocks = html.split(/\n{2,}/).filter((b) => b.trim());
  return blocks
    .map((block) => {
      const body = block.replace(/\n/g, '<br />');
      // A block that is already a block-level element is left alone.
      if (/^\s*<(pre|blockquote|ul|ol|div|hr|details|table)\b/i.test(body)) return body;
      return `<p>${body}</p>`;
    })
    .join('');
}

function unescapeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
