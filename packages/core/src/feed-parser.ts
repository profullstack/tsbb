/**
 * A small RSS 2.0 / RSS 1.0 / Atom reader.
 *
 * It is string-based rather than a real XML parser on purpose: the board has
 * no XML dependency, a feed is a flat list of items with a dozen well-known
 * child elements, and the failure mode that matters — a feed that is slightly
 * malformed — is one a strict parser rejects outright and this one reads
 * anyway. Anything it cannot find is null; nothing here throws.
 */

export interface ParsedFeed {
  /** 'rss' | 'atom' | 'rdf' */
  kind: 'rss' | 'atom' | 'rdf';
  title: string | null;
  link: string | null;
  items: FeedItem[];
}

export interface FeedItem {
  /** guid, id or link — whatever the feed uses to say "this one". */
  guid: string;
  title: string | null;
  link: string | null;
  author: string | null;
  /** The richest body available, still as HTML. */
  content: string | null;
  /** The short form, still as HTML. */
  summary: string | null;
  publishedAt: number | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, whole) : whole;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, whole) : whole;
    }
    return NAMED_ENTITIES[lower] ?? whole;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * HTML to readable plain text. Block-level closers become line breaks so a
 * post made of paragraphs stays paragraphs; everything else is dropped.
 */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return '';
  let text = input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote|pre|tr|section|article|figcaption)\s*>/gi, '\n\n')
    .replace(/<\s*li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  // A feed that escaped its HTML once ("&lt;p&gt;") now holds tags again.
  if (/<[a-z][^>]*>/i.test(text)) {
    text = decodeEntities(text.replace(/<[^>]+>/g, ''));
  }
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** The text of the first `<name>` child in `block`, with CDATA unwrapped and entities decoded. */
function childText(block: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i');
  const match = pattern.exec(block);
  if (!match) return null;
  const raw = match[1] ?? '';
  const unwrapped = /^\s*<!\[CDATA\[/.test(raw)
    ? raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    : decodeEntities(raw);
  const value = unwrapped.trim();
  return value.length ? value : null;
}

/** The first of several candidate child elements that has any text. */
function firstText(block: string, names: string[]): string | null {
  for (const name of names) {
    const value = childText(block, name);
    if (value) return value;
  }
  return null;
}

/** An attribute of the first `<name ...>` tag, decoded. */
function childAttribute(block: string, name: string, attribute: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<${escaped}\\s[^>]*?\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    'i',
  );
  const match = pattern.exec(block);
  const value = match?.[2] ?? match?.[3];
  return value ? decodeEntities(value).trim() : null;
}

/**
 * Atom links carry a rel; the one we want is the alternate (or an unlabelled
 * one), never the self, enclosure or replies links that usually come first.
 */
function atomLink(block: string): string | null {
  const tags = block.match(/<link\b[^>]*>/gi) ?? [];
  let fallback: string | null = null;
  for (const tag of tags) {
    const href = childAttribute(tag, 'link', 'href');
    if (!href) continue;
    const rel = childAttribute(tag, 'link', 'rel');
    if (!rel || rel === 'alternate') return href;
    fallback ??= href;
  }
  return fallback;
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Strip the head of the document so channel-level fields do not shadow item ones. */
function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
}

function itemBlocks(xml: string, tag: 'item' | 'entry'): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  // The whole element, opening tag included, so an RDF item's rdf:about is
  // still there to be read as its id.
  while ((match = pattern.exec(xml)) !== null) blocks.push(match[0]);
  return blocks;
}

export function parseFeed(input: string): ParsedFeed | null {
  const xml = stripComments(input.replace(/^\uFEFF/, ''));
  const isAtom =
    /<feed\b[^>]*xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xml) ||
    /<feed\b/i.test(xml.slice(0, 2000));
  const isRdf = /<rdf:RDF\b/i.test(xml.slice(0, 2000));
  const isRss = /<rss\b/i.test(xml.slice(0, 2000));

  if (isAtom) {
    const blocks = itemBlocks(xml, 'entry');
    const head = xml.slice(0, blocks.length ? xml.search(/<entry\b/i) : xml.length);
    return {
      kind: 'atom',
      title: childText(head, 'title'),
      link: atomLink(head),
      items: blocks
        .map((block, index) => atomItem(block, index))
        .filter((i): i is FeedItem => i !== null),
    };
  }

  if (isRss || isRdf || /<item\b/i.test(xml)) {
    const blocks = itemBlocks(xml, 'item');
    const firstItem = xml.search(/<item\b/i);
    const head = xml.slice(0, firstItem === -1 ? xml.length : firstItem);
    return {
      kind: isRdf ? 'rdf' : 'rss',
      title: childText(head, 'title'),
      link: childText(head, 'link'),
      items: blocks
        .map((block, index) => rssItem(block, index))
        .filter((i): i is FeedItem => i !== null),
    };
  }

  return null;
}

function rssItem(block: string, index: number): FeedItem | null {
  const title = childText(block, 'title');
  const link = childText(block, 'link') ?? childAttribute(block, 'link', 'href');
  const guid = childText(block, 'guid') ?? childAttribute(block, 'item', 'rdf:about') ?? link;
  const content = firstText(block, ['content:encoded', 'content']);
  const summary = firstText(block, ['description', 'summary']);
  if (!title && !link && !content && !summary) return null;
  return {
    guid: guid ?? fallbackGuid(title, summary, index),
    title,
    link,
    author: firstText(block, ['dc:creator', 'author']),
    content,
    summary,
    publishedAt: parseDate(firstText(block, ['pubDate', 'dc:date', 'published', 'updated'])),
  };
}

function atomItem(block: string, index: number): FeedItem | null {
  const title = childText(block, 'title');
  const link = atomLink(block);
  const content = childText(block, 'content');
  const summary = childText(block, 'summary');
  if (!title && !link && !content && !summary) return null;
  const authorBlock = /<author\b[^>]*>([\s\S]*?)<\/author\s*>/i.exec(block)?.[1] ?? '';
  return {
    guid: childText(block, 'id') ?? link ?? fallbackGuid(title, summary, index),
    title,
    link,
    author:
      childText(authorBlock, 'name') ??
      (authorBlock.trim() && !/</.test(authorBlock) ? authorBlock.trim() : null),
    content,
    summary,
    publishedAt: parseDate(firstText(block, ['published', 'updated', 'issued'])),
  };
}

/**
 * A feed with neither guid nor link still needs a stable key, or every fetch
 * would post every item again. Title plus summary is as stable as it gets.
 */
function fallbackGuid(title: string | null, summary: string | null, index: number): string {
  const seed = `${title ?? ''} ${summary ?? ''}`.trim();
  return seed ? `text:${seed.slice(0, 500)}` : `index:${index}`;
}
