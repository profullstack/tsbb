# tsbb

**Live at [tsbb.dev](https://tsbb.dev)** — that board runs this code.

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
| **An API** | A permission-checked REST API with an OpenAPI description at `/api/v1/openapi.json`. |
| **A CLI** | `tsbb` reads and posts against any board from a shell, with `--json` on every command. |
| **An MCP server** | Served at `/api/mcp`, and as `tsbb-mcp` over stdio, so an assistant can use the board as a member. |

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

## Skins and branding

A board picks a skin in **Admin -> Board settings -> Appearance**. Every skin
renders the same markup, so switching one is a stylesheet change and nothing
else.

| Skin | |
|---|---|
| `modern` | Cards, generous spacing, soft shadows. The default. |
| `classic` | A 2000s bulletin board: boxy, dense, gradient title bars, Verdana. |
| `terminal` | Neutral surfaces, hairline rules, monospace chrome, window furniture on section headers. |

`classic` and `terminal` are **layers on top of** the modern sheet rather than
replacements, so a component's structure is defined in exactly one place and a
skin only argues about how it looks. Two full stylesheets drift apart within a
week.

Four settings sit beside the skin:

| Setting | |
|---|---|
| `board.accent` | One hex colour. Links, buttons, focus rings and highlights follow it. |
| `board.theme` | What a reader who has never touched the theme toggle sees: `system`, `light` or `dark`. |
| `board.logoUrl` | Your own artwork in the header, replacing the generated letter mark. |
| `board.logoHref` | Where that logo points. `/` is the board; an absolute URL is for a board that is one room in a larger site. |
| `board.faviconUrl` | Your own browser-tab icon. |

Two things about the accent are worth knowing, because both are the difference
between a setting that works and one that looks broken on half the boards that
use it.

It is **derived, not stored twice**. An accent legible on a dark board is
usually illegible on a light one — a neon green reads beautifully on near-black
and vanishes on white — so the hue you choose is emitted darkened for the light
theme and brightened for the dark one. One setting, readable in both.

And it is **baked into the stylesheet**, not written as an inline `<style>`.
The board's Content-Security-Policy has no `unsafe-inline` in `style-src`, and
widening a policy for a handful of custom properties is a poor trade. Because
the sheet is served under a content hash, changing the accent changes the URL,
so the new colour reaches a returning reader immediately instead of waiting out
a year-long `max-age`.

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

## Four ways in

The board is one thing with four front doors, and they are the same board: every
one of them resolves the same permissions, so a token can never read what a
browser would hide, and there is no second data path to drift out of step.

| | |
|---|---|
| **The pages** | Server-rendered HTML, no client-side JavaScript. |
| **[The API](docs/API.md)** | `GET /api/v1` describes itself; `/api/v1/openapi.json` describes the rest. Reading is open to whatever the board shows a guest; posting needs a token. |
| **[The CLI](docs/CLI.md)** | `tsbb` runs a board *and* uses one. `tsbb read 42`, `tsbb post general "Title" < body.md`, `--json` on everything. |
| **[MCP](docs/MCP.md)** | The board serves MCP at `/api/mcp`; `tsbb-mcp` serves the same tools over stdio for assistants that launch a subprocess. |

Clients get a token through the device flow — the board shows a short code, a
human approves it in a browser, and the client is handed a token once. A token
is never an administrator, however it was minted.

Every board serves these four documents at **`/docs`** — they are the files in
`docs/`, rendered by the board's own markdown renderer, so the site cannot
quietly disagree with the repository. On tsbb.dev that is
**[tsbb.dev/docs](https://tsbb.dev/docs)**.

## Commands

```
Running a board:
tsbb init                    Create .env, migrate and seed a new board
tsbb serve [--port N]        Run the board (it migrates at boot)
tsbb worker                  Run the mail worker separately
tsbb status                  What this board is and how big it is
tsbb admin <email>           Make somebody an administrator
tsbb invite <email>          Email somebody a sign-in link
tsbb plugin ls|enable|disable

Using a board — yours or anybody's:
tsbb login [server]          Approve a code in a browser; the token is stored
tsbb boards | use | whoami   Several boards at once, one of them current
tsbb forums | latest | topics <forum> | read <id> | search <words…> | inbox
tsbb post <forum> "<title>" [body]
tsbb reply <topic-id> [body]
tsbb mcp [--read-only]       Serve the current board to an assistant over MCP
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
  client        one REST client, shared by the TUI, the CLI and MCP
  mcp           the MCP tools and protocol, transport-agnostic
apps/
  server        the board (and /api/mcp)
  worker        notification email and housekeeping
  cli           tsbb
  tui           tsbb-tui
  mcp           tsbb-mcp
plugins/
  crawlproof-ads
  hello-world   a worked example — copy it
```

## Development

```
pnpm test          # 145 tests, no fixtures
pnpm typecheck
pnpm dev
```

The tests boot the real app and drive it through `app.fetch`, and the TUI tests
render the real views through hqtui's headless renderer — so what is asserted is
the bytes that would reach a browser or a terminal. The CLI and `tsbb-mcp` tests
go further and bind a real port, because the failures worth catching there — a
token not found where it was saved, a stray log line on stdout breaking the MCP
framing — only happen when it is done for real.

## Deployment

`tsbb.dev` runs on Railway from this repository's `main` branch: one Docker
service, a Turso database, and no volume — uploads are rows, so a redeploy
loses nothing and the service is not pinned to one replica.

| | |
|---|---|
| Host | Railway, service `tsbb`, Dockerfile build, healthcheck `/healthz` |
| Database | Turso (`libsql://tsbb-profullstack.aws-us-west-2.turso.io`) |
| Sending | Resend, from `board@tsbb.dev` (its MX sits on `send.tsbb.dev`) |
| Receiving | Forward Email on the apex MX |
| DNS | Porkbun — apex `ALIAS`, `www` `CNAME`, one SPF record covering both senders |

Two things about that DNS worth copying. The apex needs an `ALIAS` (or
CNAME-flattening) because an apex cannot be a `CNAME`; and there is exactly
**one** SPF record on the apex naming both senders, because two SPF `TXT`
records on one name is a permanent error rather than a merge — every receiver
fails it.

`www` is a separate Railway domain with its own certificate and its own edge
target, and the board 308-redirects it to the apex rather than serving both:
two origins for one board means a cookie set on one is not sent to the other,
and a passkey registered on the apex cannot be asserted on `www`.

Migrations run at boot, so a deploy can never leave new code on an old schema.
Seeding is separate (`tsbb init`, or `node packages/db/src/seed.ts`) and is what
creates the groups and permissions a board needs before anyone can read it.

## Licence

MIT © Profullstack, Inc.
