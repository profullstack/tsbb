import { createInterface } from 'node:readline';
import { handleRaw, type ServerOptions } from './server.ts';

/**
 * MCP over stdio: one JSON message per line, in and out.
 *
 * Nothing but protocol messages may ever reach stdout — a stray console.log
 * here is not a cosmetic problem, it is a parse error in the client and a
 * server that appears to have crashed. Diagnostics go to stderr.
 */
export async function serveStdio(options: ServerOptions): Promise<void> {
  const lines = createInterface({ input: process.stdin, terminal: false });

  /*
   * Messages are handled one at a time. The board is a small server behind a
   * personal token, and ordered replies are worth more here than the
   * concurrency: a client that sends initialize and tools/list back to back
   * must not see them answered out of order.
   */
  let queue: Promise<void> = Promise.resolve();

  for await (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    queue = queue.then(async () => {
      try {
        const response = await handleRaw(raw, options);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stderr.write(`[tsbb-mcp] ${(error as Error).message}\n`);
      }
    });
  }

  await queue;
}
