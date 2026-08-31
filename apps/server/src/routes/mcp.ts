import { Hono } from 'hono';
import { BoardClient } from '@tsbb/client';
import { handle, LATEST_PROTOCOL_VERSION } from '@tsbb/mcp';
import type { AppEnv, Services } from '../context.ts';
import { packageVersion } from '../version.ts';

/**
 * The board, as an MCP server.
 *
 * The tools underneath are the same ones `tsbb-mcp` serves over stdio, and they
 * are written against the REST client — so rather than reaching into the
 * database, this dispatches their requests back through the board's own routes.
 * That is not a detour: it means an assistant is answered by the same code, the
 * same permission checks and the same shapes a browser gets, and there is no
 * second read path to keep in step.
 *
 * Two deliberate restrictions:
 *
 * 1. **Bearer tokens only.** The loopback request carries the Authorization
 *    header and nothing else — never the cookie. A browser attaches cookies to
 *    cross-origin POSTs, so honouring one here would let any page on the web
 *    post to this board as whoever is signed in. A token has to be handed over
 *    on purpose, which is exactly the property that makes it safe here.
 * 2. **Writes need a token.** A guest can read whatever the board shows guests;
 *    the write tools are not even listed without one, so a model is not offered
 *    an action that can only fail.
 */
export function mcpRoutes(
  services: Services,
  dispatch: (request: Request) => Response | Promise<Response>,
) {
  const app = new Hono<AppEnv>();

  app.post('/api/mcp', async (c) => {
    const authorization = c.req.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;

    const client = new BoardClient({
      server: services.baseUrl,
      token,
      fetch: (input, init) => Promise.resolve(dispatch(new Request(input as string, init))),
    });

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That is not JSON.' } },
        400,
        { 'cache-control': 'no-store' },
      );
    }

    const response = await handle(body, {
      client,
      allowWrites: Boolean(token),
      version: packageVersion,
    });

    // A notification has no id and must not be answered. 202 is what the
    // streamable-HTTP transport expects for one.
    if (!response) return c.body(null, 202, { 'cache-control': 'no-store' });

    return c.json(response, 200, {
      'cache-control': 'no-store',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    });
  });

  /*
   * The transport allows a client to open a GET for server-initiated messages.
   * This server never initiates anything, and the spec's answer for that is a
   * 405 — which a client handles, where a hanging stream would not be.
   */
  app.get('/api/mcp', (c) =>
    c.json(
      {
        error: 'method_not_allowed',
        message: 'This MCP endpoint is request/response only. POST a JSON-RPC message.',
      },
      405,
      { allow: 'POST', 'cache-control': 'no-store' },
    ),
  );

  return app;
}
