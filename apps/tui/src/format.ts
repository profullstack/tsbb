/** Formatting shared by every view. Pure, so the snapshot tests can rely on it. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relative(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '—';
  const delta = now - at;
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d`;
  if (delta < 365 * DAY) return `${Math.floor(delta / (30 * DAY))}mo`;
  return `${Math.floor(delta / (365 * DAY))}y`;
}

export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * Wrap to a width, preserving paragraph breaks and never splitting a word that
 * fits on a line of its own. A URL longer than the column is broken rather than
 * allowed to push the layout sideways.
 */
export function wrapText(input: string, width: number): string[] {
  if (width < 8) return [input];
  const out: string[] = [];
  for (const paragraph of input.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!line) {
        line = word;
      } else if (`${line} ${word}`.length <= width) {
        line = `${line} ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
