#!/usr/bin/env node
import { currentBoard, loadConfig, normaliseServer, rememberBoard } from '../src/config.ts';
import { run } from '../src/app.ts';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`tsbb-tui — terminal client for a tsbb bulletin board

Usage:
  tsbb-tui [server]          Connect to a board (remembered for next time)
  tsbb-tui --logout          Forget the stored token for the current board
  tsbb-tui --boards          List the boards this machine knows about

The server is a URL like https://forum.example.com. A bare hostname is assumed
to be https, except localhost. Sign in from inside the client with L: it shows a
code, you approve it in a browser, and the board hands the terminal a token.`);
  process.exit(0);
}

const config = loadConfig();

if (argv.includes('--boards')) {
  const entries = Object.values(config.boards);
  if (!entries.length) console.log('No boards configured yet. Run: tsbb-tui <server>');
  for (const board of entries) {
    const mark = board.server === config.current ? '*' : ' ';
    console.log(`${mark} ${board.server}${board.token ? '' : '  (signed out)'}`);
  }
  process.exit(0);
}

if (argv.includes('--logout')) {
  const board = currentBoard(config);
  if (board) {
    rememberBoard({ ...board, token: null });
    console.log(`Signed out of ${board.server}.`);
  } else {
    console.log('No board is configured.');
  }
  process.exit(0);
}

const positional = argv.find((arg) => !arg.startsWith('-'));
const existing = currentBoard(config);
const server = positional
  ? normaliseServer(positional)
  : (existing?.server ?? process.env.TSBB_SERVER ?? '');

if (!server) {
  console.error('Which board? Run: tsbb-tui https://forum.example.com');
  process.exit(1);
}

// A server named on the command line that we have a token for should reuse it.
const token = config.boards[server]?.token ?? null;
if (!config.boards[server]) rememberBoard({ server, token: null });

try {
  await run({ server, token });
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
