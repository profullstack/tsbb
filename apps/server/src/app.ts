import { Hono } from 'hono';
import type { Context } from 'hono';
import { loadSettings, touchLastSeen, viewerFromToken } from '@tsbb/core';
import { Card, CardContent, Empty, stylesheet } from '@tsbb/ui';
import type { Registry } from '@tsbb/plugin-host';
import type { PluginRequest, Viewer } from '@tsbb/plugin-api';
import { readTheme, render, resolveViewer, type AppEnv, type Services } from './context.ts';
import { boardRoutes } from './routes/board.ts';
import { authRoutes } from './routes/auth.ts';
import { writeRoutes } from './routes/write.ts';

export function createApp(registry: Registry, baseUrl: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const services: Services = { registry, baseUrl };

  /*
   * The stylesheet is served under a content hash, so it can be cached for a
   * year safely: the URL changes the moment the bytes do. A stable filename
   * with a long max-age is how a CSS fix ends up invisible to everybody who
   * already visited.
   */
  /*
   * The stylesheet is served under a content hash, so it can be cached for a
   * year safely: the URL changes the moment the bytes do. A stable filename
   * with a long max-age is how a CSS fix ends up invisible to everyone who has
   * already visited.
   *
   * The hash is parsed out of the filename rather than captured by a route
   * pattern. A pattern with literal dots on both sides of a parameter is easy
   * to write and does not match, and the failure is silent — every request
   * falls through to the 404 handler and the board renders unstyled.
   */
  app.get('/assets/:file', (c) => {
    const sheet = stylesheet();
    const file = c.req.param('file');
    const match = /^app\.([0-9a-f]+)\.css$/.exec(file);
    if (!match) return c.notFound();
    if (match[1] !== sheet.hash) return c.redirect(`/assets/app.${sheet.hash}.css`, 302);
    return c.body(sheet.css, 200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    });
  });

  app.use('*', async (c, next) => {
    // A bearer token identifies API clients (the TUI); a cookie identifies
    // browsers. A token never confers admin, whatever it was minted with.
    const authorization = c.req.header('authorization');
    const viewer: Viewer = authorization?.startsWith('Bearer ')
      ? await viewerFromToken(authorization.slice(7).trim())
      : await resolveViewer(c);

    c.set('viewer', viewer);
    c.set('settings', await loadSettings());
    c.set('theme', readTheme(c));

    if (viewer.user) {
      // Fire and forget: a presence write must never delay a page.
      void touchLastSeen(viewer.user.id).catch(() => {});
    }
    await next();
  });

  /*
   * Content-Security-Policy, assembled through a filter so a plugin can widen
   * it for what it actually needs and the permission disappears when the plugin
   * is disabled.
   *
   * The base policy has no 'unsafe-inline' anywhere, which the board can afford
   * because it ships no inline styles and no script at all. That is precisely
   * why the ads plugin uses the cross-origin frame endpoint rather than ad.js:
   * ad.js renders its creative into a srcdoc iframe, and a srcdoc document
   * inherits this policy.
   */
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.get('content-type')?.includes('text/html')) return;

    const base: Record<string, string[]> = {
      'default-src': ["'self'"],
      'script-src': ["'none'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'frame-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'base-uri': ["'none'"],
      'object-src': ["'none'"],
    };

    const url = new URL(c.req.url);
    const directives = await registry.bus.applyFilter('security:csp', base, {
      viewer: c.get('viewer'),
      url,
      settings: (c.get('settings') ?? {}) as Record<string, unknown>,
    });

    c.res.headers.set(
      'content-security-policy',
      Object.entries(directives)
        .map(([name, values]) => `${name} ${[...new Set(values)].join(' ')}`)
        .join('; '),
    );
    c.res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('x-content-type-options', 'nosniff');
  });

  app.route('/', authRoutes(services));
  app.route('/', writeRoutes(services));
  app.route('/', boardRoutes(services));

  mountPluginRoutes(app, services);

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      plugins: [...registry.enabled],
      pluginErrors: Object.fromEntries(registry.errors),
    }),
  );

  app.notFound(async (c) =>
    render(c, services, {
      title: 'Not found',
      status: 404,
      body: Card(CardContent(Empty('Not found', 'That page does not exist, or is not yours to see.'))),
    }),
  );

  app.onError(async (error, c) => {
    console.error('[server]', error);
    return render(c as never, services, {
      title: 'Something went wrong',
      status: 500,
      body: Card(CardContent(Empty('Something went wrong', 'The error has been logged.'))),
    });
  });

  return app;
}

/**
 * Mount every route a plugin registered, under `/p/<slug>`.
 *
 * Routes are read from the registry on each request rather than bound once at
 * boot, so enabling or disabling a plugin takes effect without a restart. The
 * `requires` gate is enforced here rather than being left to each plugin: a
 * plugin that forgets the check would otherwise be a hole in the board.
 */
function mountPluginRoutes(app: Hono<AppEnv>, services: Services): void {
  app.all('/p/:slug/*', async (c) => {
    const url = new URL(c.req.url);
    const match = services.registry.routes.find(
      (route) => route.method === c.req.method && route.path === url.pathname,
    );
    if (!match) return c.notFound();

    const viewer = c.get('viewer');
    const requires = match.options.requires ?? 'guest';
    if (requires === 'user' && !viewer.user) return c.redirect('/login', 302);
    if (requires === 'moderator' && !viewer.isModerator) return c.text('Not allowed', 403);
    if (requires === 'admin' && !viewer.isAdmin) return c.text('Not allowed', 403);

    const request = pluginRequest(c, viewer);
    const result = await match.handler(request);

    if (result instanceof Response) return result;
    if (typeof result === 'string') return c.html(result);
    if (result && typeof result === 'object') return c.json(result);
    return c.body(null, 204);
  });
}

function pluginRequest(c: Context<AppEnv>, viewer: Viewer): PluginRequest {
  const url = new URL(c.req.url);
  return {
    method: c.req.method,
    url,
    params: c.req.param() as Record<string, string>,
    query: Object.fromEntries(url.searchParams),
    headers: c.req.raw.headers,
    viewer,
    json: <T,>() => c.req.json() as Promise<T>,
    form: async () => {
      const body = await c.req.parseBody();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) out[k] = typeof v === 'string' ? v : '';
      return out;
    },
    text: () => c.req.text(),
  };
}
