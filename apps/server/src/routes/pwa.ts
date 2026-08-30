import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadSettings } from '@tsbb/core';
import { stylesheet } from '@tsbb/ui';
import type { AppEnv, Services } from '../context.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '../../public');

const ICONS: Record<string, string> = {
  'icon-16.png': 'image/png',
  'icon-32.png': 'image/png',
  'icon-180.png': 'image/png',
  'icon-192.png': 'image/png',
  'icon-512.png': 'image/png',
  'icon-maskable-512.png': 'image/png',
  'favicon.ico': 'image/x-icon',
};

/**
 * The cache name the service worker precaches under.
 *
 * It is derived from the stylesheet hash and the package version, so it moves
 * whenever the shell actually changes. A hard-coded version is the classic way
 * to ship a fix that no returning reader ever sees: their browser keeps serving
 * the old precache because the name never changed.
 *
 * Note this only governs the PRECACHED shell (the offline page, icons, CSS).
 * Pages themselves are network-first, so a new post is never withheld from
 * somebody running an old worker.
 */
function shellVersion(): string {
  let appVersion = '0.0.0';
  try {
    appVersion = JSON.parse(readFileSync(join(PUBLIC_DIR, '../../../package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    /* the version is a nicety; the stylesheet hash is what does the work */
  }
  return createHash('sha256').update(`${stylesheet().hash}:${appVersion}`).digest('hex').slice(0, 10);
}

export function pwaRoutes(_services: Services) {
  const app = new Hono<AppEnv>();

  app.get('/manifest.webmanifest', async (c) => {
    const settings = await loadSettings();
    const name = String(settings['board.name'] ?? 'tsbb');
    return c.json(
      {
        name,
        short_name: name.length > 12 ? 'tsbb' : name,
        description: String(settings['board.tagline'] ?? 'A TypeScript bulletin board'),
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        // Matches --background in each theme, so the splash screen does not
        // flash the wrong colour before the page paints.
        background_color: '#ffffff',
        theme_color: '#4f39f6',
        categories: ['social', 'news'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Latest', url: '/latest' },
          { name: 'Notifications', url: '/notifications' },
          { name: 'Search', url: '/search' },
        ],
      },
      200,
      { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    );
  });

  app.get('/icons/:name', (c) => {
    const name = c.req.param('name');
    const type = ICONS[name];
    if (!type) return c.notFound();
    try {
      const bytes = readFileSync(join(PUBLIC_DIR, 'icons', name));
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        'content-type': type,
        'cache-control': 'public, max-age=604800',
      });
    } catch {
      return c.notFound();
    }
  });

  app.get('/favicon.ico', (c) => c.redirect('/icons/favicon.ico', 301));

  /**
   * The service worker.
   *
   * Pages are NETWORK-FIRST with a cache fallback: on a forum, showing a stale
   * thread is worse than showing a spinner, and cache-first would do exactly
   * that. Hashed assets are cache-first because their URL changes when their
   * bytes do, so a stale one is impossible by construction.
   */
  app.get('/sw.js', (c) => {
    const version = shellVersion();
    const css = `/assets/app.${stylesheet().hash}.css`;
    const source = `/* tsbb service worker — generated, do not edit */
const VERSION = ${JSON.stringify(version)};
const SHELL = 'tsbb-shell-' + VERSION;
const PAGES = 'tsbb-pages-' + VERSION;
const PRECACHE = ['/offline', ${JSON.stringify(css)}, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Drop every cache from a previous version. Without this the old shell
  // survives forever and the update is invisible.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== PAGES).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache anything that is per-viewer or a write path.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') ||
      url.pathname === '/notifications' || url.pathname === '/settings' ||
      url.pathname.startsWith('/admin')) {
    return;
  }

  // Hashed and immutable: safe to serve from cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') ||
      url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return response;
      })),
    );
    return;
  }

  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(PAGES).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/offline'))),
    );
  }
});
`;
    return c.body(source, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      // The worker script itself must never be cached hard, or a new version
      // cannot announce itself.
      'cache-control': 'no-cache',
      'service-worker-allowed': '/',
    });
  });

  /**
   * Registration lives in its own file rather than inline, so the board keeps a
   * Content-Security-Policy with no 'unsafe-inline' anywhere.
   */
  app.get('/register-sw.js', (c) =>
    c.body(
      `if ('serviceWorker' in navigator) {\n` +
        `  addEventListener('load', function () {\n` +
        `    navigator.serviceWorker.register('/sw.js').catch(function () {});\n` +
        `  });\n` +
        `}\n`,
      200,
      { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    ),
  );

  return app;
}
