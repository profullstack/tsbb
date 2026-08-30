#!/usr/bin/env node
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const USAGE = `tsbb — a TypeScript bulletin board

Usage:
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
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
