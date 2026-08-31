/**
 * A tsbb board as an MCP server.
 *
 * The board serves this itself at /api/mcp, and `tsbb-mcp` serves the same
 * tools over stdio for clients that only speak that. Both are transports around
 * `handle`; the tools underneath call the board's own REST API, so an assistant
 * is held to the same permissions as the member whose token it carries.
 */
export {
  handle,
  handleRaw,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  SERVER_NAME,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ServerOptions,
} from './server.ts';
export { serveStdio } from './stdio.ts';
export {
  runTool,
  TOOLS,
  toolsFor,
  ToolInputError,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './tools.ts';
