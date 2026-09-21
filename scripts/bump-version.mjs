#!/usr/bin/env node
/**
 * Bump (or verify) the app version everywhere it is declared.
 *
 *   node scripts/bump-version.mjs 0.13.0     # write 0.13.0 into all five files
 *   node scripts/bump-version.mjs --check    # exit 1 unless all five agree
 *
 * Five files carry the version and they have drifted by hand before. The
 * in-app updater makes drift worse than cosmetic: `latest.json` reports what
 * `tauri.conf.json` says, the installed app compares against what it was
 * built with, and a mismatch either re-offers the same build forever or hides
 * a real update. Run `--check` before tagging; `release.yml` runs it too.
 *
 * Deliberately plain string replacement anchored to each file's own shape,
 * not JSON/TOML round-trips, so no file is reformatted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Each entry: the file, and a regex whose FIRST capture group is the version.
 * Anchored so only the app's own version matches — never a dependency's.
 */
const TARGETS = [
  { file: 'package.json', pattern: /^(?:  "version": ")([^"]+)(?:",)$/m },
  // The root entry and its `packages[""]` mirror — the two lines `npm version`
  // itself would touch.
  { file: 'package-lock.json', pattern: /^(?:  "version": ")([^"]+)(?:",)$/m },
  { file: 'package-lock.json', pattern: /^(?:    "": \{\n      "name": "log-tapper",\n      "version": ")([^"]+)(?:",)$/m },
  { file: 'src-tauri/Cargo.toml', pattern: /^(?:name = "log-tapper"\nversion = ")([^"]+)(?:")$/m },
  { file: 'src-tauri/Cargo.lock', pattern: /^(?:name = "log-tapper"\nversion = ")([^"]+)(?:")$/m },
  { file: 'src-tauri/tauri.conf.json', pattern: /^(?:  "version": ")([^"]+)(?:",)$/m },
];

function readVersions() {
  return TARGETS.map((t) => {
    const text = readFileSync(join(root, t.file), 'utf8');
    const match = t.pattern.exec(text);
    if (match === null) throw new Error(`${t.file}: version line not found (pattern ${t.pattern})`);
    return { ...t, current: match[1] };
  });
}

function check() {
  const found = readVersions();
  const distinct = [...new Set(found.map((f) => f.current))];
  for (const f of found) console.log(`${f.current.padEnd(12)} ${f.file}`);
  if (distinct.length !== 1) {
    console.error(`\nversion drift: ${distinct.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nall five agree on ${distinct[0]}`);
}

function bump(next) {
  if (!SEMVER.test(next)) {
    console.error(`not a semver version: ${next}`);
    process.exit(2);
  }
  readVersions(); // fail before writing anything if a file no longer matches
  for (const t of TARGETS) {
    // Read fresh per target: package-lock.json appears twice, and the second
    // write must build on the first.
    const path = join(root, t.file);
    const text = readFileSync(path, 'utf8');
    const current = t.pattern.exec(text)[1];
    if (current === next) {
      console.log(`unchanged ${t.file}`);
      continue;
    }
    writeFileSync(path, text.replace(t.pattern, (whole) => whole.replace(current, next)));
    console.log(`${current} -> ${next}  ${t.file}`);
  }
  console.log(`\nnext: git commit -am "chore(release): v${next}" && git tag v${next}`);
}

const arg = process.argv[2];
if (arg === '--check') check();
else if (arg && !arg.startsWith('-')) bump(arg);
else {
  console.error('usage: node scripts/bump-version.mjs <version> | --check');
  process.exit(2);
}
