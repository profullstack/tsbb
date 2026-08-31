#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let version = '0.0.0';
try {
  version = JSON.parse(readFileSync(join(HERE, '../package.json'), 'utf8')).version ?? version;
} catch {
  /* the version is a label in the handshake, not something to fail over */
}

const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv.slice(2), version);
