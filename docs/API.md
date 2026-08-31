# The API

Every board serves a REST API at `/api/v1`. It is the same data the HTML pages
render, resolved through the same permission checks — so a token can never see
something the browser would hide, and there is no second read path to keep in
step with the first one.

The terminal client, the CLI and the MCP server are all clients of this API.
Nothing they can do is something the API would not let a browser do.

## Start with the index

```
curl https://forum.example.com/api/v1
```

```json
{
  "api": "tsbb",
  "version": "1",
  "board": { "name": "A tsbb board", "tagline": "…", "url": "https://forum.example.com" },
  "authenticated": false,
  "auth": { "scheme": "Bearer", "deviceFlow": "https://forum.example.com/api/v1/device/start" },
  "endpoints": { "…": "…" },
  "mcp": { "endpoint": "https://forum.example.com/api/mcp", "transport": "streamable-http", "tools": 11 },
  "openapi": "https://forum.example.com/api/v1/openapi.json"
}
```

One unauthenticated request tells a client whether this is a tsbb board, where
to sign in, and whether it speaks MCP. `GET /api/v1/openapi.json` describes the
rest as OpenAPI 3.1.

## Reading

No token needed for anything a guest can see on the site.

| | |
|---|---|
| `GET /api/v1/board` | The forum tree, filtered to what you may see |
| `GET /api/v1/forums` | The same forums, flat, each with a `depth` |
| `GET /api/v1/latest` | Recently active topics across every readable forum |
| `GET /api/v1/forums/{slug}/topics` | Topics in one forum |
| `GET /api/v1/topics/{id}` | A topic and a page of its posts |
| `GET /api/v1/posts/{id}` | One post, with the topic it belongs to |
| `GET /api/v1/users/{username}` | A member's public profile |
| `GET /api/v1/search?q=` | Full-text search, titles weighted above bodies |
| `GET /api/v1/stats` | Members, topics, posts |
| `GET /api/v1/me` | Who this token is — `authenticated: false` for a guest, not a 401 |

`limit` and `offset` work wherever a list is returned; `limit` is capped at 100.

Every post body arrives twice: `body` is the source, in `format` (`markdown` or
`bbcode`), and `text` is a plain rendering. A terminal cannot draw HTML and a
model does not want to parse BBCode, so the plain form travels alongside rather
than making every client reimplement the parser.

## Writing

Needs a token, and the same permissions the member has on the page.

| | |
|---|---|
| `POST /api/v1/forums/{slug}/topics` | `{ "title": "…", "body": "…", "format": "markdown" }` |
| `POST /api/v1/topics/{id}/posts` | `{ "body": "…", "format": "markdown" }` |
| `GET /api/v1/notifications` | `?unread=1` for only the unread ones |
| `POST /api/v1/notifications/read` | Mark everything read |

A refused post answers 400 with the board's own reason — `too_short`,
`flooding`, and so on — rather than a generic failure, so a client can say what
went wrong.

## Getting a token

Clients cannot hold a browser session, so tokens come from a device flow: the
client asks for a code, a human approves it in a browser, and the client polls
until the board hands it a token.

```
POST /api/v1/device/start   { "label": "my script" }
  → { "userCode": "ABCD-1234", "verifyUrl": "…/device", "interval": 2, … }

POST /api/v1/device/poll    { "deviceCode": "…" }
  → { "status": "pending" }  … then { "status": "approved", "token": "tsbb_…" }
```

Send it as `Authorization: Bearer tsbb_…`.

`tsbb login` does all of this for you and saves the token; `tsbb --json` is
often a shorter path to the same JSON than curl.

**A token is never an administrator**, however it was minted. Administration is
a browser-session thing, deliberately: a leaked token must not be able to
reconfigure the board.

Poll no faster than the `interval` the board returns. Codes expire; a poll after
that answers 410 rather than pretending.

## Errors

```json
{ "error": "forbidden", "message": "…" }
```

`401` no token, or one no longer valid. `403` a valid token that is not allowed
this. `404` no such thing — or none you may see, because a board that
distinguishes those two is a board that leaks what exists.

Every `/api/*` response carries `cache-control: no-store`. The API is
permission-dependent, so a shared cache holding one member's answer for another
is a data leak rather than a speed-up.
