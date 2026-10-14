# Skins and branding

A board picks a skin in **Admin -> Board settings -> Appearance**. Every skin
renders the same markup, so switching one is a stylesheet change and nothing
else: no template forks, no per-skin components, no feature that exists in one
look and not another.

| Skin | |
|---|---|
| `modern` | Cards, generous spacing, soft shadows. The default. |
| `classic` | A 2000s bulletin board: boxy, dense, gradient title bars, Verdana. |
| `terminal` | Neutral surfaces, hairline rules, monospace chrome, window furniture on section headers. |
| `deals` | A coupon and deal-sharing storefront: white surfaces, slate greys, the accent as a flat fill with white text, Geist (self-hosted), a dark footer. Made for a board that lives inside a deals site, like [c0upons.com/bbs](https://c0upons.com/bbs). |
| `paper` | Editorial: warm paper (`#f6f4ed`), green-black ink, sage hairlines, Georgia headlines, small mono capitals for labels, system fonts only. A 100px header ruled off by a hairline, a standard forum list (category boxes, one row per forum with counts and the latest post), topics as a ruled list, code as a dark terminal, a three-column site footer. **Light-only.** Made for a board that lives inside a publication-style site, like [w3bs.org/bbs](https://w3bs.org/bbs). |

`classic`, `terminal`, `deals` and `paper` are **layers on top of** the modern
sheet rather than replacements. A component's structure is defined in exactly
one place, and a skin only argues about how it looks. That is why a new
component appears in every skin the day it is written.

## The paper skin

`paper` is for a board that is one room in an editorial site: it should look
like the site's own pages, not like a forum bolted on. It follows the accent
like every skin (primary buttons fill with it, links and the current page are
set in it, and with no accent it brings its own vermilion, `#d95231`), but every
neutral is its own: paper, ink, sage lines.

What it does differently from the other skins:

- **It is light-only.** Paper has no dark palette, so the board renders light
  for every reader, ignores `board.theme` and a reader's theme cookie, and drops
  the theme toggle. A light-only host site with a board that went dark on the
  reader's OS setting would stop looking like one site.
- **The wordmark is the logo plus the board name**, with a full stop in the
  accent: set `board.logoUrl` to a square mark and `board.name` to the word.
- **The header is the host site's header**: no search box (search is in the
  footer), plain-text navigation, the sign-in link as bold text, and the host's
  call to action as an outlined button (a `| button` line in `board.navLinks`).
- **The footer is a site footer**: the wordmark and tagline, a column of the
  host site's links (headed with its host name), a column of the board's own,
  and the copyright line as a mono colophon.

A board inside w3bs.org, for example, is set up as:

| Setting | Value |
|---|---|
| `board.skin` | `paper` |
| `board.accent` | `#d95231` |
| `board.name` | `w3bs` |
| `board.logoUrl` | `https://w3bs.org/assets/mark.svg` |
| `board.logoHref` | `https://w3bs.org/mission` |
| `board.theme` | `light` |
| `board.showPlatform` | off |

with `board.navLinks`:

```
Packages | https://w3bs.org/packages
Standards | https://w3bs.org/specs
Browse | https://w3bs.org/browse
Prompts | https://w3bs.org/prompts
Desktop | https://w3bs.org/desktop
Community | {forums}
Participate | https://w3bs.org/governance
Start building ↗ | https://w3bs.org/developers | button
```

## The terminal look, and the actual terminal

The `terminal` skin is a board that looks like a console in a browser. It is not
the same thing as `tsbb-tui`, which is a real terminal client: a pure client over
the REST API, with device-code sign-in, for reading and posting over SSH. Use
whichever one you meant.

```
pnpm tui                 # or: tsbb-tui
```

## Branding

Six settings sit beside the skin.

| Setting | |
|---|---|
| `board.accent` | One hex colour. Links, buttons, focus rings and highlights follow it. |
| `board.theme` | What a reader who has never touched the theme toggle sees: `system`, `light` or `dark`. |
| `board.logoUrl` | Your own artwork in the header, replacing the generated letter mark. |
| `board.logoHref` | Where that logo points. `/` is the board; an absolute URL is for a board that is one room in a larger site. |
| `board.faviconUrl` | Your own browser-tab icon. |
| `board.navLinks` | Your site's own navigation for a board inside a larger site: one `Label \| https://…` per line, `{board}` where Forums, Latest and Members go, or `{forums}` for Forums alone (`Community \| {forums}` to call it something else; it is then the current section on every board page). A line ending `\| button` becomes the header's call to action. The `deals` skin lays the header out like a storefront: logo, search with its button, then this nav; `paper` lays it out like the host site's header. |

Two things about the accent are worth knowing, because both are the difference
between a setting that works and one that looks broken on half the boards using
it.

**It is derived, not stored twice.** An accent legible on a dark board is
usually illegible on a light one, so the hue you choose is emitted darkened for
the light theme and lifted for the dark one. One setting, readable in both.

**It is baked into the stylesheet**, not written as an inline `<style>`. The
board's Content-Security-Policy has no `'unsafe-inline'` in `style-src`, and that
governs inline style *attributes* too. Because the sheet is served under a
content hash, changing the accent changes its URL, so the new colour reaches a
returning reader immediately instead of waiting out a long `max-age`.

A plugin can add its own tags to `<head>` through the `page:head` filter, and
widen the policy it needs through `security:csp`, so a plugin can bring styling
of its own. See [the plugin guide](PLUGINS.md).
