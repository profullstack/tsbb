/**
 * SQLite FTS5 `MATCH` takes a query *language*, not a search string. Feeding it
 * raw user input means a pasted error message, an email address or a stray
 * quote raises `fts5: syntax error` and the search 500s. So we never pass user
 * text through: we tokenise it ourselves and rebuild a query we know is valid.
 */
const MAX_TERMS = 24;

/** Characters FTS5 treats as operators or syntax rather than content. */
const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

export function toFtsQuery(input: string, { prefix = true } = {}): string | null {
  const phrases: string[] = [];

  // Honour double-quoted phrases, then strip them out before tokenising.
  const rest = input.replace(/"([^"]{1,120})"/g, (_m, body: string) => {
    const inner = body.split(TOKEN_SPLIT).filter(Boolean);
    if (inner.length) phrases.push(`"${inner.join(' ')}"`);
    return ' ';
  });

  const terms = rest
    .split(TOKEN_SPLIT)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1 || /\p{N}/u.test(t));

  const quoted = terms.slice(0, MAX_TERMS).map((t) => `"${t}"${prefix ? '*' : ''}`);
  const parts = [...phrases, ...quoted];
  if (!parts.length) return null;
  return parts.join(' AND ');
}

/** Escape a value for use inside an FTS5 double-quoted string. */
export function ftsPhrase(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}
