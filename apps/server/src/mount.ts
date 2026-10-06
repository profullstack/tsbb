/**
 * Serving a board under a path prefix (`TSBB_BASE_URL=https://c0upons.com/bbs`).
 *
 * The app itself is written for the root of its host: every route, link,
 * redirect and cookie says `/…`. Rather than thread a prefix through all of
 * them (and every plugin), the prefix lives at the edge. A request has it
 * stripped on the way in, and the response gets it put back on the way out:
 *
 * - `Location` headers, root-relative or pointing back at this host
 * - `Set-Cookie` paths, so the session belongs to the board and not the site
 * - root-relative URLs in HTML attributes, CSS `url()`, the web manifest and
 *   the board's own scripts (the service worker reads paths, so it must see
 *   the prefixed ones the browser will actually request)
 *
 * Absolute URLs (canonical, JSON-LD, mail, sitemap) are already prefixed,
 * because they are built with `boardUrl()` from the base URL.
 *
 * Anything outside the prefix is redirected into it, except `/healthz`, which a
 * container healthcheck calls without knowing where the board is mounted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- whatever the server adapter passes, untouched
type Fetch = (request: Request, ...rest: any[]) => Response | Promise<Response>;

const HTML_ATTR = /(\s(?:href|src|action|formaction|poster|content|data-[\w-]+)=)(["'])\/(?![/\\])/gi;
const CSS_URL = /(url\(\s*["']?)\/(?![/\\])/gi;
const JSON_PATH = /(":\s*")\/(?![/\\])/g;
const JS_PATH = /(["'`])\/(?=[A-Za-z0-9_.-]|\1)/g;

export function rewriteBody(body: string, contentType: string, base: string): string {
  if (contentType.includes('text/html')) {
    return body.replace(HTML_ATTR, `$1$2${base}/`).replace(CSS_URL, `$1${base}/`);
  }
  if (contentType.includes('text/css')) return body.replace(CSS_URL, `$1${base}/`);
  if (contentType.includes('manifest+json')) return body.replace(JSON_PATH, `$1${base}/`);
  if (contentType.includes('javascript')) return body.replace(JS_PATH, `$1${base}/`);
  return body;
}

function withinBase(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function mountAt<F extends Fetch>(base: string, fetch: F): F {
  if (!base) return fetch;

  return (async (request: Request, ...rest: unknown[]) => {
    const url = new URL(request.url);

    if (!withinBase(url.pathname, base)) {
      if (url.pathname === '/healthz') return fetch(request, ...rest);
      const target = `${base}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
      return new Response(null, { status: 308, headers: { location: target } });
    }

    url.pathname = url.pathname.slice(base.length) || '/';
    const inner = new Request(url, request);
    const response = await fetch(inner, ...rest);

    const headers = new Headers(response.headers);

    const location = headers.get('location');
    if (location) {
      if (location.startsWith('/') && !location.startsWith('//')) {
        headers.set('location', base + location);
      }
      // An absolute URL is left exactly as it is, even on this host: a board
      // under a path shares its host with the site around it, and a redirect
      // to that site (c0upons.com/api/v1/bridge/authorize) is not the board's.
      // The board builds its own absolute URLs with boardUrl(), prefix included.
    }

    const cookies = headers.getSetCookie();
    if (cookies.length) {
      headers.delete('set-cookie');
      for (const cookie of cookies) {
        headers.append('set-cookie', cookie.replace(/;\s*Path=\/([^;]*)/i, (_m, rest: string) => `; Path=${base}${rest ? `/${rest}` : ''}`));
      }
    }

    if (headers.get('service-worker-allowed') === '/') headers.set('service-worker-allowed', `${base}/`);

    const contentType = headers.get('content-type') ?? '';
    const rewritable = /text\/html|text\/css|manifest\+json|javascript/.test(contentType);
    if (!rewritable || !response.body || request.method === 'HEAD') {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    const body = rewriteBody(await response.text(), contentType, base);
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }) as F;
}
