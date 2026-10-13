#!/usr/bin/env node
/**
 * Build the three npm packages: @profullstack/tsbb (CLI), -tui and -mcp.
 *
 *   node scripts/build-npm.mjs            # writes npm/<name>/
 *   (cd npm/tsbb && npm publish)          # and the same for tsbb-tui, tsbb-mcp
 *
 * The apps import TypeScript and the workspace-only @tsbb/* packages, and Node
 * refuses to strip types inside node_modules, so a published copy of the source
 * cannot run. Each bin is bundled into one ESM file instead, with the @tsbb/*
 * code inlined and only real npm dependencies left external. The result installs
 * standalone with `npm i -g`, which is what https://tsbb.dev/install.sh does.
 *
 * `tsbb serve`, `init` and the other board commands need the repository and are
 * not bundled: the published CLI tells you how to get a checkout.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'npm');
const NODE_FLOOR = '>=22.6';

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

/** Versions of the real npm packages, taken from whichever workspace declares them. */
const versions = {};
for (const path of ['apps/tui/package.json', 'packages/client/package.json', 'packages/mcp/package.json']) {
  for (const [name, range] of Object.entries(read(path).dependencies ?? {})) {
    if (!range.startsWith('workspace:')) versions[name] = range;
  }
}

const packages = [
  {
    dir: 'tsbb',
    app: 'apps/cli',
    bin: 'tsbb',
    // Reached only from a checkout (the board commands), so left as runtime imports.
    external: ['../src/commands.ts', '@tsbb/mail'],
    keywords: ['bulletin-board', 'forum', 'bbs', 'cli', 'mcp'],
  },
  {
    dir: 'tsbb-tui',
    app: 'apps/tui',
    bin: 'tsbb-tui',
    external: [],
    keywords: ['bulletin-board', 'forum', 'bbs', 'tui', 'terminal'],
  },
  {
    dir: 'tsbb-mcp',
    app: 'apps/mcp',
    bin: 'tsbb-mcp',
    external: [],
    keywords: ['bulletin-board', 'forum', 'mcp', 'model-context-protocol'],
  },
];

rmSync(OUT, { recursive: true, force: true });

for (const pkg of packages) {
  const source = read(`${pkg.app}/package.json`);
  const dest = join(OUT, pkg.dir);
  mkdirSync(join(dest, 'bin'), { recursive: true });

  const result = await build({
    entryPoints: [join(ROOT, pkg.app, 'bin', `${pkg.bin}.mjs`)],
    outfile: join(dest, 'bin', `${pkg.bin}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'bundle',
    external: [...pkg.external, ...Object.keys(versions)],
    metafile: true,
    logLevel: 'warning',
    // Bundled CommonJS (if any) needs a require() in an ES module.
    banner: { js: "import { createRequire as __tsbbRequire } from 'node:module';\nconst require = __tsbbRequire(import.meta.url);" },
  });

  // Only the externals the bundle really imports become dependencies.
  const used = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imp of output.imports) if (imp.external) used.add(imp.path);
  }
  const dependencies = Object.fromEntries(
    Object.entries(versions).filter(([name]) => [...used].some((path) => path === name || path.startsWith(`${name}/`))),
  );

  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    type: 'module',
    license: source.license,
    author: source.author,
    homepage: 'https://tsbb.dev',
    repository: { type: 'git', url: 'git+https://github.com/profullstack/tsbb.git', directory: pkg.app },
    bugs: { url: 'https://github.com/profullstack/tsbb/issues' },
    keywords: pkg.keywords,
    bin: { [pkg.bin]: `bin/${pkg.bin}.mjs` },
    files: ['bin', 'README.md', 'LICENSE'],
    engines: { node: NODE_FLOOR },
    dependencies,
    publishConfig: { access: 'public' },
  };
  writeFileSync(join(dest, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(ROOT, 'LICENSE'), join(dest, 'LICENSE'));
  writeFileSync(join(dest, 'README.md'), readme(manifest, pkg.bin));
  console.log(`npm/${pkg.dir}: ${manifest.name}@${manifest.version} deps=${Object.keys(dependencies).join(',') || 'none'}`);
}

function readme(manifest, bin) {
  const usage = {
    tsbb: 'tsbb login tsbb.dev     # approve a code in your browser\ntsbb latest             # recently active topics\ntsbb read <topic-id>\ntsbb post <forum> "Title" "Body"\ntsbb mcp                # serve the board to an AI assistant\ntsbb --help',
    'tsbb-tui': 'tsbb-tui tsbb.dev       # read and post in the terminal\ntsbb-tui --help',
    'tsbb-mcp': 'tsbb-mcp --server tsbb.dev [--token tsbb_...] [--read-only]',
  }[bin];
  return `# ${manifest.name}

${manifest.description}

\`\`\`sh
curl -fsSL https://tsbb.dev/install.sh | sh     # installs tsbb, tsbb-tui and tsbb-mcp
npm i -g ${manifest.name}                        # or just this one (Node ${NODE_FLOOR.slice(2)}+)
\`\`\`

\`\`\`sh
${usage}
\`\`\`

Running a board of your own needs the repository: https://github.com/profullstack/tsbb

Docs: https://tsbb.dev · MIT, ${manifest.author}
`;
}

