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

`classic` and `terminal` are **layers on top of** the modern sheet rather than
replacements. A component's structure is defined in exactly one place, and a
skin only argues about how it looks. That is why a new component appears in all
three the day it is written.

## The terminal look, and the actual terminal

The `terminal` skin is a board that looks like a console in a browser. It is not
the same thing as `tsbb-tui`, which is a real terminal client: a pure client over
the REST API, with device-code sign-in, for reading and posting over SSH. Use
whichever one you meant.

```
pnpm tui                 # or: tsbb-tui
```

## Branding

Five settings sit beside the skin.

| Setting | |
|---|---|
| `board.accent` | One hex colour. Links, buttons, focus rings and highlights follow it. |
| `board.theme` | What a reader who has never touched the theme toggle sees: `system`, `light` or `dark`. |
| `board.logoUrl` | Your own artwork in the header, replacing the generated letter mark. |
| `board.logoHref` | Where that logo points. `/` is the board; an absolute URL is for a board that is one room in a larger site. |
| `board.faviconUrl` | Your own browser-tab icon. |

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
