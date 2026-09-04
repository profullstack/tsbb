import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { forumTree, guestViewer, visibleForumIds, type Settings } from '@tsbb/core';
import { escapeHtml } from '@tsbb/markup';
import { all } from '@tsbb/db';
import { Card, CardContent, LinkButton } from '@tsbb/ui';
import { render, type AppEnv, type Services } from '../context.ts';
import { DOCS, docMarkdown } from './docs.ts';

/**
 * The files a machine reads before it reads the board.
 *
 * robots.txt, the sitemap, llms.txt, security.txt and skill.md are all answers
 * to the same question — "what is here, and what may I do with it?" — asked
 * by a search crawler, a language model, a security researcher and an agent
 * respectively. They are generated from the board's settings and its forum
 * tree rather than shipped as static files, because a static file describes
 * the board the day it was written and a forum changes every day.
 *
 * Everything here is what a GUEST can see. A sitemap that listed a private
 * forum's topics would be a directory of pages the crawler then gets 403 for,
 * and a worse leak than the 403.
 */

/** The address a person reaches the operator at, or null when there is none. */
export function contactAddress(settings: Settings): string | null {
  const configured = String(settings['board.contactEmail'] ?? '').trim();
  if (configured) return configured;

  // The sending address is usually a real mailbox, and sometimes "Name <addr>".
  const from = process.env.TSBB_MAIL_FROM ?? '';
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();
  if (!address || address.endsWith('@localhost')) return null;
  return address;
}

/** Forum slugs a guest may read, in tree order. */
async function publicForums(): Promise<{ slug: string; name: string; description: string | null }[]> {
  const guest = await guestViewer();
  const readable = new Set(await visibleForumIds(guest));
  const tree = await forumTree(guest);

  const flat = (nodes: typeof tree): typeof tree =>
    nodes.flatMap((node) => [...(node.kind === 'forum' ? [node] : []), ...flat(node.children as typeof tree)]);

  return flat(tree)
    .filter((forum) => readable.has(forum.id))
    .map((forum) => ({ slug: forum.slug, name: forum.name, description: forum.description }));
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

function xml(c: Context<AppEnv>, body: string) {
  return c.body(body, 200, {
    'content-type': 'application/xml; charset=utf-8',
    'cache-control': 'public, max-age=600',
  });
}

function text(c: Context<AppEnv>, body: string, type = 'text/plain') {
  return c.body(body, 200, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'public, max-age=600',
  });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}

export function discoveryRoutes(services: Services) {
  const app = new Hono<AppEnv>();
  const absolute = (path: string) => new URL(path, services.baseUrl).toString();

  // --- robots.txt ---------------------------------------------------------

  /*
   * Paths a crawler has no business in: they are personal, administrative, or
   * the same content under another address. Everything else is open, and the
   * AI crawlers are named so that the welcome is explicit rather than a
   * default nobody chose. One group for all of them: a crawler reads only the
   * group that names it, so separate groups would have to repeat every rule.
   */
  const CLOSED_TO_CRAWLERS = [
    '/admin',
    '/moderation',
    '/auth/',
    '/login',
    '/signup',
    '/logout',
    '/link',
    '/prefs/',
    '/notifications',
    '/settings',
    '/messages',
    '/search',
    '/read',
    '/api/',
  ];
  const AI_CRAWLERS = [
    'GPTBot',
    'OAI-SearchBot',
    'ChatGPT-User',
    'ClaudeBot',
    'Claude-SearchBot',
    'Claude-User',
    'anthropic-ai',
    'PerplexityBot',
    'Perplexity-User',
    'Google-Extended',
    'Applebot-Extended',
    'CCBot',
    'Bytespider',
    'meta-externalagent',
  ];

  app.get('/robots.txt', (c) => {
    const settings = c.get('settings');
    const name = String(settings['board.name'] ?? 'tsbb');
    const lines = [
      `# ${name}`,
      '# Public pages may be crawled and quoted. The paths below are personal,',
      '# administrative, or the same content under a different address.',
      '',
      'User-agent: *',
      ...AI_CRAWLERS.map((agent) => `User-agent: ${agent}`),
      ...CLOSED_TO_CRAWLERS.map((path) => `Disallow: ${path}`),
      'Allow: /',
      '',
      `Sitemap: ${absolute('/sitemap.xml')}`,
      '',
      '# A summary written for language models, and the same in full:',
      `# ${absolute('/llms.txt')}`,
      `# ${absolute('/llms-full.txt')}`,
      '',
    ];
    return text(c, lines.join('\n'));
  });

  // --- Sitemap --------------------------------------------------------------
  //
  // An index, with the fixed pages and forums in one file and topics in one
  // file per month they were started. A month that has passed only changes
  // when somebody replies in it, so a crawler that compares <lastmod> skips
  // almost every file on almost every visit — which is the point of splitting
  // by date rather than by count, where adding one topic shifts every file.

  app.get('/sitemap.xml', async (c) => {
    const forumIds = await visibleForumIds(await guestViewer());
    const months = forumIds.length
      ? await all<{ month: string; modified: number }>(
          `SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month,
                  MAX(COALESCE(last_post_at, created_at)) AS modified
             FROM topics
            WHERE is_deleted = 0 AND is_hidden = 0
              AND forum_id IN (${forumIds.map(() => '?').join(',')})
            GROUP BY month
            ORDER BY month`,
          forumIds,
        )
      : [];

    const entries = [
      `  <sitemap><loc>${escapeHtml(absolute('/sitemaps/pages.xml'))}</loc></sitemap>`,
      ...months.map(
        (m) =>
          `  <sitemap><loc>${escapeHtml(absolute(`/sitemaps/topics-${m.month}.xml`))}</loc>` +
          `<lastmod>${isoDate(Number(m.modified))}</lastmod></sitemap>`,
      ),
    ];

    return xml(
      c,
      `${XML_HEAD}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>\n`,
    );
  });

  app.get('/sitemaps/pages.xml', async (c) => {
    const forums = await publicForums();
    const url = (path: string, priority: string, changefreq: string) =>
      `  <url><loc>${escapeHtml(absolute(path))}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;

    const entries = [
      url('/', '1.0', 'hourly'),
      url('/latest', '0.8', 'hourly'),
      url('/about', '0.6', 'monthly'),
      url('/members', '0.4', 'daily'),
      url('/feeds', '0.3', 'monthly'),
      url('/docs', '0.6', 'monthly'),
      ...DOCS.map((doc) => url(`/docs/${doc.slug}`, '0.6', 'monthly')),
      ...forums.map((forum) => url(`/f/${forum.slug}`, '0.7', 'daily')),
    ];

    return xml(
      c,
      `${XML_HEAD}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`,
    );
  });

  // The month is parsed out of the filename: a route parameter with a literal
  // on either side of it inside one segment does not match, silently.
  app.get('/sitemaps/:file', async (c) => {
    const month = /^topics-(\d{4}-\d{2})\.xml$/.exec(c.req.param('file') ?? '')?.[1];
    if (!month) return c.notFound();

    const forumIds = await visibleForumIds(await guestViewer());
    if (!forumIds.length) return c.notFound();

    // Ordered by (created_at, id): rows imported in one batch share a
    // timestamp, and an order that ties is not an order.
    const topics = await all<{ id: number; slug: string; modified: number }>(
      `SELECT id, slug, COALESCE(last_post_at, created_at) AS modified
         FROM topics
        WHERE is_deleted = 0 AND is_hidden = 0
          AND forum_id IN (${forumIds.map(() => '?').join(',')})
          AND strftime('%Y-%m', created_at / 1000, 'unixepoch') = ?
        ORDER BY created_at, id
        LIMIT 50000`,
      [...forumIds, month],
    );
    if (!topics.length) return c.notFound();

    const entries = topics.map(
      (topic) =>
        `  <url><loc>${escapeHtml(absolute(`/t/${topic.slug}-${topic.id}`))}</loc>` +
        `<lastmod>${isoDate(Number(topic.modified))}</lastmod></url>`,
    );

    return xml(
      c,
      `${XML_HEAD}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`,
    );
  });

  // --- llms.txt -------------------------------------------------------------

  app.get('/llms.txt', async (c) => {
    const settings = c.get('settings');
    const name = String(settings['board.name'] ?? 'tsbb');
    const tagline = String(settings['board.tagline'] ?? '');
    const description = String(settings['board.description'] ?? '').trim();
    const forums = await publicForums();
    const contact = contactAddress(settings);

    const link = (label: string, path: string, note: string) =>
      `- [${label}](${absolute(path)}): ${note}`;

    const lines = [
      `# ${name}`,
      '',
      `> ${tagline || 'A community board running on tsbb.'}`,
      '',
      ...(description ? [description, ''] : []),
      `${name} is a bulletin board: a tree of forums, each holding topics, each topic a thread of posts. ` +
        'Every public page is complete server-rendered HTML with no client-side script, and every list ' +
        'on the board is also an RSS feed. The same content is reachable through a REST API, a command ' +
        'line client and an MCP server, all of which apply the permissions the pages do.',
      '',
      '## Read the board',
      '',
      link('Forums', '/', 'Every forum a visitor can read, with the latest post in each.'),
      link('Latest', '/latest', 'Recent topics across the whole board, newest activity first.'),
      link('About', '/about', 'What this board is, how to join, and who runs it.'),
      link('Feeds', '/feeds', 'Every RSS feed on the board, and an OPML file of all of them.'),
      link('All topics as RSS', '/feed.xml', 'The board-wide feed.'),
      '',
      '## Forums',
      '',
      ...forums.map((forum) =>
        link(forum.name, `/f/${forum.slug}`, forum.description?.trim() || 'A forum on this board.'),
      ),
      '',
      '## Use the board from a program',
      '',
      link('Documentation', '/docs', 'The index of every guide below.'),
      ...DOCS.map((doc) => link(doc.blurb.split(':')[0]?.replace(/`/g, '') ?? doc.slug, `/docs/${doc.slug}`, doc.blurb.replace(/`/g, ''))),
      link('OpenAPI description', '/api/v1/openapi.json', 'The REST API, machine-readable.'),
      link('MCP endpoint', '/api/mcp', 'Streamable HTTP MCP server; a bearer token makes it act as a member.'),
      link('Agent skill', '/skill.md', 'What an agent can do here and how to authenticate.'),
      '',
      '## Optional',
      '',
      link('Full text', '/llms-full.txt', 'Every guide above, concatenated as markdown.'),
      link('Sitemap', '/sitemap.xml', 'Every public page and topic.'),
      ...(contact ? [`- Contact: ${contact}`] : []),
      '- [Source code](https://github.com/profullstack/tsbb): tsbb, the software this board runs, MIT licensed.',
      '',
    ];
    return text(c, lines.join('\n'), 'text/markdown');
  });

  app.get('/llms-full.txt', async (c) => {
    const settings = c.get('settings');
    const name = String(settings['board.name'] ?? 'tsbb');
    const sections = DOCS.map((doc) => docMarkdown(doc))
      .filter((source): source is string => source !== null)
      .map((source) => source.replace(/\r\n?/g, '\n').trim());

    const body = [`# ${name} — full documentation`, '', ...sections.flatMap((s) => [s, '', '---', ''])];
    return text(c, `${body.join('\n').replace(/\n---\n$/, '\n')}`, 'text/markdown');
  });

  // --- security.txt (RFC 9116) ----------------------------------------------

  app.get('/.well-known/security.txt', (c) => {
    const contact = contactAddress(c.get('settings'));
    if (!contact) return c.notFound();

    // A year out, to the day, recomputed on every request: the file is
    // generated, so it cannot go stale the way a hand-written one does.
    const expires = new Date();
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);

    const lines = [
      `Contact: mailto:${contact}`,
      // The software's own advisory inbox, for a problem in tsbb rather than in
      // this board's configuration.
      'Contact: https://github.com/profullstack/tsbb/security/advisories/new',
      `Expires: ${expires.toISOString()}`,
      'Preferred-Languages: en',
      `Canonical: ${absolute('/.well-known/security.txt')}`,
      '',
    ];
    return text(c, lines.join('\n'));
  });

  // --- skill.md ---------------------------------------------------------------

  app.get('/skill.md', (c) => {
    const settings = c.get('settings');
    const name = String(settings['board.name'] ?? 'tsbb');
    const lines = [
      '---',
      `name: ${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tsbb'}`,
      `description: Read and post on ${name}, a tsbb bulletin board, through its MCP server or REST API.`,
      '---',
      '',
      `# ${name}`,
      '',
      `${name} is a forum. Use it to read topics, search posts, and — as a signed-in member — start topics and reply.`,
      '',
      '## Connect',
      '',
      `- MCP over streamable HTTP: \`${absolute('/api/mcp')}\``,
      `- REST: \`${absolute('/api/v1')}\`, described at \`${absolute('/api/v1/openapi.json')}\``,
      '- Auth: `Authorization: Bearer <token>`. Reading public forums needs no token; posting does.',
      `- A member mints a token at \`${absolute('/settings')}\`, or through device-code sign-in with the \`tsbb\` CLI.`,
      '',
      'Cookies are deliberately ignored by the MCP endpoint; only a bearer token identifies a caller there.',
      'A token is never an administrator, whatever account minted it.',
      '',
      '## Read without any client',
      '',
      `- Board summary: \`${absolute('/llms.txt')}\``,
      `- Every guide as one markdown file: \`${absolute('/llms-full.txt')}\``,
      `- RSS for the board, a forum, a thread, a member or a search: \`${absolute('/feeds')}\``,
      '',
      '## Guides',
      '',
      ...DOCS.map((doc) => `- ${absolute(`/docs/${doc.slug}`)} — ${doc.blurb.replace(/`/g, '')}`),
      '',
    ];
    return text(c, lines.join('\n'), 'text/markdown');
  });

  // --- About ------------------------------------------------------------------

  app.get('/about', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const name = String(settings['board.name'] ?? 'tsbb');
    const tagline = String(settings['board.tagline'] ?? '');
    const description = String(settings['board.description'] ?? '').trim();
    const mode = String(settings['registration.mode'] ?? 'open');
    const contact = contactAddress(settings);
    const forums = await publicForums();

    const joining =
      mode === 'open'
        ? html`Put in your email address on the <a href="/signup">sign-up page</a> and open the link it sends
            you. There is no password: the link is the sign-in, and a passkey can replace it afterwards.`
        : mode === 'invite'
          ? html`Registration is by invitation. A member can send you one; once you have it, the link it
              contains signs you in.`
          : html`Registration is closed at the moment. Everything a guest can read is still readable.`;

    const body = html`
      <div class="page-head">
        <div>
          <h1 class="page-title">About ${name}</h1>
          ${tagline ? html`<p class="page-subtitle">${tagline}</p>` : ''}
        </div>
      </div>
      ${Card(
        CardContent(html`<div class="post-body about-body">
          <h2>What is ${name}?</h2>
          ${description ? html`<p>${description}</p>` : ''}
          <p>
            ${name} is a bulletin board: a place where people start topics and reply to them, in the open.
            It is organised as a tree of forums, and a topic lives in one of them.
          </p>
          <ul>
            ${forums.map(
              (forum) => html`<li>
                <a href="/f/${forum.slug}">${forum.name}</a>${forum.description ? html` — ${forum.description}` : ''}
              </li>`,
            )}
          </ul>

          <h2>How do I join?</h2>
          <p>${joining}</p>

          <h2>How can I read it without a browser?</h2>
          <p>Every list on the board is also a feed, and the whole board answers to programs:</p>
          <ul>
            <li><a href="/feeds">RSS</a> for the board, any forum, any thread, any member and any search.</li>
            <li>A <a href="/docs/api">REST API</a>, described by an <a href="/api/v1/openapi.json">OpenAPI file</a>.</li>
            <li>The <a href="/docs/cli"><code>tsbb</code> command line client</a>, with <code>--json</code> on every command.</li>
            <li>An <a href="/docs/mcp">MCP server</a>, so an AI assistant can read and post as a member.</li>
          </ul>
          <p>They all apply exactly the permissions the pages do.</p>

          <h2>Who runs it?</h2>
          <p>
            ${name} is run by ${String(settings['board.operator'] ?? '').trim() || 'its administrators'}.
            ${contact ? html` You can reach the people behind it at <a href="mailto:${contact}">${contact}</a>.` : ''}
            The software is <a href="https://github.com/profullstack/tsbb" rel="noopener">tsbb</a>, an
            MIT-licensed TypeScript bulletin board that anyone can host; this board is one install of it.
          </p>
        </div>`),
      )}
      <div class="row about-actions">
        ${!viewer.user && mode !== 'closed' ? LinkButton('Join the board', '/signup', { size: 'sm' }) : ''}
        ${LinkButton('Read the docs', '/docs', { size: 'sm', variant: 'outline' })}
        ${LinkButton('Browse the forums', '/', { size: 'sm', variant: 'ghost' })}
      </div>`;

    return render(c, services, {
      title: 'About',
      description: tagline ? `About ${name}: ${tagline}` : `About ${name}`,
      body,
    });
  });

  return app;
}
