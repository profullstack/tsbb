import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * What the board says it can do.
 *
 * Marketing copy is the one part of a codebase nothing else fails when it goes
 * out of date, which is exactly why it goes out of date. So the claims are data
 * in `apps/server/src/platform.ts` and these tests hold them to two rules:
 *
 *  1. Every claim that links somewhere links somewhere that answers 200.
 *  2. A claim that is not built yet is rendered as planned, with no link, in
 *     every place the grid appears.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-platform-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3991';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const { FRONT_DOORS, PLATFORM_CLAIM } = await import('../apps/server/src/platform.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };

async function page(path: string): Promise<{ status: number; body: string }> {
  const response = await app.fetch(new Request(`http://localhost:3991${path}`));
  return { status: response.status, body: await response.text() };
}

describe('what the board claims it can do', () => {
  before(async () => {
    await seed({ quiet: true });
    app = (await boot({ listen: false })).app;
  });
  after(() => db.setDb(null));

  it('tells a visitor what the software under the board is', async () => {
    const { body } = await page('/');
    assert.ok(body.includes(PLATFORM_CLAIM), 'the front page carries the positioning');
    assert.ok(body.includes('class="platform-grid"'));
    for (const door of FRONT_DOORS) {
      assert.ok(body.includes(door.title), `the grid lists ${door.title}`);
    }
  });

  it('links every live claim at something that answers', async () => {
    for (const door of FRONT_DOORS) {
      if (door.status !== 'live' || !door.href?.startsWith('/')) continue;
      const { status } = await page(door.href);
      assert.equal(status, 200, `${door.title} links at ${door.href}, which answered ${status}`);
    }
  });

  it('renders a planned capability as planned, and never as a link', async () => {
    const planned = FRONT_DOORS.filter((door) => door.status === 'planned');
    assert.ok(planned.length > 0, 'this test is about the planned ones; p2p is one');

    for (const door of planned) {
      assert.equal(door.href, undefined, `${door.title} is not built, so it has nowhere to link`);
    }

    for (const path of ['/', '/about', '/docs']) {
      const { body } = await page(path);
      for (const door of planned) {
        // The title appears, immediately followed by the badge rather than by
        // a description of something that works.
        const at = body.indexOf(door.title);
        assert.ok(at >= 0, `${path} lists ${door.title}`);
        assert.match(
          body.slice(at, at + 400),
          /Planned/,
          `${path} presents ${door.title} as planned`,
        );
      }
    }
  });

  it('says the same thing to a language model as to a reader', async () => {
    const llms = await page('/llms.txt');
    assert.equal(llms.status, 200);
    for (const door of FRONT_DOORS) {
      assert.ok(llms.body.includes(door.title), `llms.txt lists ${door.title}`);
    }
    assert.match(llms.body, /planned, not built yet/, 'and marks the unbuilt one as unbuilt');
  });

  it('lets an operator turn the panel off', async () => {
    const { setSetting } = await import('../packages/core/src/settings.ts');
    await setSetting('board.showPlatform', false);
    const off = await page('/');
    assert.ok(!off.body.includes('class="platform-grid"'), 'an operator can turn it off');
    await setSetting('board.showPlatform', true);
    assert.ok((await page('/')).body.includes('class="platform-grid"'));
  });

  it('keeps the CSP intact: no inline style attribute anywhere it renders', async () => {
    // style="…" is refused by the board's own policy, so an attribute here
    // renders unstyled and nobody notices until a screenshot looks wrong.
    for (const path of ['/', '/about', '/docs']) {
      const { body } = await page(path);
      const grid = body.slice(body.indexOf('platform-grid'));
      assert.ok(!/ style="/.test(grid), `${path} styles the grid with classes only`);
    }
  });
});
