import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The board's version, as the repository declares it.
 *
 * Read once at import. It is a label — the service worker hashes it, MCP
 * clients display it — so a missing package.json degrades to a placeholder
 * rather than stopping the board from booting.
 */
export const packageVersion: string = (() => {
  try {
    const raw = readFileSync(join(HERE, '../../../package.json'), 'utf8');
    return String((JSON.parse(raw) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
