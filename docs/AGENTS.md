# Agents

A tsbb board is readable by people and by programs, and it is the same board
either way. There is no agent tier, no separate JSON site, and no scraping
required: the pages are complete server-rendered HTML, and every one of them has
a machine-facing equivalent that answers with the same permissions.

## What a board publishes for machines

| Path | What it is |
|---|---|
| `/llms.txt` | The board in one page of markdown: what it is, its public forums, and every way in. |
| `/llms-full.txt` | Every guide on this site concatenated as markdown. |
| `/skill.md` | An agent skill: what can be done here, and how to authenticate. |
| `/robots.txt` | Crawl rules, with the AI crawlers named and allowed rather than left to a default. |
| `/sitemap.xml` | A sitemap index: the fixed pages and forums in one file, topics in one file per month. |
| `/api/v1/openapi.json` | The REST API, machine-readable. |
| `/api/mcp` | The MCP server over streamable HTTP. |
| `/feeds`, `/feeds.opml` | Every RSS feed on the board, and an OPML file of all of them. |

All of it is generated from the board's settings and its forum tree, so none of
it can describe a board that no longer exists. And all of it is what a **guest**
can see: a sitemap that listed a private forum would be a directory of pages the
crawler then gets a 403 for.

Pages also carry JSON-LD. Every page has a `WebSite` graph with the board's
publisher and a `SearchAction`; a thread carries a `DiscussionForumPosting` with
its posts as comments.

## Agent-ok

Three things make the board usable by a program without special handling.

**One read path.** The API, the CLI and the MCP tools are all clients of
`/api/v1`, and `/api/v1` resolves the same permission checks the HTML pages do.
An agent cannot see something a browser would hide, because there is no second
query to get it wrong.

**Bearer tokens, never cookies, on `/api/mcp`.** Browsers attach cookies to
cross-origin POSTs, so honouring one would turn the MCP endpoint into a write
primitive for any page on the web. It reads the `Authorization` header and
nothing else.

**A token is never an administrator.** Whatever account minted it, a token is
refused by `/admin/*`. The worst case for a leaked token is a member, not an
operator.

## Human-ok

The same three decisions are what make it good for people.

No client-side JavaScript: reading, posting, moderating, paging, searching and
switching theme are document requests and form submissions, so the board works
with scripting off, on a slow connection and in a terminal browser. The one
script it serves registers the service worker, and every page is complete
without it.

Markup is safe by construction. Source text is escaped as it is emitted and the
only tags that appear are ones the renderer writes literally, so a post is
content rather than a sanitiser's problem.

And a person who wants a terminal rather than a browser has two: the `terminal`
skin, and `tsbb-tui` over SSH.

## Start here

```
curl https://tsbb.dev/llms.txt
curl https://tsbb.dev/api/v1 | jq
```

Then [the API guide](API.md) for tokens and routes, [the MCP guide](MCP.md) for
connecting an assistant, and [the CLI guide](CLI.md) for driving a board from a
shell or a cron job.
