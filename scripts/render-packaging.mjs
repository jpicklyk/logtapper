#!/usr/bin/env node
/**
 * Render the Homebrew cask, Scoop manifest and Chocolatey package templates
 * for a release.
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
 * The Chocolatey nuspec also carries `{{ICON_COMMIT}}`, the commit sha the
 * jsdelivr icon URL is pinned to: `--icon-commit <sha>` when given, else
 * `git rev-parse HEAD`, else the literal `main` with a console warning.
 * `packaging/chocolatey/tools/chocolateyuninstall.ps1` has no placeholders,
 * so rendering it is a verbatim copy; it is listed with the templates because
 * `choco pack` needs every `tools\**` file in the output tree.
 *
 * `--check` never touches the network or the filesystem's git state: it
 * renders the committed templates against the current `package.json`
 * version with dummy hashes and a dummy 40-char `ICON_COMMIT`, and fails if
 * a template is missing or any `{{...}}` token survives —
 * catching a typo'd placeholder name before it reaches CI.
 * `scripts/bump-version.mjs --check` covers the five version files; this
 * covers the packaging templates.
 *
 * Deliberately plain string replacement, like `bump-version.mjs` — the
 * templates are hand-formatted (Homebrew's `sha256 arm:` alignment, Scoop's
 * literal `$version` autoupdate token, which this script never touches
 * since it only replaces `{{...}}`) and a JSON/Ruby round-trip would
 * reformat them.
 */
import { execFileSync } from 'node:child_process';
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
  { src: 'packaging/chocolatey/logtapper.nuspec.tmpl', out: 'chocolatey/logtapper.nuspec' },
  {
    src: 'packaging/chocolatey/tools/chocolateyinstall.ps1.tmpl',
    out: 'chocolatey/tools/chocolateyinstall.ps1',
  },
  // No placeholders: rendered as a verbatim copy (see the header comment).
  {
    src: 'packaging/chocolatey/tools/chocolateyuninstall.ps1',
    out: 'chocolatey/tools/chocolateyuninstall.ps1',
  },
];

function packageJsonVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg.version;
}

function releaseAssetUrl(version, asset) {
  return `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
}

// The Chocolatey nuspec's iconUrl is a jsdelivr URL pinned to a commit sha
// (not a branch) so the icon can never change under an already-published
// version. `--icon-commit` wins; otherwise the current HEAD; otherwise
// `main`, with a warning since that pin can drift.
function resolveIconCommit(argIconCommit) {
  if (argIconCommit) return argIconCommit;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (err) {
    console.warn(
      `warning: git rev-parse HEAD failed (${err.message}); pinning the Chocolatey iconUrl to "main" instead of a commit sha`,
    );
    return 'main';
  }
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

/** Read, render and verify one template; throws naming any surviving placeholder. */
function renderTemplate(template, values) {
  const rendered = render(readFileSync(join(root, template.src), 'utf8'), values);
  const leftover = unrenderedPlaceholders(rendered);
  if (leftover.length > 0) {
    throw new Error(`${template.src}: unrendered placeholder(s) ${leftover.join(', ')}`);
  }
  return rendered;
}

function writeRendered(outDir, version, hashes, iconCommit) {
  const values = { VERSION: version, ICON_COMMIT: iconCommit, ...hashes };
  for (const t of TEMPLATES) {
    const rendered = renderTemplate(t, values);
    const outPath = join(outDir, t.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered);
    console.log(`wrote ${outPath}`);
  }
}

function check() {
  const version = packageJsonVersion();
  const dummy = '0'.repeat(64);
  const dummyIconCommit = '0'.repeat(40);
  const values = {
    VERSION: version,
    ICON_COMMIT: dummyIconCommit,
    ...Object.fromEntries(Object.keys(ASSETS).map((k) => [k, dummy])),
  };
  let failed = false;
  for (const t of TEMPLATES) {
    try {
      renderTemplate(t, values);
      console.log(`${t.src}: ok`);
    } catch (err) {
      console.error(err.message);
      failed = true;
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
    } else if (arg === '--icon-commit') {
      args.iconCommit = argv[++i];
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
      'usage: node scripts/render-packaging.mjs --version X --out <dir> [--sha256 asset=hex ...] [--icon-commit sha] | --check',
    );
    process.exit(2);
  }
  const version = args.version ?? packageJsonVersion();
  const outDir = resolve(args.out);
  const iconCommit = resolveIconCommit(args.iconCommit);
  const hashes = await resolveHashes(version, args.sha256);
  writeRendered(outDir, version, hashes, iconCommit);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
