#!/usr/bin/env node
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const USAGE = `tsbb — a TypeScript bulletin board

Running a board (these read the database beside you):
  tsbb init                    Create .env, migrate and seed a new board
  tsbb serve [--port N]        Run the board (migrates at boot)
  tsbb worker                  Run the mail worker on its own
  tsbb migrate                 Apply pending migrations and stop
  tsbb status                  What this board is and how big it is

  tsbb admin <email>           Make somebody an administrator
  tsbb unadmin <email>         Take it away (never from the last one)
  tsbb invite <email>          Email somebody a sign-in link

  tsbb plugin ls               List every plugin the board knows about
  tsbb plugin enable <slug>    Turn one on
  tsbb plugin disable <slug>   Turn one off

Using a board (these talk to one over its API, yours or anybody's):
  tsbb login [server]          Sign in by approving a code in a browser
  tsbb logout [server]         Forget the token for a board
  tsbb boards                  Every board you are signed in to
  tsbb use <server>            Make one of them the default
  tsbb whoami                  Who you are on the current board

  tsbb forums                  The forums you can read
  tsbb latest                  Recently active topics
  tsbb topics <forum>          Topics in one forum
  tsbb read <topic-id>         A topic, as text
  tsbb search <words…>         Full-text search
  tsbb inbox                   Your notifications

  tsbb post <forum> "<title>" [body]   Start a topic (body may be piped in)
  tsbb reply <topic-id> [body]         Reply to one (body may be piped in)

  tsbb mcp [--read-only]       Serve this board to an AI assistant over MCP

Flags for the commands above:
  --server <url>   Talk to that board instead of the current one
  --json           Print the API's JSON, for piping into something else
  --limit <n>      How many rows to fetch

Configuration comes from the environment, or a .env beside you:
  TSBB_DATABASE_URL   file:./data/tsbb.db  (or a libsql:// URL for Turso)
  TSBB_BASE_URL       http://localhost:3000
  TSBB_MAIL_TRANSPORT console | resend | smtp
`;

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === '--help' || command === '-h' || command === 'help') {
  console.log(USAGE);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(join(HERE, '../package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

// Load a .env before anything reads the environment, so every command below —
// and the server it may start — sees the same configuration.
const { existsSync } = await import('node:fs');
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  const { readFileSync } = await import('node:fs');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue; // a real env var always wins
    process.env[key] = rawValue.replace(/^["']|["']$/g, '').trim();
  }
}

const baseUrl = process.env.TSBB_BASE_URL ?? 'http://localhost:3000';

/**
 * Split the flags out of the arguments.
 *
 * The remote commands take their flags anywhere, because `tsbb read 12 --json`
 * and `tsbb --json read 12` are both what people type, and a CLI that accepts
 * only one of them is a CLI you have to remember the shape of.
 */
function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--read-only') flags.readOnly = true;
    else if (arg === '--server' || arg === '-s') flags.server = args[(i += 1)];
    else if (arg === '--limit' || arg === '-n') flags.limit = Number(args[(i += 1)]);
    else if (arg?.startsWith('--server=')) flags.server = arg.slice(9);
    else if (arg?.startsWith('--limit=')) flags.limit = Number(arg.slice(8));
    else rest.push(arg);
  }
  return { flags, rest };
}

try {
  switch (command) {
    case 'init': {
      const { init } = await import('../src/commands.ts');
      await init();
      break;
    }
    case 'serve':
    case 'start': {
      const portFlag = argv.indexOf('--port');
      if (portFlag !== -1 && argv[portFlag + 1]) process.env.TSBB_PORT = argv[portFlag + 1];
      const { boot } = await import(`${REPO_ROOT}/apps/server/src/index.ts`);
      await boot();
      break;
    }
    case 'worker': {
      const { startWorker } = await import(`${REPO_ROOT}/apps/worker/src/index.ts`);
      const { transport } = await import('@tsbb/mail');
      console.log(`[worker] started, transport=${transport().name}`);
      startWorker({ baseUrl });
      setInterval(() => {}, 1 << 30);
      break;
    }
    case 'migrate': {
      const { migrateCommand } = await import('../src/commands.ts');
      await migrateCommand();
      process.exit(0);
    }
    case 'status': {
      const { status } = await import('../src/commands.ts');
      await status();
      process.exit(0);
    }
    case 'admin': {
      const { promote } = await import('../src/commands.ts');
      if (!argv[1]) throw new Error('Which email address? Run: tsbb admin you@example.com');
      await promote(argv[1]);
      process.exit(process.exitCode ?? 0);
    }
    case 'unadmin': {
      const { demote } = await import('../src/commands.ts');
      if (!argv[1]) throw new Error('Which email address?');
      await demote(argv[1]);
      process.exit(process.exitCode ?? 0);
    }
    case 'invite': {
      const { invite } = await import('../src/commands.ts');
      if (!argv[1]) throw new Error('Which email address?');
      await invite(argv[1], baseUrl);
      process.exit(0);
    }
    case 'plugin':
    case 'plugins': {
      const { listPlugins, setPluginEnabled } = await import('../src/commands.ts');
      const sub = argv[1] ?? 'ls';
      if (sub === 'ls' || sub === 'list') await listPlugins();
      else if (sub === 'enable' || sub === 'disable') {
        if (!argv[2]) throw new Error(`Which plugin? Run: tsbb plugin ${sub} <slug>`);
        await setPluginEnabled(argv[2], sub === 'enable');
      } else throw new Error(`Unknown: tsbb plugin ${sub}`);
      process.exit(process.exitCode ?? 0);
    }
    /*
     * Everything below talks to a board over HTTP and never opens the database,
     * so these work from any directory, with no .env and no checkout — which is
     * the point of them. Failures are reported by reportRemoteError rather than
     * the catch below, because "not signed in" deserves better than a stack.
     */
    case 'login':
    case 'logout':
    case 'boards':
    case 'use':
    case 'whoami':
    case 'forums':
    case 'latest':
    case 'topics':
    case 'read':
    case 'search':
    case 'inbox':
    case 'post':
    case 'reply': {
      const remote = await import('../src/remote.ts');
      const { flags, rest } = parseFlags(argv.slice(1));
      try {
        switch (command) {
          case 'login':
            await remote.loginCommand(rest[0], flags);
            break;
          case 'logout':
            remote.logoutCommand(rest[0], flags);
            break;
          case 'boards':
            remote.boardsCommand(flags);
            break;
          case 'use':
            if (!rest[0]) throw new Error('Which board? Run: tsbb use <server>');
            remote.useCommand(rest[0], flags);
            break;
          case 'whoami':
            await remote.whoamiCommand(flags);
            break;
          case 'forums':
            await remote.forumsCommand(flags);
            break;
          case 'latest':
            await remote.latestCommand(flags);
            break;
          case 'topics':
            await remote.topicsCommand(rest[0], flags);
            break;
          case 'read':
            await remote.readCommand(rest[0], flags);
            break;
          case 'search':
            await remote.searchCommand(rest, flags);
            break;
          case 'inbox':
            await remote.inboxCommand(flags);
            break;
          case 'post':
            await remote.postCommand(rest, flags);
            break;
          case 'reply':
            await remote.replyCommand(rest, flags);
            break;
        }
      } catch (error) {
        remote.reportRemoteError(error);
      }
      process.exit(process.exitCode ?? 0);
    }

    /*
     * The MCP server. It holds the current board's token and speaks over stdio,
     * which is what an assistant's config launches. Nothing may reach stdout
     * except protocol messages, so there is no banner here — the startup line
     * goes to stderr, where clients show it as a log.
     */
    case 'mcp': {
      const remote = await import('../src/remote.ts');
      const { flags } = parseFlags(argv.slice(1));
      try {
        const { serveStdio } = await import('@tsbb/mcp');
        const { readFileSync } = await import('node:fs');
        const client = remote.clientFor(flags);
        const me = await client.me().catch(() => ({ authenticated: false }));
        const allowWrites = !flags.readOnly && me.authenticated;
        const pkg = JSON.parse(readFileSync(join(HERE, '../package.json'), 'utf8'));

        process.stderr.write(
          `[tsbb-mcp] ${client.server} — ${me.authenticated ? `signed in as ${me.user?.username}` : 'not signed in'}, writes ${allowWrites ? 'on' : 'off'}\n`,
        );
        await serveStdio({ client, allowWrites, version: pkg.version ?? '0.0.0' });
      } catch (error) {
        remote.reportRemoteError(error);
      }
      process.exit(process.exitCode ?? 0);
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
