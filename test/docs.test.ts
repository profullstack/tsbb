import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The documentation pages.
 *
 * They are the repository's own `docs/*.md`, rendered by the board — so the
 * thing worth asserting is that the rendering actually happened and that the
 * documents reachable from the site are the documents in the repository. A page
 * that 404s because a file was renamed is the failure this catches.
 */
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-docs-'));
process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = 'http://localhost:3993';
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const db = await import('../packages/db/src/index.ts');

let app: { fetch: (req: Request) => Response | Promise<Response> };

async function page(path: string): Promise<{ status: number; body: string }> {
  const response = await app.fetch(new Request(`http://localhost:3993${path}`));
  return { status: response.status, body: await response.text() };
}

describe('the documentation pages', () => {
  before(async () => {
    await seed({ quiet: true });
    const booted = await boot({ listen: false });
    app = booted.app;
  });

  after(() => {
    db.setDb(null);
  });

  it('lists every document from the index', async () => {
    const { status, body } = await page('/docs');
    assert.equal(status, 200);
    for (const slug of ['api', 'cli', 'mcp', 'plugins']) {
      assert.ok(body.includes(`/docs/${slug}`), `the index should link to /docs/${slug}`);
    }
  });

  it('renders each document as HTML, not as markdown source', async () => {
    for (const slug of ['api', 'cli', 'mcp', 'plugins']) {
      const { status, body } = await page(`/docs/${slug}`);
      assert.equal(status, 200, `/docs/${slug} answered ${status}`);
      assert.ok(body.includes('class="post-body"'), `${slug} should render into a post body`);
      assert.ok(
        !body.includes('\n## '),
        `${slug} still contains raw markdown headings — it was not rendered`,
      );
    }
  });

  it('renders the tables and code blocks the documents rely on', async () => {
    const { body } = await page('/docs/mcp');
    assert.ok(body.includes('md-table'), 'the tool table should be a table');
    assert.ok(body.includes('<pre'), 'the client configuration should be a code block');
    assert.ok(body.includes('board_overview'), 'the tools should be listed');
  });

  /*
   * The documents are hard-wrapped at eighty columns so they read and diff well
   * in an editor. The board's markdown renderer turns a single newline into a
   * <br>, which is right for a post and wrong here — rendering the wraps
   * literally gives a ragged column half the width of the page.
   */
  it('joins the lines of a hard-wrapped paragraph', async () => {
    const { body } = await page('/docs/mcp');
    // "…search it," and "and — with a token…" are two lines in the file.
    assert.ok(body.includes('search it, and'), 'the paragraph should be one flowing line');
    assert.ok(!body.includes('search it,<br />'), 'no source wrap should survive as a break');
  });

  it('leaves code blocks exactly as they were written', async () => {
    const { body } = await page('/docs/cli');
    const blocks = [...body.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code>/g)].map(
      (match) => match[1] ?? '',
    );
    const reading = blocks.find((block) => block.includes('tsbb boards'));
    assert.ok(reading, 'the sign-in examples should be a fenced block');
    assert.ok(
      reading.split('\n').length > 3,
      'the lines of a code block must not be joined into a paragraph',
    );
    assert.ok(!reading.includes('<br'), 'a code block needs no breaks inserted');
  });

  it('rewrites links between documents to site paths', async () => {
    const { body } = await page('/docs/cli');
    assert.ok(body.includes('href="/docs/mcp"'), 'a link to MCP.md should point at /docs/mcp');
    assert.ok(!body.includes('href="MCP.md"'), 'no repository-relative link should survive');
  });

  it('links to the source of the page it just rendered', async () => {
    const { body } = await page('/docs/api');
    assert.ok(body.includes('blob/main/docs/API.md'));
  });

  it('is reachable from every page, and 404s an invented one', async () => {
    const { body } = await page('/');
    assert.ok(body.includes('href="/docs"'), 'the footer should link to the docs');

    const missing = await page('/docs/not-a-document');
    assert.equal(missing.status, 404);
  });

  /*
   * These pages passed every test above and still 404'd in production, because
   * .dockerignore excluded docs/ and the deployed image had no files to render.
   * Nothing that boots the app in a checkout can catch that — the guard has to
   * be on the thing that was wrong, which is the build configuration.
   */
  it('ships the documents in the image', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');

    const ignored = readFileSync(join(root, '.dockerignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    for (const pattern of ['docs', 'docs/', '/docs', './docs']) {
      assert.ok(
        !ignored.includes(pattern),
        `.dockerignore excludes ${pattern}, so the built image would serve no documentation`,
      );
    }
  });

  it('points at the docs from the API index, for a human who found the JSON', async () => {
    const response = await app.fetch(new Request('http://localhost:3993/api/v1'));
    const index = (await response.json()) as { docs: string };
    assert.equal(index.docs, 'http://localhost:3993/docs');
  });
});
