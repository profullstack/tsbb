# MCP

A tsbb board is an MCP server, so an assistant can read the forum, search it,
and — with a token — post to it.

There are two ways to reach the same tools, because clients differ in what they
can launch:

| | |
|---|---|
| **Over HTTP** | `POST https://forum.example.com/api/mcp`, streamable HTTP. Nothing to install. |
| **Over stdio** | `tsbb-mcp`, a subprocess the client launches. What Claude Desktop and most editors expect. |

Both run the same tools, and those tools are written against the board's own
REST API. An assistant therefore sees exactly what the member whose token it
holds would see in a browser, and can do exactly what they could do. A forum
missing from `list_forums` is a forum that member cannot read.

## Over stdio

```json
{
  "mcpServers": {
    "myboard": {
      "command": "npx",
      "args": ["-y", "@profullstack/tsbb-mcp", "--server", "https://forum.example.com"],
      "env": { "TSBB_TOKEN": "tsbb_…" }
    }
  }
}
```

Or, in Claude Code:

```
claude mcp add myboard -- npx -y @profullstack/tsbb-mcp --server https://forum.example.com
```

Where the token comes from, in order: `--token`, `TSBB_TOKEN`, then whichever
board you last ran `tsbb login` against. If you have already signed in with the
CLI, `tsbb mcp` needs no arguments at all.

```
tsbb-mcp --server forum.example.com --token tsbb_…
tsbb-mcp --read-only          # reading tools only, even with a token
tsbb mcp                      # the board the CLI is signed in to
```

Get a token with `tsbb login`, or the device flow in
**[docs/API.md](API.md)**. Without one the server still runs — it reads whatever
the board shows a guest, and the posting tools are not offered.

## Over HTTP

```
curl -X POST https://forum.example.com/api/mcp \
  -H 'authorization: Bearer tsbb_…' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

One JSON-RPC message per request; the response comes back as JSON. A
notification — a message with no `id` — is answered with `202` and no body. The
endpoint is stateless, so there is no session to establish and nothing to keep
open. `GET` answers `405`: this server never initiates messages, and saying so
is better than a stream that hangs.

**Bearer tokens only.** The endpoint ignores the board's session cookie, even a
valid one. Browsers attach cookies to cross-origin POSTs, so honouring one here
would let any page on the web post to the board as whoever is signed in. A token
has to be handed over on purpose, which is the property that makes it safe.

## The tools

Reading — always available:

| | |
|---|---|
| `board_overview` | Name, size, and the forum tree. The place to start: everything else needs a slug or an id from here. |
| `list_forums` | Every readable forum, flat, with slugs |
| `list_topics` | One forum's topics, or the latest across the board |
| `read_topic` | A topic's posts as plain text, Markdown and BBCode already rendered down |
| `read_post` | One post, with its topic |
| `search_posts` | Full-text search, titles weighted above bodies |
| `get_member` | A member's public profile |
| `whoami` | Whether this server is signed in, as whom, and whether it may post |
| `list_notifications` | Replies, mentions, quotes and messages |

Writing — offered only when the server holds a token and was not started
`--read-only`:

| | |
|---|---|
| `create_topic` | Start a topic in a forum |
| `reply_to_topic` | Reply to one |

The write tools are hidden rather than left to fail, so a model is never offered
an action that cannot work. Asking for one anyway gets an error that says why.

Both write tools post publicly under the member's name, and both say so in their
descriptions: an assistant should quote back what it is about to post and get a
yes first. That is a convention, not an enforcement — if you want it enforced,
run the server `--read-only`, or sign it in as an account whose group cannot
post.

## Protocol

Speaks `2025-06-18`, `2025-03-26` and `2024-11-05`, echoing back whichever a
client asks for if it is one of those, and the newest otherwise.

Tools are the only capability. A forum is a query rather than a document with a
stable URI, so the board's data is better modelled as tools than as MCP
resources — and advertising a capability that answers nothing is worse than not
having it. `resources/list` and `prompts/list` answer `-32601`.

Tool results carry both a readable `content` block and a `structuredContent`
object with the raw API response, so a model can read the text and a program can
use the JSON.

A failure inside a tool comes back as a result with `isError` and the board's own
words — "This topic is locked", "Sign in to reply" — rather than a protocol
error, because a model can act on the first and not on the second.
