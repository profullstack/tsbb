import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * The tsbb network page. Live numbers are switched off so the test never
 * touches the network; the filter that hides empty boards is tested directly.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-boards-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3996';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';
process.env.TSBB_NETWORK_STATS = 'off';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const { visibleBoards } = await import('../apps/server/src/routes/boards.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };
const get = (path: string) => app.fetch(new Request(`http://localhost:3996${path}`, { redirect: 'manual' }));

describe('the tsbb network', () => {
  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
  });

  it('lists the boards, with a way to add one', async () => {
    const response = await get('/boards');
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /The tsbb network/);
    assert.match(page, /href="https:\/\/tsbb\.dev"/);
    assert.match(page, /Add your board/);
  });

  it('answers the other names for the page with a redirect', async () => {
    for (const path of ['/partners', '/instances', '/network']) {
      const response = await get(path);
      assert.equal(response.status, 301, path);
      assert.equal(response.headers.get('location'), '/boards');
    }
  });

  it('serves the list as JSON', async () => {
    const body = (await (await get('/api/v1/boards')).json()) as { boards: { url: string }[] };
    assert.ok(body.boards.some((board) => board.url === 'https://tsbb.dev'));
  });

  it('links the page from the footer and the sitemap', async () => {
    assert.match(await (await get('/')).text(), /href="\/boards"/);
    assert.match(await (await get('/sitemaps/pages.xml')).text(), /\/boards</);
  });

  it('hides a board with no topics but keeps one that did not answer', () => {
    const boards = [
      { url: 'https://a', name: 'a', about: '' },
      { url: 'https://b', name: 'b', about: '' },
      { url: 'https://c', name: 'c', about: '' },
    ];
    const stats = new Map([
      ['https://a', { members: 1, topics: 0, posts: 0, latestPostAt: null }],
      ['https://b', { members: 4, topics: 9, posts: 30, latestPostAt: 1 }],
      ['https://c', null],
    ]);
    assert.deepEqual(
      visibleBoards(boards, stats).map((row) => row.board.name),
      ['b', 'c'],
    );
  });
});
