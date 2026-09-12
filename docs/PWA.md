# The app

Every tsbb board is an installable app. There is nothing to enable and nothing
to build: the manifest, the icons and the service worker are served by the board
itself, generated from its own settings.

## Installing it

Open the board in a browser and use its install action: **Install** in Chrome and
Edge, **Add to Home Screen** in Safari on iOS, **Install** in the Android menu.
It then launches in its own window with no browser chrome, using the board's
name, its icon and its theme colour.

| Path | What it is |
|---|---|
| `/manifest.webmanifest` | Name, description, colours, shortcuts and icons, from the board's settings. |
| `/icons/icon-192.png`, `/icons/icon-512.png` | The install icons, plus a maskable 512 so launchers do not crop the mark. |
| `/sw.js` | The service worker. |
| `/register-sw.js` | The one script the board serves. |
| `/offline` | The page you get with no connection, wearing the board's own chrome. |

The manifest's `short_name`, description and colours follow `board.name` and
`board.tagline`, so an installed board is branded as itself rather than as tsbb.
Shortcuts go to Latest, Notifications and Search.

## What is cached, and what is not

Pages are **network-first with a cache fallback**. On a forum, showing a stale
thread is worse than showing a spinner, so the worker always asks the network
first and only falls back to what it has when the request fails. That is what
makes the offline behaviour useful rather than confusing: what you have already
read is still there, and anything new needs a connection.

Hashed assets (`/assets/`, `/icons/`, `/uploads/`) are cache-first, because their
URL changes when their bytes do. A stale one is impossible by construction.

Nothing per-viewer or write-shaped is cached at all: `/api/`, `/auth/`,
`/notifications`, `/settings` and `/admin` are skipped by the worker.

The precache is named from the stylesheet hash and the package version, so it
moves whenever the shell actually changes, and every older cache is deleted when
a new worker activates. A hard-coded cache version is the classic way to ship a
fix that no returning reader ever sees.

## It costs the CSP nothing

Registration lives in `/register-sw.js` rather than an inline `<script>`, so the
board keeps `script-src 'self'` with no `'unsafe-inline'` anywhere. The page is
complete before that file loads: the worker is enhancement, and a browser that
does not support one loses nothing but the offline page.
