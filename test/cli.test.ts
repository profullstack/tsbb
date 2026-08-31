import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

/**
 * The CLI's remote half, and the stdio MCP server, against a board that is
 * genuinely listening.
 *
 * Everything else in this suite dispatches into the Hono app in-process, which
 * is right for testing routes. These two are the parts a person invokes from a
 * shell, over a socket, with a config file on disk — so the failures worth
 * catching (a token that is not found where it was saved, a binary that writes
 * something other than protocol to stdout) only appear when it is done for
 * real.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'tsbb-cli-'));
const PORT = 3994;
const SERVER = `http://localhost:${PORT}`;

process.env.TSBB_DATABASE_URL = `file:${join(scratch, 'board.db')}`;
process.env.TSBB_BASE_URL = SERVER;
process.env.TSBB_SESSION_SECRET = 'test-secret';
process.env.TSBB_MAIL_TRANSPORT = 'console';
process.env.TSBB_CONFIG_DIR = join(scratch, 'config');
// The mail worker has nothing to do here and would keep the process alive.
process.env.TSBB_WORKER = 'external';

const { seed } = await import('../packages/db/src/seed.ts');
const { boot } = await import('../apps/server/src/index.ts');
const core = await import('../packages/core/src/index.ts');
const db = await import('../packages/db/src/index.ts');
const client = await import('../packages/client/src/index.ts');
const remote = await import('../apps/cli/src/remote.ts');

let server: { close: (cb?: () => void) => void } | undefined;
let token = '';

/** Run a command with console.log captured, so the output can be asserted on. */
async function output(run: () => unknown): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('the CLI against a live board', () => {
  before(async () => {
    await seed({ quiet: true });
    await core.setSettings({ 'posts.floodSeconds': 0 });
    const booted = await boot({ port: PORT });
    server = booted.server as never;

    const user = await core.createUser({ email: 'cli@example.com', username: 'cliuser' });
    token = await core.mintToken({ userId: user.id, label: 'cli test' });
    client.rememberBoard({ server: SERVER, token, username: 'cliuser' });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    db.setDb(null);
  });

  it('knows which board it is signed in to', async () => {
    const text = await output(() => remote.whoamiCommand({}));
    assert.match(text, /cliuser/);
    assert.match(text, new RegExp(SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('lists the boards it has tokens for, marking the current one', async () => {
    const text = await output(() => remote.boardsCommand({}));
    assert.match(text, /\* http:\/\/localhost:3994 as cliuser/);
  });

  it('lists forums, and prints JSON when asked', async () => {
    const human = await output(() => remote.forumsCommand({}));
    assert.match(human, /general/);

    const json = await output(() => remote.forumsCommand({ json: true }));
    const parsed = JSON.parse(json) as { forums: { slug: string }[] };
    assert.ok(parsed.forums.some((forum) => forum.slug === 'general'));
  });

  it('posts a topic, reads it back, and finds it by search', async () => {
    const posted = await output(() =>
      remote.postCommand(['general', 'Posted from the CLI', 'A body typed at a shell.'], {
        json: true,
      }),
    );
    const created = JSON.parse(posted) as { id: number; url: string };
    assert.ok(created.id > 0);
    assert.match(created.url, /^http:\/\/localhost:3994\/t\//);

    const read = await output(() => remote.readCommand(String(created.id), {}));
    assert.match(read, /Posted from the CLI/);
    assert.match(read, /A body typed at a shell/);

    const found = await output(() => remote.searchCommand(['shell'], { json: true }));
    const hits = JSON.parse(found) as { hits: { topicId: number }[] };
    assert.ok(
      hits.hits.some((hit) => hit.topicId === created.id),
      'the new topic should be findable',
    );

    const replied = await output(() =>
      remote.replyCommand([String(created.id), 'And a reply.'], { json: true }),
    );
    assert.ok((JSON.parse(replied) as { id: number }).id > 0);
  });

  it('reports a bad forum slug in one line, and exits non-zero', async () => {
    const before = process.exitCode;
    let message = '';
    const original = console.error;
    console.error = (...args: unknown[]) => {
      message = args.map(String).join(' ');
    };
    try {
      await remote.topicsCommand('no-such-forum', {}).catch(remote.reportRemoteError);
    } finally {
      console.error = original;
    }
    assert.ok(message.length > 0 && !message.includes('\n    at '), 'no stack trace');
    assert.equal(process.exitCode, 1);
    process.exitCode = before;
  });

  describe('tsbb-mcp over stdio', () => {
    /**
     * Drive the real binary: write JSON-RPC lines to its stdin, read them back
     * from stdout. Anything the binary prints to stdout that is not a message
     * would fail here, which is the point — a stray log line there is a parse
     * error in a real client.
     */
    async function exchange(messages: unknown[]): Promise<Record<string, never>[]> {
      const bin = join(HERE, '../apps/mcp/bin/tsbb-mcp.mjs');
      const child = spawn(process.execPath, [bin, '--server', SERVER, '--token', token], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TSBB_CONFIG_DIR: join(scratch, 'config') },
      });

      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        err += chunk;
      });

      for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.end();

      const code = await new Promise<number>((resolve) => child.on('close', resolve));
      assert.equal(code, 0, `tsbb-mcp exited ${code}: ${err}`);

      return out
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, never>);
    }

    it('handshakes, lists tools and reads the board', async () => {
      const replies = await exchange([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'board_overview', arguments: {} } },
      ]);

      // Three replies, not four: the notification is answered with silence.
      assert.equal(replies.length, 3, `expected 3 replies, got ${replies.length}`);
      assert.deepEqual(
        replies.map((reply) => (reply as never as { id: number }).id),
        [1, 2, 3],
        'replies come back in order, each answering its own id',
      );

      const init = replies[0] as never as { result: { serverInfo: { name: string } } };
      assert.equal(init.result.serverInfo.name, 'tsbb');

      const tools = (replies[1] as never as { result: { tools: { name: string }[] } }).result.tools;
      assert.ok(tools.some((tool) => tool.name === 'board_overview'));
      assert.ok(
        tools.some((tool) => tool.name === 'reply_to_topic'),
        'a token was passed, so the write tools are offered',
      );

      const overview = (replies[2] as never as { result: { content: { text: string }[] } }).result;
      assert.match(overview.content[0]?.text ?? '', /general/);
    });

    it('serves reading tools only when told to stay read-only', async () => {
      const bin = join(HERE, '../apps/mcp/bin/tsbb-mcp.mjs');
      const child = spawn(
        process.execPath,
        [bin, '--server', SERVER, '--token', token, '--read-only'],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } },
      );
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
      child.stdin.end();
      await new Promise((resolve) => child.on('close', resolve));

      const tools = (JSON.parse(out.trim()) as { result: { tools: { name: string }[] } }).result.tools;
      assert.ok(tools.some((tool) => tool.name === 'search_posts'));
      assert.ok(!tools.some((tool) => tool.name === 'reply_to_topic'));
    });
  });
});
