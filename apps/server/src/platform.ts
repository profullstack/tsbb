/**
 * What tsbb is, said once.
 *
 * The front page, the About page, the docs index and llms.txt all describe the
 * platform, and four hand-written copies of the same list drift apart within a
 * release: one gains a feature, another keeps a claim that stopped being true.
 * So the list lives here and every page renders it.
 *
 * Every entry marked `live` is backed by code in this repository today. An
 * entry marked `planned` is on the roadmap and is rendered as such, never as
 * a feature. Move it to `live` in the pull request that makes it true, not
 * before.
 */
import { html } from 'hono/html';
import { Badge } from '@tsbb/ui';

export type FrontDoorStatus = 'live' | 'planned';

export interface FrontDoor {
  /** A stable key, used for a class name and a JSON-LD feature id. */
  key: string;
  title: string;
  /** One or two sentences. Plain text: it is rendered escaped everywhere. */
  summary: string;
  /** Where to read more. Absent for a planned entry: there is nothing to read yet. */
  href?: string;
  status: FrontDoorStatus;
}

export const PLATFORM_NAME = 'tsbb';
export const PLATFORM_TAGLINE = 'A TypeScript bulletin board';

/** The one-line positioning, used as a heading wherever the grid appears. */
export const PLATFORM_CLAIM = 'The new bulletin board platform';

/**
 * The paragraph under that heading. Everything in it is true of the code; the
 * only forward-looking clause is the last one, and it says so.
 */
export const PLATFORM_LEAD =
  'Agent-ok, human-ok, plugin-ok. A self-hostable TypeScript bulletin board platform with a REST API, ' +
  'CLI, MCP server, installable PWA and terminal client. Extend it with runtime plugins, publish and ' +
  'import feeds, and let your board update itself. A distributed, peer-to-peer network of boards ' +
  'that connect and sync topics between nodes is on the roadmap.';

export const FRONT_DOORS: readonly FrontDoor[] = [
  {
    key: 'api',
    title: 'REST API',
    summary:
      'Everything the pages show, at /api/v1, resolved through the same permission checks, and described by an OpenAPI file.',
    href: '/docs/api',
    status: 'live',
  },
  {
    key: 'cli',
    title: 'CLI',
    summary:
      'The tsbb command runs a board, and reads and posts against any board from a shell, with --json on every command.',
    href: '/docs/cli',
    status: 'live',
  },
  {
    key: 'mcp',
    title: 'MCP server',
    summary:
      'Served at /api/mcp over streamable HTTP, and as tsbb-mcp over stdio. An assistant reads, searches and posts as a member.',
    href: '/docs/mcp',
    status: 'live',
  },
  {
    key: 'agents',
    title: 'Agent-ok, human-ok',
    summary:
      'A browser, a script and a model all get the same content under the same permissions. llms.txt, skill.md and an explicit welcome in robots.txt.',
    href: '/docs/agents',
    status: 'live',
  },
  {
    key: 'pwa',
    title: 'Installable PWA',
    summary:
      'A manifest, a service worker and an offline page. Installs on a phone or a desktop and keeps what you have read when the connection goes.',
    href: '/docs/pwa',
    status: 'live',
  },
  {
    key: 'plugins',
    title: 'Plugin-ok, no build step',
    summary:
      'A plugin is a directory. Filters, actions, slots, settings and routes, loaded at boot. Drop it in and restart.',
    href: '/docs/plugins',
    status: 'live',
  },
  {
    key: 'updates',
    title: 'Self-updating',
    summary:
      'A board checks GitHub releases a minute after boot and every five minutes, installs the new one and restarts itself.',
    href: '/docs/updates',
    status: 'live',
  },
  {
    key: 'skins',
    title: 'Terminal skin, terminal client',
    summary:
      'Three skins over one set of markup, one of them a terminal look. And tsbb-tui, for reading and posting over SSH.',
    href: '/docs/skins',
    status: 'live',
  },
  {
    key: 'feeds',
    title: 'Feeds both ways',
    summary:
      'RSS for the board, every forum, thread, member and search. And a forum can be filled from any RSS or Atom feed.',
    href: '/feeds',
    status: 'live',
  },
  {
    key: 'p2p',
    title: 'Peer to peer / distributed',
    summary:
      'Run your own node and connect it to other boards to sync topics across a distributed network. Planned; node-to-node connections and topic syncing are not available yet.',
    status: 'planned',
  },
];

export const LIVE_FRONT_DOORS: readonly FrontDoor[] = FRONT_DOORS.filter((door) => door.status === 'live');

/** A short introduction beside the board name, with direct links to the guides. */
export function PlatformIntro() {
  return html`<div class="hero-platform">
    <p class="hero-description">
      The new bulletin board platform:
      <a href="/docs/agents">agent-ok, human-ok</a> and <a href="/docs/plugins">plugin-ok</a>.
      Make yourself at home in the browser, install the <a href="/docs/pwa">PWA</a>, or connect
      through the <a href="/docs/api">REST API</a>, <a href="/docs/cli">CLI</a>,
      <a href="/docs/mcp">MCP</a> or <a href="/docs/skins">terminal client</a>.
    </p>
    <p class="hero-description">
      Self-host your board today. On the roadmap:
      <a href="/docs/network">a distributed, peer-to-peer network</a> of boards that connect
      and sync topics between nodes.
    </p>
  </div>`;
}

/**
 * The grid, as markup.
 *
 * Rendered on the front page, the About page and the docs index. A planned
 * entry renders with a "planned" badge and no link, which is the whole reason
 * status is data rather than prose: a page cannot accidentally present it as
 * something that works today.
 */
export function PlatformGrid(doors: readonly FrontDoor[] = FRONT_DOORS) {
  return html`<div class="platform-grid">
    ${doors.map(
      (door) => html`<div class="platform-item platform-${door.key}">
        <div class="platform-item-head">
          ${door.href
            ? html`<a class="platform-item-title" href="${door.href}">${door.title}</a>`
            : html`<span class="platform-item-title">${door.title}</span>`}
          ${door.status === 'planned' ? Badge('Planned', 'outline') : ''}
        </div>
        <p class="platform-item-summary">${door.summary}</p>
      </div>`,
    )}
  </div>`;
}
