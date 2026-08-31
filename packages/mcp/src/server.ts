import { runTool, toolsFor, type ToolContext } from './tools.ts';

/**
 * The Model Context Protocol, as much of it as a bulletin board needs.
 *
 * This is the protocol layer only: it takes a JSON-RPC message and returns the
 * response, with no idea whether that message arrived on stdin or in an HTTP
 * POST. Both transports are thin wrappers around `handle` below, which is what
 * lets a board serve MCP at /api/mcp and a standalone binary serve the same
 * tools over stdio without either implementing the protocol twice.
 *
 * Tools are the only capability. The board's data is better modelled as tools
 * than as resources — a forum is a query, not a document with a stable URI —
 * and advertising a capability that answers nothing is worse than not having it.
 */

export const SERVER_NAME = 'tsbb';

/**
 * Newest first. A client asks for a version; it gets that one if we speak it,
 * and our newest otherwise, which the spec requires it to check and may refuse.
 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

const INSTRUCTIONS = `This is a tsbb bulletin board — forums, topics and replies.

Call board_overview first: it gives the forum slugs and topic ids every other
tool needs. Search finds posts; read_topic reads one conversation in full.

Anything this server can see is what the member whose token it holds can see, so
a forum missing from list_forums is a forum that member cannot read, not a bug.
Posting writes under that member's name in public — ask the person you are
helping before calling create_topic or reply_to_topic, and quote back what you
are about to post.`;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface ServerOptions extends ToolContext {
  version: string;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one message.
 *
 * Returns null for a notification — a message with no id — because JSON-RPC
 * forbids answering one, and a transport that sends a response anyway will have
 * clients complaining about an id they never issued.
 */
export async function handle(
  message: unknown,
  options: ServerOptions,
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return fail(null, INVALID_REQUEST, 'Expected a JSON-RPC request object.');
  }

  const request = message as JsonRpcRequest;
  const id = request.id ?? null;
  const isNotification = request.id === undefined || request.id === null;

  if (typeof request.method !== 'string') {
    return isNotification ? null : fail(id, INVALID_REQUEST, 'A request needs a method.');
  }

  // Notifications are acknowledged by silence. `initialized` is the one that
  // matters — the client sends it after initialize and expects nothing back.
  if (isNotification) {
    return null;
  }

  switch (request.method) {
    case 'initialize': {
      const asked = String(request.params?.protocolVersion ?? '');
      const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'tsbb bulletin board', version: options.version },
        instructions: INSTRUCTIONS,
      });
    }

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: toolsFor(options.allowWrites).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            title: tool.title,
            readOnlyHint: !tool.write,
            destructiveHint: false,
            // A second identical reply is a second post, not the same one.
            idempotentHint: !tool.write,
            openWorldHint: true,
          },
        })),
      });

    case 'tools/call': {
      const name = String(request.params?.name ?? '');
      const tool = toolsFor(options.allowWrites).find((candidate) => candidate.name === name);
      if (!tool) {
        // A write tool asked for on a read-only server is a different failure
        // from a typo, and saying so saves the model from retrying blindly.
        const hidden = !options.allowWrites && name && TOOL_NAMES.has(name);
        return fail(
          id,
          INVALID_PARAMS,
          hidden
            ? `${name} writes to the board, and this server is read-only. Start it with a token to enable posting.`
            : `No tool called ${name || '(unnamed)'}.`,
        );
      }

      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || Array.isArray(args)) {
        return fail(id, INVALID_PARAMS, 'arguments must be an object.');
      }

      try {
        const result = await runTool(tool, options, args);
        return ok(id, result);
      } catch (error) {
        return fail(id, INTERNAL_ERROR, (error as Error).message);
      }
    }

    default:
      return fail(id, METHOD_NOT_FOUND, `This server does not implement ${request.method}.`);
  }
}

const TOOL_NAMES = new Set(toolsFor(true).map((tool) => tool.name));

/** Parse and handle a raw line or body, so both transports report parse errors alike. */
export async function handleRaw(
  raw: string,
  options: ServerOptions,
): Promise<JsonRpcResponse | null> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return fail(null, PARSE_ERROR, 'That is not JSON.');
  }
  return handle(message, options);
}
