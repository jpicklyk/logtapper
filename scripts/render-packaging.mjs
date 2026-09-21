#!/usr/bin/env node
/**
 * Render the Homebrew cask and Scoop manifest templates for a release.
 *
 *   node scripts/render-packaging.mjs --version 0.14.0 --out dist/packaging
 *   node scripts/render-packaging.mjs --check
 *
 * `packaging/*.tmpl` carry `{{PLACEHOLDER}}` tokens for the version and the
 * per-asset SHA-256 of the GitHub release assets. This script fills them
 * in, either from `--sha256 <asset-basename>=<hex>` overrides (tests,
 * offline runs — the basename is the *rendered* filename, e.g.
 * `LogTapper_0.14.0_x64-setup.exe`) or by downloading the three assets from
 * the GitHub release and hashing them as they stream in. `publish-packages.yml`
 * runs it without overrides.
 *
 * `--check` never touches the network: it renders the committed templates
 * against the current `package.json` version with dummy hashes and fails if
 * any `{{...}}` token survives — catching a typo'd placeholder name before
 * it reaches CI. `scripts/bump-version.mjs --check` covers the five version
 * files; this covers the two packaging templates.
 *
 * Deliberately plain string replacement, like `bump-version.mjs` — the
 * templates are hand-formatted (Homebrew's `sha256 arm:` alignment, Scoop's
 * literal `$version` autoupdate token, which this script never touches
 * since it only replaces `{{...}}`) and a JSON/Ruby round-trip would
 * reformat them.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// RENDER_PACKAGING_ROOT lets the test point at a directory holding a broken
// template; nothing else should set it.
const root = process.env.RENDER_PACKAGING_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'jpicklyk/LogTapper';

// Placeholder name -> the release asset it hashes, as a function of version.
const ASSETS = {
  SHA256_ARM: (version) => `LogTapper_${version}_aarch64.dmg`,
  SHA256_X64: (version) => `LogTapper_${version}_x64.dmg`,
  SHA256_NSIS: (version) => `LogTapper_${version}_x64-setup.exe`,
};

const TEMPLATES = [
  { src: 'packaging/homebrew/logtapper.rb.tmpl', out: 'homebrew/Casks/logtapper.rb' },
  { src: 'packaging/scoop/logtapper.json.tmpl', out: 'scoop/bucket/logtapper.json' },
];

function packageJsonVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg.version;
}

function releaseAssetUrl(version, asset) {
  return `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
}

async function sha256OfUrl(url) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest('hex');
}

async function resolveHashes(version, overrides) {
  const hashes = {};
  for (const [placeholder, assetFor] of Object.entries(ASSETS)) {
    const asset = assetFor(version);
    if (overrides.has(asset)) {
      hashes[placeholder] = overrides.get(asset);
      continue;
    }
    const url = releaseAssetUrl(version, asset);
    console.log(`downloading ${asset} ...`);
    try {
      hashes[placeholder] = await sha256OfUrl(url);
    } catch (err) {
      throw new Error(
        `no --sha256 override for ${asset}, and downloading it failed: ${err.message} (${url})`,
      );
    }
    console.log(`  sha256 ${hashes[placeholder]}`);
  }
  return hashes;
}

function render(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in values ? values[key] : whole));
}

// Anything that still looks like a placeholder opener counts, so a malformed
// token such as `{{ VERSION }}` or `{{SHA-256}}` cannot slip through rendering.
function unrenderedPlaceholders(text) {
  return [...new Set([...text.matchAll(/\{\{[^}\n]*\}?\}?/g)].map((m) => m[0]))];
}

function writeRendered(outDir, version, hashes) {
  const values = { VERSION: version, ...hashes };
  for (const t of TEMPLATES) {
    const text = readFileSync(join(root, t.src), 'utf8');
    const rendered = render(text, values);
    const leftover = unrenderedPlaceholders(rendered);
    if (leftover.length > 0) {
      throw new Error(`${t.src}: unrendered placeholder(s) ${leftover.join(', ')}`);
    }
    const outPath = join(outDir, t.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered);
    console.log(`wrote ${outPath}`);
  }
}

function check() {
  const version = packageJsonVersion();
  const dummy = '0'.repeat(64);
  const values = { VERSION: version, SHA256_ARM: dummy, SHA256_X64: dummy, SHA256_NSIS: dummy };
  let failed = false;
  for (const t of TEMPLATES) {
    const text = readFileSync(join(root, t.src), 'utf8');
    const leftover = unrenderedPlaceholders(render(text, values));
    if (leftover.length > 0) {
      console.error(`${t.src}: unrendered placeholder(s) ${leftover.join(', ')}`);
      failed = true;
    } else {
      console.log(`${t.src}: ok`);
    }
  }
  if (failed) process.exit(1);
  console.log(`\nall templates render cleanly for ${version}`);
}

function parseArgs(argv) {
  const args = { sha256: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      args.check = true;
    } else if (arg === '--version') {
      args.version = argv[++i];
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--sha256') {
      const pair = argv[++i];
      const eq = pair ? pair.indexOf('=') : -1;
      if (eq <= 0) {
        console.error(`--sha256 expects <asset-basename>=<hex>, got ${pair ?? '(nothing)'}`);
        process.exit(2);
      }
      args.sha256.set(pair.slice(0, eq), pair.slice(eq + 1));
    } else {
      console.error(`unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    check();
    return;
  }
  if (!args.out) {
    console.error(
      'usage: node scripts/render-packaging.mjs --version X --out <dir> [--sha256 asset=hex ...] | --check',
    );
    process.exit(2);
  }
  const version = args.version ?? packageJsonVersion();
  const outDir = resolve(args.out);
  const hashes = await resolveHashes(version, args.sha256);
  writeRendered(outDir, version, hashes);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
