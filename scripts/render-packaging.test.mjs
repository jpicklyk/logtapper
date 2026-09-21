// node --test scripts/render-packaging.test.mjs
//
// Runs the script as a real CLI subprocess (it has no exported functions to
// unit-test against — same shape as `bump-version.mjs`). Uses `node:os`'s
// tmpdir rather than a fixed path so parallel runs don't collide.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const script = fileURLToPath(new URL('./render-packaging.mjs', import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('overrides render both files with the expected version/hash strings, no network', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'render-packaging-'));
  try {
    const armHash = 'a'.repeat(64);
    const x64Hash = 'b'.repeat(64);
    const nsisHash = 'c'.repeat(64);
    const { status, stderr } = run([
      '--version',
      '9.9.9',
      '--out',
      outDir,
      '--sha256',
      `LogTapper_9.9.9_aarch64.dmg=${armHash}`,
      '--sha256',
      `LogTapper_9.9.9_x64.dmg=${x64Hash}`,
      '--sha256',
      `LogTapper_9.9.9_x64-setup.exe=${nsisHash}`,
    ]);
    assert.equal(status, 0, stderr);

    const cask = readFileSync(join(outDir, 'homebrew/Casks/logtapper.rb'), 'utf8');
    assert.match(cask, /version "9\.9\.9"/);
    assert.match(cask, new RegExp(armHash));
    assert.match(cask, new RegExp(x64Hash));
    assert.doesNotMatch(cask, /\{\{/);

    const manifest = readFileSync(join(outDir, 'scoop/bucket/logtapper.json'), 'utf8');
    const parsed = JSON.parse(manifest);
    assert.equal(parsed.version, '9.9.9');
    assert.equal(parsed.hash, nsisHash);
    assert.equal(
      parsed.url,
      'https://github.com/jpicklyk/LogTapper/releases/download/v9.9.9/LogTapper_9.9.9_x64-setup.exe',
    );
    // Scoop's own `$version` autoupdate token must survive untouched.
    assert.match(manifest, /LogTapper_\$version_x64-setup\.exe/);
    assert.doesNotMatch(manifest, /\{\{/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('missing override falls through to a download that fails with a clear error', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'render-packaging-'));
  try {
    // A version with no real release: the aarch64.dmg and x64.dmg overrides
    // are supplied but the NSIS exe is not, so the script must attempt (and
    // fail) that one download rather than silently skipping it or crashing
    // with a raw stack trace.
    const { status, stderr, stdout } = run([
      '--version',
      '0.0.0-does-not-exist',
      '--out',
      outDir,
      '--sha256',
      'LogTapper_0.0.0-does-not-exist_aarch64.dmg=' + 'a'.repeat(64),
      '--sha256',
      'LogTapper_0.0.0-does-not-exist_x64.dmg=' + 'b'.repeat(64),
    ]);
    assert.notEqual(status, 0);
    // The two overridden assets never print a "downloading" line; only the
    // un-overridden NSIS asset should reach the network.
    assert.doesNotMatch(stdout, /aarch64\.dmg|x64\.dmg/);
    assert.match(stdout, /downloading LogTapper_0\.0\.0-does-not-exist_x64-setup\.exe/);
    assert.match(stderr, /LogTapper_0\.0\.0-does-not-exist_x64-setup\.exe/);
    assert.match(stderr, /no --sha256 override/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('--check passes on the committed templates', () => {
  const { status, stdout, stderr } = run(['--check']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /packaging\/homebrew\/logtapper\.rb\.tmpl: ok/);
  assert.match(stdout, /packaging\/scoop\/logtapper\.json\.tmpl: ok/);
  assert.match(stdout, /all templates render cleanly/);
});

test('a malformed placeholder fails the render instead of surviving into the output', () => {
  // Copy the real templates into a scratch root and break one of them the way a
  // hand edit would: spaces inside the braces, which the old check let through.
  const scratch = mkdtempSync(join(tmpdir(), 'render-packaging-broken-'));
  const outDir = join(scratch, 'out');
  try {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    cpSync(join(repo, 'packaging'), join(scratch, 'packaging'), { recursive: true });
    cpSync(join(repo, 'package.json'), join(scratch, 'package.json'));
    const tmpl = join(scratch, 'packaging', 'scoop', 'logtapper.json.tmpl');
    writeFileSync(tmpl, readFileSync(tmpl, 'utf8').replace('{{SHA256_NSIS}}', '{{ SHA256_NSIS }}'));

    const result = spawnSync(process.execPath, [script, '--check'], {
      encoding: 'utf8',
      env: { ...process.env, RENDER_PACKAGING_ROOT: scratch },
    });
    assert.notEqual(result.status, 0, 'a broken template must fail --check');
    assert.match(result.stderr, /unrendered placeholder/);
    assert.match(result.stderr, /\{\{ SHA256_NSIS \}\}/);
    assert.equal(existsSync(join(outDir, 'scoop', 'bucket', 'logtapper.json')), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
