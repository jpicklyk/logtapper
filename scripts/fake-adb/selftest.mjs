#!/usr/bin/env node
/**
 * Self-test for the fake-adb shim (scripts/fake-adb/) — no Tauri backend, no
 * Android device required.
 *
 * Spawns `adb.cmd -s <serial> logcat -v threadtime -T 1`, the exact argv
 * `AdbLineSource::open` builds in src-tauri/src/services/stream.rs (~248-267),
 * and asserts:
 *   1. lines arrive in ~100-line bursts roughly every 50ms — the backend's
 *      `chunks_timeout(100, Duration::from_millis(50))` window
 *      (services/stream.rs:1264).
 *   2. killing the process terminates it promptly (the app's stop path,
 *      services/stream.rs's `stop()` at ~line 656, does not wait on the
 *      child at all — but a shim that hangs after kill would still leak a
 *      process, so this is worth checking directly).
 *
 * `adb.cmd` must go through `shell: true` here (and would through Rust's own
 * `Command::new("adb")` on Windows too) because CreateProcess cannot execute
 * a `.cmd` file directly — only `cmd.exe` knows how to interpret one. See
 * README.md's "Known limitation" section for what that wrapping costs.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const ADB_CMD = resolve(__dirname, 'adb.cmd');
const DEFAULT_FIXTURE = resolve(REPO_ROOT, 'bench/logcat-1m.log');

const WINDOW_MS = 50;
const SAMPLE_WINDOWS = 10;
const TARGET_LINES_PER_WINDOW = 100;

let failed = false;
function fail(msg) {
  failed = true;
  console.error(`FAIL: ${msg}`);
}

async function main() {
  if (!existsSync(DEFAULT_FIXTURE)) {
    fail(`fixture not found at ${DEFAULT_FIXTURE} — run: node scripts/gen-logcat.mjs`);
    return;
  }

  const spawnedAt = Date.now();
  const child = spawn(
    ADB_CMD,
    ['-s', 'emulator-5554', 'logcat', '-v', 'threadtime', '-T', '1'],
    { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const windowCounts = new Array(SAMPLE_WINDOWS).fill(0);
  let firstDataAt = null;
  let buf = '';
  let totalLines = 0;
  let stderrOut = '';

  child.stdout.on('data', (chunk) => {
    const now = Date.now();
    // `adb.cmd` must be spawned through `cmd.exe` (see the module doc above),
    // which adds real, variable startup latency before the first byte —
    // sample windows relative to the first byte, not process-spawn time, or
    // every window would be dominated by that one-time cost.
    if (firstDataAt === null) firstDataAt = now;
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      buf = buf.slice(idx + 1);
      totalLines++;
      const w = Math.floor((now - firstDataAt) / WINDOW_MS);
      if (w < SAMPLE_WINDOWS) windowCounts[w]++;
    }
  });
  child.stderr.on('data', (c) => { stderrOut += c.toString('utf8'); });

  // Wait long enough to cover cmd.exe/node startup PLUS the full sample window.
  await new Promise((res) => setTimeout(res, SAMPLE_WINDOWS * WINDOW_MS + 2000));

  console.log(`time to first byte: ${firstDataAt !== null ? `${firstDataAt - spawnedAt}ms` : 'never arrived'}`);
  console.log(`per-${WINDOW_MS}ms-window line counts (from first byte): [${windowCounts.join(', ')}]`);
  console.log(`total lines received: ${totalLines}`);
  if (stderrOut) console.log(`stderr: ${stderrOut.trim()}`);

  if (firstDataAt === null) {
    fail('no data ever arrived on stdout');
  }

  // Drop the last window — it may be cut short by the sampling deadline
  // landing mid-window.
  const steady = windowCounts.slice(0, -1);
  const avg = steady.length ? steady.reduce((a, b) => a + b, 0) / steady.length : 0;
  console.log(`steady-state average: ${avg.toFixed(1)} lines/window (target ${TARGET_LINES_PER_WINDOW})`);
  if (avg < TARGET_LINES_PER_WINDOW * 0.6 || avg > TARGET_LINES_PER_WINDOW * 1.4) {
    fail(`steady-state average ${avg.toFixed(1)} lines/window is outside the expected range`);
  }

  // Kill and verify prompt termination — mirrors the app's stop path calling
  // `producer.kill()` (services/stream.rs:1295) then immediately reporting
  // `StreamStopped` without waiting on the child.
  const killedAt = Date.now();
  const exitPromise = new Promise((res) => child.once('exit', () => res(Date.now() - killedAt)));
  child.kill();
  const killLatencyMs = await Promise.race([
    exitPromise,
    new Promise((res) => setTimeout(() => res(-1), 3000)),
  ]);
  console.log(`kill → exit event latency: ${killLatencyMs}ms`);
  if (killLatencyMs < 0) {
    fail('child process did not report exit within 3000ms of kill()');
  }
}

main().then(() => {
  console.log(failed ? 'selftest FAILED' : 'selftest PASSED');
  process.exit(failed ? 1 : 0);
});
