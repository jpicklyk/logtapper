/**
 * Build the LogTapper MCP Bundle (.mcpb).
 *
 * Produces a single-file Node bundle plus a generated manifest, then packs
 * both into `dist/logtapper.mcpb`. The bundle is self-contained: Claude
 * Desktop supplies the Node runtime and `${__dirname}` resolves the install
 * location, so the result does not depend on where LogTapper itself was
 * installed — unlike the `logtapper-mcp` sidecar, which Claude Code launches
 * by absolute path.
 *
 * Bundling with rolldown (already present via Vite) rather than bun keeps this
 * runnable anywhere Node is, including a plain `npm ci` CI job.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..');
const staging = join(serverRoot, 'build');
const outFile = join(serverRoot, 'dist', 'logtapper.mcpb');

const pkg = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));

/** Must match `DEFAULT_UPSTREAM_URL` in src/relay.ts and `MCP_HTTP_PORT` in the backend. */
const DEFAULT_MCP_URL = 'http://127.0.0.1:40405/mcp';

// npx/rolldown resolve differently on Windows — call the shim directly.
const bin = (name) =>
  join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32' });

// 0. Skip when already up to date — this runs on every `tauri dev` start.
const newestInput = () => {
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(join(serverRoot, 'src'));
  for (const f of [join(serverRoot, 'package.json'), fileURLToPath(import.meta.url)]) {
    newest = Math.max(newest, statSync(f).mtimeMs);
  }
  return newest;
};

if (!process.argv.includes('--force') && existsSync(outFile) && statSync(outFile).mtimeMs > newestInput()) {
  console.log(`${outFile} is up to date — skipping (pass --force to rebuild)`);
  process.exit(0);
}

// 1. Clean staging.
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, 'server'), { recursive: true });
mkdirSync(join(serverRoot, 'dist'), { recursive: true });

// 2. Bundle to a single ESM file — no node_modules ships in the bundle.
//    The entry is the *relay*, not the server: the bundle forwards tool calls
//    over HTTP to the server the running app spawns (see src/relay.ts), so it
//    never carries tool definitions that could go stale.
run(bin('rolldown'), [
  join(serverRoot, 'src', 'relay.ts'),
  '-o', join(staging, 'server', 'index.js'),
  '--format', 'esm',
  '--platform', 'node',
]);

if (!existsSync(join(staging, 'server', 'index.js'))) {
  throw new Error('rolldown produced no output — aborting before pack');
}

// 3. Generate the manifest. Version and description come from package.json so
//    they cannot drift from the server they describe.
const manifest = {
  manifest_version: '0.1',
  name: 'logtapper',
  display_name: 'LogTapper',
  version: pkg.version,
  description: pkg.description,
  long_description:
    'Gives Claude direct tool access to log sessions open in the LogTapper desktop app — ' +
    'search and sample lines, run analysis pipelines, read state-tracker transitions and ' +
    'correlator events, reconstruct state at any line, and manage bookmarks, analyses and ' +
    'live watches.\n\n' +
    'Requires LogTapper to be running with the MCP Bridge enabled ' +
    '(Settings > General > MCP Integration). The bridge listens on 127.0.0.1:40404 and is ' +
    'never exposed off the local machine.',
  author: { name: 'jpicklyk' },
  homepage: 'https://github.com/jpicklyk/logtapper',
  repository: { type: 'git', url: 'https://github.com/jpicklyk/logtapper' },
  license: 'GPL-3.0-or-later',
  keywords: ['logtapper', 'logs', 'android', 'logcat', 'bugreport', 'log-analysis'],
  // The relay only needs to know where the app serves MCP. Claude Desktop
  // renders `user_config` as extension settings and substitutes the value
  // into `env`, so a user who changed LogTapper's MCP port edits this once
  // in Claude Desktop rather than reinstalling anything.
  user_config: {
    mcp_url: {
      type: 'string',
      title: 'LogTapper MCP URL',
      description:
        'Where LogTapper serves MCP over HTTP. Only change this if you changed the port in ' +
        'LogTapper (Settings > General > MCP Integration).',
      default: DEFAULT_MCP_URL,
      required: false,
    },
  },
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
      env: {
        LOGTAPPER_MCP_URL: '${user_config.mcp_url}',
      },
    },
  },
};
writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 4. Pack.
rmSync(outFile, { force: true });
run(bin('mcpb'), ['pack', staging, outFile]);

if (!existsSync(outFile)) {
  throw new Error(`pack reported success but ${outFile} is missing`);
}
console.log(`\nBuilt ${outFile}`);
