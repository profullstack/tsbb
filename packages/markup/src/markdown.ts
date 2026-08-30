import { escapeAttr, escapeHtml, safeUrl } from './escape.ts';

/**
 * A small, deliberately incomplete markdown renderer.
 *
 * It covers what people actually write in forum posts and nothing else. The
 * omissions are the point: every construct it does not understand is emitted as
 * escaped text, so the set of tags this file can produce is the set of tags
 * written literally below.
 */

export interface MarkdownOptions {
  /** Rendered as `rel="nofollow ugc"` unless the host is in this list. */
  internalHosts?: string[];
  /** Turn `@name` into a profile link. */
  mentionUrl?: (username: string) => string;
  /** Headings are demoted so a post cannot outrank the page's own <h1>. */
  headingOffset?: number;
}

const CODE_FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*(\d+)[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Private-use sentinels wrap the index of a lifted-out span. They are stripped
 * from the input first, so a post cannot forge one and capture another span's
 * content. A plain delimiter like a space around a number would collide with
 * ordinary prose on the very first post that contains a number.
 */
const OPEN = '\u{E000}';
const CLOSE = '\u{E001}';
const SENTINELS = /[\u{E000}\u{E001}]/gu;
const PLACEHOLDER = /\u{E000}(\d+)\u{E001}/gu;

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = CODE_FENCE.exec(line);
    if (fence) {
      const language = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !CODE_FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence, or end of input
      const cls = language ? ` class="language-${escapeAttr(language)}"` : '';
      out.push(`<pre class="md-code"><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const depth = Math.min(6, (heading[1]?.length ?? 1) + (options.headingOffset ?? 2));
      out.push(`<h${depth}>${renderInline(heading[2] ?? '', options)}</h${depth}>`);
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && BLOCKQUOTE.test(lines[i] ?? '')) {
        body.push(BLOCKQUOTE.exec(lines[i] ?? '')?.[1] ?? '');
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), options)}</blockquote>`);
      continue;
    }

    // A table needs a header row followed by a divider row; anything else that
    // merely contains pipes stays a paragraph.
    if (line.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(splitRow(lines[i] ?? ''));
        i += 1;
      }
      out.push(renderTable(header, rows, options));
      continue;
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const ordered = OL_ITEM.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const match = ordered ? OL_ITEM.exec(current) : UL_ITEM.exec(current);
        if (!match) break;
        const text = ordered ? (match[2] ?? '') : (match[1] ?? '');
        const continuation: string[] = [text];
        i += 1;
        // Indented following lines belong to the item they sit under.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? '')) {
          continuation.push((lines[i] ?? '').trim());
          i += 1;
        }
        items.push(`<li>${renderInline(continuation.join(' '), options)}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (!current.trim()) break;
      if (
        CODE_FENCE.test(current) ||
        HEADING.test(current) ||
        HR.test(current) ||
        BLOCKQUOTE.test(current) ||
        UL_ITEM.test(current) ||
        OL_ITEM.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join('\n'), options).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('');
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(header: string[], rows: string[][], options: MarkdownOptions): string {
  const head = header.map((c) => `<th>${renderInline(c, options)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((c) => `<td>${renderInline(c, options)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Inline rendering works on already-escaped text. Code spans and links are
 * lifted out first and put back at the end, so backticks protect their contents
 * from every other rule exactly as a reader expects.
 */
export function renderInline(source: string, options: MarkdownOptions = {}): string {
  const spans: string[] = [];
  const keep = (html: string): string => {
    spans.push(html);
    return `${OPEN}${spans.length - 1}${CLOSE}`;
  };

  let text = escapeHtml(source.replace(SENTINELS, ''));

  text = text.replace(/`([^`]+)`/g, (_m, code: string) => keep(`<code>${code}</code>`));

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, url: string) => {
    const href = safeUrl(unescapeEntities(url));
    if (!href) return match;
    return keep(`<img src="${escapeAttr(href)}" alt="${alt}" loading="lazy" class="md-image" />`);
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const href = safeUrl(unescapeEntities(url));
    if (!href) return match;
    return keep(anchor(href, renderInline(unescapeEntities(label), options), options));
  });

  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (match, lead: string, url: string) => {
    const href = safeUrl(unescapeEntities(url));
    if (!href) return match;
    return `${lead}${keep(anchor(href, escapeHtml(shorten(unescapeEntities(url))), options))}`;
  });

  if (options.mentionUrl) {
    const mentionUrl = options.mentionUrl;
    text = text.replace(/(^|[^\w/])@([a-zA-Z0-9_-]{2,32})\b/g, (_m, lead: string, name: string) => {
      const href = safeUrl(mentionUrl(name));
      if (!href) return `${lead}@${name}`;
      return `${lead}<a class="mention" href="${escapeAttr(href)}">@${escapeHtml(name)}</a>`;
    });
  }

  text = text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');

  return text.replace(PLACEHOLDER, (_m, index: string) => spans[Number(index)] ?? '');
}

function anchor(href: string, label: string, options: MarkdownOptions): string {
  const rel = isInternal(href, options.internalHosts ?? [])
    ? ''
    : ' rel="nofollow ugc noopener" target="_blank"';
  return `<a href="${escapeAttr(href)}"${rel}>${label}</a>`;
}

function isInternal(href: string, hosts: string[]): boolean {
  if (href.startsWith('/') || href.startsWith('#')) return true;
  try {
    return hosts.includes(new URL(href).host);
  } catch {
    return false;
  }
}

function shorten(url: string, max = 64): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

/** Undo the escaping for values that go through `safeUrl` and are re-escaped. */
function unescapeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
