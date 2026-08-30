# tsbb

A TypeScript bulletin board. Forums, topics, replies, moderation, private
messages, avatars, signatures, search, feeds — and a plugin system that ships
with the board rather than being bolted on later.

If you have run phpBB, SMF or vBulletin, you already know what this is. The
difference is what it is made of: TypeScript that runs unbuilt, one SQLite file
by default, no client-side JavaScript, and a terminal client.

```
pnpm install
pnpm exec tsbb init
pnpm start
```

Open <http://localhost:3000>, put in your email address, and click the link.
**The first account to sign in becomes the administrator.**

---

## What you get

| | |
|---|---|
| **Forums** | A tree of categories and forums, nested as deep as you like, with per-group permissions on every node. |
| **Topics and posts** | Markdown *and* BBCode, quoting, editing with revision history, reactions, sticky and announcement topics, locking, polls, attachments. |
| **People** | Magic-link sign-in, passkeys, groups, ranks earned by post count, profiles, avatars, signatures. |
| **Notifications** | Replies to topics you follow, mentions, quotes, private messages — in an inbox and by email, batched so six replies are one message. |
| **Moderation** | Reports, a moderation log, warnings, bans by pattern, hidden vs deleted as separate states with separate owners. |
| **Search** | SQLite FTS5 with titles weighted above bodies, so searching a topic's name finds the topic. |
| **Feeds** | RSS for the board and for every forum, permission-checked exactly as the page is. |
| **Ads** | The [CrawlProof](https://crawlproof.com/ads) ad network, on by default, in one CSP-safe iframe. |
| **A terminal client** | `tsbb-tui` — read and post against any board over SSH. |

## Design decisions worth knowing before you read the code

**No client-side JavaScript.** Not "progressive enhancement" — none. Reading,
posting, moderating, paging, searching and switching theme are all document
requests or form submissions. The board works with scripting off, on a slow
connection, in a terminal browser, and under a Content-Security-Policy of
`script-src 'none'`.

**No build step.** Node 24 runs the `.ts` files directly through type stripping.
There is nothing to compile, which is what makes runtime plugins possible at
all: a plugin is a directory you drop in, not something you rebuild the board
around. (`erasableSyntaxOnly` is set in `tsconfig.json` so a construct type
stripping cannot erase fails typechecking rather than at boot.)

**Uploads live in the database.** An avatar is a row, not a file, so a
deployment needs no volume, loses nothing on redeploy, and is not pinned to one
replica. This is the right trade at avatar scale; a board serving large
attachments should put those behind object storage.

**One SQLite file by default.** `TSBB_DATABASE_URL=file:./data/tsbb.db`. Point it
at a `libsql://` URL and the same board runs on Turso with no other change.

**Counters are derived, never incremented.** Hiding or deleting a post takes its
contribution with it, so a count can never drift permanently away from what is
actually on the page.

**Signatures are earned.** A signature is not shown until its author has ten
posts. A brand-new account whose first post carries a signature full of links is
the shape of every piece of forum spam ever written. The threshold is a setting
*and* a filter, so a plugin can change the rule. The editor is available from
day one — hiding it would read as a missing feature rather than a rule.

**Markup is safe by construction.** Source text is escaped as it is emitted and
the only tags that can appear are ones the renderer writes literally. Raw HTML in
a post is content, not markup. There is no sanitiser to bypass because there is
no path from input to a tag.

## Plugins

Plugins are first-class, not an afterthought. A plugin is a directory in
`plugins/` (or `TSBB_PLUGIN_DIR`) exporting a manifest and a `setup` function:

```ts
import { definePlugin } from '@tsbb/plugin-api';

export default definePlugin({
  manifest: {
    slug: 'hello-world',
    name: 'Hello World',
    version: '1.0.0',
    settings: [{ key: 'greeting', label: 'Greeting', type: 'string', default: 'Hello' }],
  },
  setup(ctx) {
    ctx.slot('board:below_categories', () => `<p>${ctx.settings.get('greeting')}</p>`);
    ctx.filter('post:render', (html) => html);
    ctx.on('post:created', async ({ post }) => { /* … */ });
    ctx.route('GET', '/status', () => ({ ok: true }));
  },
});
```

Three mechanisms, deliberately distinct:

- **filters** transform a value and must return one
- **actions** observe something that happened
- **slots** contribute markup at a named place in a page

Keeping them apart means a slow webhook in an action can never corrupt a render,
and a plugin that throws is skipped rather than blanking the page it was
rendering into. A plugin's settings form is generated from its manifest, so no
plugin ships its own admin page.

Full guide: **[docs/PLUGINS.md](docs/PLUGINS.md)**.

> A plugin is code running inside the board, exactly as in phpBB or WordPress.
> The context object is an ergonomic API, not a sandbox. Installing a plugin is
> installing code, and the admin panel says so.

A plugin marketplace is planned for v2. Until then, plugins are directories.

## Ads

The bundled `crawlproof-ads` plugin is **enabled by default**. It renders
nothing until you set a slot ID in *Administration → Plugins*, so an
unconfigured board looks finished rather than broken.

It serves through `crawlproof.com/api/ads/frame` rather than loading `ad.js`,
and that choice is deliberate. `ad.js` injects its creative into a `srcdoc`
iframe, and a `srcdoc` document inherits the embedder's CSP — so `ad.js` only
renders on a page carrying `'unsafe-inline'` in `style-src` and a wide-open
`img-src`, site-wide and permanently. The frame endpoint is a cross-origin
document with its own policy, so the entire cost to your board is one `frame-src`
entry: no scripts, no cookies, no visitor ID in your storage. Impressions meter
server-side either way, so it earns the same.

Turn it off in the admin panel and the `frame-src` permission goes with it.

## The terminal client

```
pnpm exec tsbb-tui https://forum.example.com
```

Press `L` to sign in: the client shows a short code, you approve it in a browser,
and the board hands the terminal a token — once. It is a *client* of a
centralised install, not a second board: it holds no database and can only see
what the API would show a browser.

```
 A tsbb board                                                                bob
 ───────────────────────────────────────────────────────────────────────────────
 ╭─ Does anyone still run a forum in 2026? ────────────────────────────────────╮
 │ > #1  ann · now                                                             │
 │      I keep coming back to the idea that a forum beats a chat room for      │
 │      anything worth reading twice. Threads have titles. Search works.       │
 │                                                                             │
 │   #2  bob · now                                                             │
 │      Yes, and the archive is the whole point.                               │
 ╰─────────────────────────────────────────────────────────────────────────────╯
 ───────────────────────────────────────────────────────────────────────────────
  2 posts                  r reply · j/k move · backspace back · ? help · q quit
```

## Commands

```
tsbb init                    Create .env, migrate and seed a new board
tsbb serve [--port N]        Run the board (it migrates at boot)
tsbb worker                  Run the mail worker separately
tsbb status                  What this board is and how big it is
tsbb admin <email>           Make somebody an administrator
tsbb invite <email>          Email somebody a sign-in link
tsbb plugin ls|enable|disable
```

## Configuration

Everything is environment variables, or a `.env` beside you. `tsbb init` writes
one with a fresh session secret and whatever you already had set.

| Variable | Default | |
|---|---|---|
| `TSBB_DATABASE_URL` | `file:./data/tsbb.db` | A path, or a `libsql://` URL for Turso |
| `TSBB_BASE_URL` | `http://localhost:3000` | Used for links in email and canonical URLs |
| `TSBB_PORT` | `3000` | |
| `TSBB_SESSION_SECRET` | — | 32 random bytes; also salts stored IP hashes |
| `TSBB_MAIL_TRANSPORT` | `console` | `console`, `resend` or `smtp` |
| `TSBB_MAIL_FROM` | — | |
| `RESEND_API_KEY` / `SMTP_URL` | — | For the matching transport |
| `TSBB_PLUGIN_DIR` | `./plugins` | Extra plugins, on top of the bundled ones |
| `TSBB_WORKER` | in-process | Set to `external` to run the worker yourself |

The worker runs inside the server by default, so email works from one command.

## Layout

```
packages/
  db            libSQL client, forward-only migrations, FTS helpers
  core          settings, users, permissions, forums, topics, posts, auth…
  markup        markdown + BBCode, safe by construction
  plugin-api    the contract a plugin depends on — the leaf of the tree
  plugin-host   discovery, the hook bus, the plugin context
  design-tokens shadcn tokens in oklch
  ui            server-rendered components
  mail          transports and templates
apps/
  server        the board
  worker        notification email and housekeeping
  cli           tsbb
  tui           tsbb-tui
plugins/
  crawlproof-ads
  hello-world   a worked example — copy it
```

## Development

```
pnpm test          # 78 tests, no network, no fixtures
pnpm typecheck
pnpm dev
```

The tests boot the real app and drive it through `app.fetch`, and the TUI tests
render the real views through hqtui's headless renderer — so what is asserted is
the bytes that would reach a browser or a terminal.

## Licence

MIT © Profullstack, Inc.
