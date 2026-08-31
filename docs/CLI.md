# The CLI

`tsbb` does two unrelated jobs, and it is worth knowing which one you are asking
for.

**Running a board** — `init`, `serve`, `migrate`, `admin`, `invite`, `plugin` —
operates on the database beside you. These are the commands a self-hoster runs
on their own box, and they need a `.env` or the matching environment variables.

**Using a board** — everything below — talks to a board over its API. These need
no database and no `.env`: they work from any directory, against your board or
anybody else's.

The packages are not on npm yet, so both jobs are done from a checkout:

```
git clone https://github.com/profullstack/tsbb
cd tsbb && pnpm install
pnpm exec tsbb --help
```

Put it on your path if you are going to use it from elsewhere, which is what the
rest of this page assumes:

```
ln -s "$PWD/apps/cli/bin/tsbb.mjs" ~/.local/bin/tsbb
```

## Signing in

```
tsbb login forum.example.com
```

The board prints a short code and a URL. Approve it in a browser and the token
is written to `~/.config/tsbb/config.json` (0600, in a 0700 directory — it is a
credential). A bare hostname is assumed to be `https`, except `localhost`.

You can be signed in to several boards at once, because people belong to more
than one forum:

```
tsbb boards          # every board, with the current one marked
tsbb use other.example
tsbb whoami
tsbb logout          # forget the token for one board
```

Any command takes `--server <url>` to talk to a different board for one
invocation, using that board's stored token if there is one.

## Reading

```
tsbb forums
tsbb latest --limit 50
tsbb topics general
tsbb read 42
tsbb search sqlite full text
tsbb inbox
```

## Posting

```
tsbb post general "Does anyone still run a forum in 2026?" "I keep coming back…"
tsbb post general "Release notes" < NOTES.md
tsbb reply 42 "Yes, and the archive is the whole point."
git log -1 --format=%B | tsbb reply 42
```

The body may be an argument or piped in on stdin. Bodies are Markdown.

## `--json`

Every command above takes `--json` and prints the API's own response. That is
the reason to have a CLI at all rather than only a terminal client — its output
is somebody else's input:

```
tsbb latest --json | jq -r '.topics[] | "\(.id)\t\(.title)"'
tsbb search "release" --json | jq '.hits | length'

# Reply to every topic you have not read yet, if you like living dangerously
tsbb latest --json | jq -r '.topics[] | select(.unread) | .id' |
  while read id; do echo "seen" | tsbb reply "$id"; done
```

Failures print one line and exit non-zero. A stack trace from a CLI tells the
reader nothing about whether they typed something wrong, are not signed in, or
the board is down.

## Serving MCP

```
tsbb mcp                # the current board, over stdio
tsbb mcp --read-only    # reading tools only, even though a token is loaded
```

This is the same server as `tsbb-mcp`, using the board and token you are already
signed in to. See the [MCP guide](MCP.md).

## Flags

| Flag | What it does |
|---|---|
| `--server <url>` | Talk to that board instead of the current one |
| `--json` | Print the API's JSON |
| `--limit <n>` | How many rows to fetch (the board caps this at 100) |
| `--read-only` | `tsbb mcp` only: refuse to offer the posting tools |

They may appear anywhere: `tsbb read 42 --json` and `tsbb --json read 42` both
work, because both are what people type.
