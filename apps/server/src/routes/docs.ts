import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderInline, renderMarkdown } from '@tsbb/markup';
import { Card, CardContent, Empty, trusted } from '@tsbb/ui';
import { render, type AppEnv, type Services } from '../context.ts';

/**
 * The board's own documentation, served by the board.
 *
 * These pages are the repository's `docs/*.md` files, rendered through the same
 * markdown renderer that renders posts. That is the whole design: there is one
 * copy of each document, it is reviewed in the pull request that changes the
 * behaviour it describes, and it cannot quietly disagree with the site — a
 * second hand-written HTML version always ends up describing last year's API.
 *
 * It also means the docs inherit the board's guarantees: no client-side
 * JavaScript, the same stylesheet, the same CSP, and a set of tags that is
 * exactly the set the renderer writes literally.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(HERE, '../../../../docs');

interface Doc {
  slug: string;
  file: string;
  /** Shown on the index. The <h1> comes from the file itself. */
  blurb: string;
}

const DOCS: Doc[] = [
  {
    slug: 'api',
    file: 'API.md',
    blurb:
      'The REST API: what it serves, how to get a token, and where the OpenAPI description lives.',
  },
  {
    slug: 'cli',
    file: 'CLI.md',
    blurb: 'The `tsbb` command — running a board, and using one from a shell or a script.',
  },
  {
    slug: 'mcp',
    file: 'MCP.md',
    blurb: 'Connecting an AI assistant to this board, over HTTP or stdio, and the tools it gets.',
  },
  {
    slug: 'plugins',
    file: 'PLUGINS.md',
    blurb: 'Writing a plugin: filters, actions, slots, settings and routes.',
  },
];

const BY_SLUG = new Map(DOCS.map((doc) => [doc.slug, doc]));

interface Rendered {
  title: string;
  body: string;
  mtimeMs: number;
}

const cache = new Map<string, Rendered>();

/**
 * Rewrite links between documents.
 *
 * On GitHub `[the MCP guide](MCP.md)` resolves beside the file it is written
 * in; on the site it has to be `/docs/mcp`. Rewriting here rather than writing
 * site paths in the files keeps both readers working, which matters because the
 * repository is where most people will meet these documents first.
 */
/*
 * A line a paragraph must not swallow, and a line that must not be swallowed.
 * Between them they are "is this the start of a block?", which is the only
 * question unwrapParagraphs has to answer.
 */
const NO_JOIN_AFTER = /^(\s*#{1,6}\s|\||\s*(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const NO_JOIN_ONTO = /^(\s*(?:[-*+]|\d+[.)])\s+|\s*>|\s*#{1,6}\s|\||\s*(?:-{3,}|\*{3,}|_{3,})\s*$)/;

/**
 * Join the lines of a paragraph back into one.
 *
 * The board's markdown renderer turns a single newline into a `<br>`, and that
 * is right for a post: somebody who pressed return meant it. Documentation is
 * written the other way round — hard-wrapped at eighty columns so it reads and
 * diffs well in an editor — and rendering those wraps literally gives a column
 * of ragged text about half the width of the page.
 *
 * So the wrapping is undone here rather than by changing the renderer, because
 * the renderer's behaviour is correct for the thing it mostly renders. Code
 * fences are copied through untouched, and a line that begins a block — a
 * heading, list item, quote, table row or rule — neither joins nor is joined.
 */
function unwrapParagraphs(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const previous = out.at(-1);
    const joinable =
      previous !== undefined &&
      previous.trim() !== '' &&
      line.trim() !== '' &&
      !NO_JOIN_ONTO.test(line) &&
      !NO_JOIN_AFTER.test(previous) &&
      // Two trailing spaces are markdown's own hard break, and mean it.
      !previous.endsWith('  ');

    if (joinable) out[out.length - 1] = `${previous} ${line.trim()}`;
    else out.push(line);
  }

  return out.join('\n');
}

function rewriteLinks(source: string): string {
  return source.replace(/\]\((?:\.\/)?(?:docs\/)?([A-Za-z0-9_-]+)\.md(#[^)]*)?\)/g, (match, name, hash) => {
    const slug = String(name).toLowerCase();
    if (!BY_SLUG.has(slug)) return match;
    return `](/docs/${slug}${hash ?? ''})`;
  });
}

/**
 * Read and render one document, remembering the result until the file changes.
 *
 * The mtime is checked on every request — one stat, against a page that would
 * otherwise re-parse markdown each time — so editing a document in development
 * shows up on reload without a restart, and production pays almost nothing.
 */
function load(doc: Doc): Rendered | null {
  const path = join(DOCS_DIR, doc.file);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // A missing document is not an error worth a 500: the board still runs, the
    // page says so, and the rest of the documentation is unaffected.
    return null;
  }

  const cached = cache.get(doc.slug);
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  const source = readFileSync(path, 'utf8');
  const heading = /^#\s+(.+)$/m.exec(source);
  const title = heading?.[1]?.trim() ?? doc.slug;

  // The document's own <h1> becomes the page title, so it is not rendered
  // twice, and everything below it is demoted a level to sit under it.
  const withoutTitle = heading ? source.replace(heading[0], '') : source;

  const rendered: Rendered = {
    title,
    body: renderMarkdown(unwrapParagraphs(rewriteLinks(withoutTitle)), {
      headingOffset: 1,
      internalHosts: [],
    }),
    mtimeMs,
  };
  cache.set(doc.slug, rendered);
  return rendered;
}

export function docsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get('/docs', async (c) => {
    const entries = DOCS.map((doc) => ({ doc, rendered: load(doc) })).filter(
      (entry): entry is { doc: Doc; rendered: Rendered } => entry.rendered !== null,
    );

    return render(c, services, {
      title: 'Documentation',
      description: 'How to use this board from a browser, a shell, a script or an AI assistant.',
      body: html`
        <div class="page-head">
          <div>
            <h1 class="page-title">Documentation</h1>
            <p class="page-subtitle">
              This board is not only a website. It has an API, a command line client and an MCP
              server, and they all answer with the same permissions the pages do.
            </p>
          </div>
        </div>
        ${entries.length
          ? Card(
              CardContent(
                html`<div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Document</th>
                        <th>What it covers</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${entries.map(
                        (entry) => html`<tr>
                          <td><a href="/docs/${entry.doc.slug}">${entry.rendered.title}</a></td>
                          <td>${trusted(renderInline(entry.doc.blurb))}</td>
                        </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>`,
                { flush: true },
              ),
            )
          : Card(
              CardContent(
                Empty('No documentation', 'This install was deployed without its docs directory.'),
              ),
            )}
      `,
    });
  });

  app.get('/docs/:slug', async (c) => {
    const doc = BY_SLUG.get(c.req.param('slug'));
    if (!doc) return c.notFound();

    const rendered = load(doc);
    if (!rendered) return c.notFound();

    return render(c, services, {
      title: rendered.title,
      description: doc.blurb.replace(/`/g, ''),
      canonical: new URL(`/docs/${doc.slug}`, services.baseUrl).toString(),
      body: html`
        <div class="page-head">
          <div>
            <h1 class="page-title">${rendered.title}</h1>
            <p class="page-subtitle"><a href="/docs">All documentation</a></p>
          </div>
        </div>
        <!-- The same class a post body uses: rendered markdown is rendered
             markdown, and the docs get code blocks, tables and quotes styled
             identically in both skins without a line of new CSS. -->
        ${Card(CardContent(html`<div class="post-body">${trusted(rendered.body)}</div>`))}
        <p class="small muted" style="margin-top:1rem">
          This page is
          <a
            href="https://github.com/profullstack/tsbb/blob/main/docs/${doc.file}"
            rel="noopener"
            >docs/${doc.file}</a
          >
          in the repository, rendered by the board.
        </p>
      `,
    });
  });

  return app;
}
