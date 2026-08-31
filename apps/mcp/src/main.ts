import { BoardClient, currentBoard, loadConfig, normaliseServer } from '@tsbb/client';
import { serveStdio } from '@tsbb/mcp';

/**
 * `tsbb-mcp` — a board, served to an assistant over stdio.
 *
 * It is deliberately a separate binary from the board itself. The board serves
 * MCP at /api/mcp for clients that speak HTTP, but the common case is an
 * assistant on somebody's laptop launching a subprocess, and that assistant is
 * not the board's administrator — it is a member, holding one member's token.
 *
 * Where that token comes from, in order: --token, TSBB_TOKEN, or the board you
 * last ran `tsbb login` against. Which is also why this refuses to guess a
 * server: posting to the wrong board under someone's name is not recoverable.
 */
export interface Options {
  server: string;
  token: string | null;
  allowWrites: boolean;
  version: string;
}

const USAGE = `tsbb-mcp — serve a tsbb bulletin board to an AI assistant over MCP.

Usage:
  tsbb-mcp [--server <url>] [--token <token>] [--read-only]

  --server <url>   Which board. Defaults to TSBB_SERVER, then to whichever
                   board you last signed in to with \`tsbb login\`.
  --token <token>  A bearer token. Defaults to TSBB_TOKEN, then to the stored
                   token for that board. Without one the server is read-only.
  --read-only      Serve the reading tools only, even when a token is present.

Configure a client to run this command. For example, in a Claude Code or
Claude Desktop MCP config:

  {
    "mcpServers": {
      "myboard": {
        "command": "node",
        "args": ["/path/to/tsbb/apps/mcp/bin/tsbb-mcp.mjs", "--server", "https://board.example"],
        "env": { "TSBB_TOKEN": "…" }
      }
    }
  }
`;

export function parse(argv: string[]): { help: boolean; options?: Options; error?: string } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  let server: string | null = null;
  let token: string | null = null;
  let readOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server' || arg === '-s') server = argv[(i += 1)] ?? null;
    else if (arg === '--token') token = argv[(i += 1)] ?? null;
    else if (arg === '--read-only') readOnly = true;
    else if (arg?.startsWith('--server=')) server = arg.slice(9);
    else if (arg?.startsWith('--token=')) token = arg.slice(8);
    else return { help: false, error: `Unknown argument: ${arg}` };
  }

  server ??= process.env.TSBB_SERVER ?? null;
  token ??= process.env.TSBB_TOKEN ?? null;

  const config = loadConfig();
  if (!server) {
    const board = currentBoard(config);
    if (!board) {
      return {
        help: false,
        error:
          'No board given. Pass --server <url>, set TSBB_SERVER, or run `tsbb login <server>` first.',
      };
    }
    server = board.server;
    token ??= board.token;
  } else {
    server = normaliseServer(server);
    token ??= config.boards[server]?.token ?? null;
  }

  return {
    help: false,
    options: { server, token, allowWrites: Boolean(token) && !readOnly, version: '0.0.0' },
  };
}

export async function main(argv: string[], version: string): Promise<number> {
  const parsed = parse(argv);
  if (parsed.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  if (parsed.error || !parsed.options) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }

  const { server, token, allowWrites } = parsed.options;
  const client = new BoardClient({ server, token });

  // Say what this is on stderr before the first message arrives. stdout carries
  // protocol only — anything else there is a parse error in the client.
  process.stderr.write(
    `[tsbb-mcp] ${server} — ${token ? 'token loaded' : 'no token, read-only'}, writes ${allowWrites ? 'on' : 'off'}\n`,
  );

  await serveStdio({ client, allowWrites, version });
  return 0;
}
