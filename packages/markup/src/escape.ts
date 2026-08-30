/**
 * The whole markup pipeline is safe *by construction*: source text is escaped
 * as it is emitted, and the only tags that can appear in the output are ones
 * this package writes literally. Raw HTML in a post body is content, not
 * markup.
 *
 * Do not "improve" this by adding a sanitiser or a raw-HTML passthrough. A
 * sanitiser is a denylist with a long history of bypasses; this is an allowlist
 * that cannot be bypassed because there is no path from input to a tag.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function escapeAttr(input: string): string {
  return escapeHtml(input);
}

/** Only these schemes ever reach an href or src. Everything else is dropped. */
const SAFE_SCHEME = /^(https?:|mailto:|\/|#)/i;

export function safeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // A control character in the middle of a URL is how `javascript:` gets
  // smuggled past a scheme check — `java\nscript:` passes a naive test and is
  // still executed by the parser.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (!SAFE_SCHEME.test(trimmed)) return null;
  return trimmed;
}

/**
 * Anything interpolated into a <script> element must go through this. A bare
 * JSON.stringify of user text containing `</script>` closes the element and the
 * rest of the document parses as markup — stored XSS on ordinary post content.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
