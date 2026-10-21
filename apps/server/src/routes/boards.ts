import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { Card, CardContent, TimeAgo } from '@tsbb/ui';
import { render, type AppEnv, type Services } from '../context.ts';

/**
 * The tsbb network: every board that runs tsbb, listed on every board.
 *
 * The list is a file in the repository, not a setting, so a self-hoster joins
 * it with a pull request and every board picks the change up with its next
 * update. Each entry's numbers come from that board's own /api/v1/stats,
 * fetched server side (the board's CSP allows no cross-origin request from the
 * page) and cached, so a slow or dead board costs one timeout every ten
 * minutes and never a page view.
 *
 * A board that answers with zero topics is left off the page: an empty room
 * is a worse advertisement than no room. A board that does not answer at all
 * stays listed, because one failed fetch says nothing about the board.
 */

export interface BoardEntry {
  url: string;
  name: string;
  about: string;
}

export interface BoardStats {
  members: number;
  topics: number;
  posts: number;
  latestPostAt: number | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = JSON.parse(readFileSync(join(HERE, '../boards.json'), 'utf8')) as {
  about: string;
  boards: BoardEntry[];
};

const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

let cache: { at: number; stats: Map<string, BoardStats | null> } | null = null;
let inflight: Promise<Map<string, BoardStats | null>> | null = null;

async function fetchStats(board: BoardEntry): Promise<BoardStats | null> {
  try {
    const response = await fetch(`${board.url.replace(/\/+$/, '')}/api/v1/stats`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'tsbb-network/1 (+https://tsbb.dev/boards)' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<BoardStats>;
    return {
      members: Number(body.members ?? 0),
      topics: Number(body.topics ?? 0),
      posts: Number(body.posts ?? 0),
      latestPostAt: typeof body.latestPostAt === 'number' ? body.latestPostAt : null,
    };
  } catch {
    return null;
  }
}

async function networkStats(): Promise<Map<string, BoardStats | null>> {
  if (process.env.TSBB_NETWORK_STATS === 'off') return new Map();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.stats;
  // A stale answer now beats a fresh one in four seconds; refresh behind it.
  inflight ??= Promise.all(REGISTRY.boards.map(async (board) => [board.url, await fetchStats(board)] as const))
    .then((pairs) => {
      cache = { at: Date.now(), stats: new Map(pairs) };
      return cache.stats;
    })
    .finally(() => {
      inflight = null;
    });
  return cache ? cache.stats : inflight;
}

/** The boards worth showing, busiest first; unknown numbers sort last but stay. */
export function visibleBoards(
  boards: BoardEntry[],
  stats: Map<string, BoardStats | null>,
): { board: BoardEntry; stats: BoardStats | null }[] {
  return boards
    .map((board) => ({ board, stats: stats.get(board.url) ?? null }))
    .filter((row) => row.stats === null || row.stats.topics > 0)
    .sort((a, b) => (b.stats?.posts ?? -1) - (a.stats?.posts ?? -1));
}

export function boardsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // The words people reach for when they look for this page.
  for (const alias of ['/partners', '/instances', '/network']) {
    app.get(alias, (c) => c.redirect('/boards', 301));
  }

  app.get('/api/v1/boards', async (c) => {
    const rows = visibleBoards(REGISTRY.boards, await networkStats());
    return c.json({
      boards: rows.map(({ board, stats }) => ({ ...board, ...(stats ?? {}) })),
      join: 'https://github.com/profullstack/tsbb/edit/main/apps/server/src/boards.json',
    });
  });

  app.get('/boards', async (c) => {
    const here = services.baseUrl.replace(/\/+$/, '');
    const rows = visibleBoards(REGISTRY.boards, await networkStats());

    const body = html`
      <div class="page-head">
        <div>
          <h1 class="page-title">The tsbb network</h1>
          <p class="page-subtitle">${rows.length} boards running tsbb. Pick one and say hello.</p>
        </div>
      </div>
      ${Card(
        CardContent(
          html`<div class="table-wrap">
            <table class="table">
              <thead><tr><th>Board</th><th>Topics</th><th>Posts</th><th>Last post</th></tr></thead>
              <tbody>
                ${rows.map(
                  ({ board, stats }) => html`<tr>
                    <td>
                      <a href="${board.url}" rel="noopener">${board.name}</a>${board.url === here ? ' (you are here)' : ''}
                      <div class="small muted">${board.about}</div>
                    </td>
                    <td>${stats ? stats.topics : ''}</td>
                    <td>${stats ? stats.posts : ''}</td>
                    <td>${stats ? TimeAgo(stats.latestPostAt) : ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
          { flush: true },
        ),
      )}
      ${Card(
        CardContent(html`<h2>Add your board</h2>
          <p>
            tsbb is free and MIT licensed, and a board is one Node process and a SQLite file:
            <a href="https://github.com/profullstack/tsbb#readme">set one up</a>, then open a pull request
            adding it to
            <a href="https://github.com/profullstack/tsbb/edit/main/apps/server/src/boards.json">boards.json</a>.
            Once merged it is listed here and on every other tsbb board.
          </p>
          <p class="small muted">Boards with no topics yet are left off until their first post. The list is also at
            <a href="/api/v1/boards">/api/v1/boards</a>.</p>`),
      )}`;

    return render(c, services, {
      title: 'The tsbb network',
      description: 'Every bulletin board running tsbb, with live topic and post counts. Join one, or add your own.',
      body,
    });
  });

  return app;
}
