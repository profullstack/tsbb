/**
 * An absolute URL for a board path.
 *
 * `new URL('/t/1', baseUrl)` throws away any path in the base URL, which is
 * right for a board at the root of its host and wrong for one mounted under a
 * prefix (`https://c0upons.com/bbs`). This keeps the prefix either way.
 */
export function boardUrl(path: string, baseUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return new URL(path, baseUrl).toString();
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const target = new URL(path, `${base.origin}/`);
  target.pathname = prefix + target.pathname;
  return target.toString();
}

/**
 * The path a board is mounted under: `''` at the root, else `/bbs` (no
 * trailing slash).
 */
export function basePathOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}
