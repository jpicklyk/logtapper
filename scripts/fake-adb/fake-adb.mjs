#!/usr/bin/env node
/**
 * Fake `adb` for the LogTapper P4 streaming bench.
 *
 * Answers exactly the subcommands `src-tauri/src/services/stream.rs` issues
 * (see that file's `query_adb_devices`/`AdbLineSource::open`/`package_pids`):
 *
 *   adb devices -l                                    → one fake device line
 *   adb -s <serial> logcat -v threadtime -T 1 [--pid N] → replay the fixture
 *   anything else (e.g. `shell pidof <pkg>`)          → exit 0, empty stdout
 *
 * Placed first on PATH as `adb.cmd` (see adb.cmd in this directory), this
 * lets a bench run exercise the real `chunks_timeout` batching and the real
 * Tauri `Channel` with no backend change and no attached device.
 *
 * Env vars:
 *   FAKE_ADB_SOURCE  path to the fixture to replay (default: bench/logcat-1m.log
 *                    resolved relative to the repo root, i.e. two dirs up from
 *                    this file: scripts/fake-adb/fake-adb.mjs).
 *   FAKE_ADB_ONCE=1  stop (closing stdout, causing EOF) after one pass over the
 *                    fixture instead of looping forever.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = resolve(__dirname, '../../bench/logcat-1m.log');

// Matches services/stream.rs's `run_streaming_task`: `chunks_timeout(100, 50ms)`.
const BATCH_LINES = 100;
const BATCH_INTERVAL_MS = 50;

const argv = process.argv.slice(2);

function cmdDevices() {
  // Matches `parse_adb_devices` in services/stream.rs: a header line, then
  // whitespace-separated `<serial> <state> ... model:<model> ...` lines.
  process.stdout.write('List of devices attached\n');
  process.stdout.write(
    'emulator-5554\tdevice product:sdk_gphone64_x86_64 model:Pixel_6_API_34 device:emulator64_x86_64 transport_id:1\n',
  );
  process.stdout.write('\n');
  process.exit(0);
}

function cmdLogcat() {
  const sourcePath = process.env.FAKE_ADB_SOURCE
    ? resolve(process.cwd(), process.env.FAKE_ADB_SOURCE)
    : DEFAULT_SOURCE;

  let lines;
  try {
    lines = readFileSync(sourcePath, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch (e) {
    process.stderr.write(`[fake-adb] failed to read FAKE_ADB_SOURCE '${sourcePath}': ${e.message}\n`);
    process.exit(1);
    return;
  }
  if (lines.length === 0) {
    process.stderr.write(`[fake-adb] source '${sourcePath}' has no lines\n`);
    process.exit(1);
    return;
  }

  const once = process.env.FAKE_ADB_ONCE === '1';
  let index = 0;
  let stopped = false;
  let timer;

  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.exit(code);
  };

  // On Windows, the real stop path (`ChildHandle::kill` → `start_kill` →
  // TerminateProcess) ends this process immediately with no handler run —
  // that IS the "clean exit" the backend's reader task needs (pipe closes →
  // `next_line()` returns None → `chunks_timeout` flushes and yields None).
  // These handlers cover running the shim directly instead (this selftest,
  // manual verification): a POSIX-style signal should stop the loop just as
  // cleanly. Deliberately NOT wired to stdin — the backend always spawns
  // with `Stdio::null()` (see stream.rs's `AdbLineSource::open`), and a
  // `null` stdin reads as an immediate, permanent EOF; a `stdin.on('end', …)`
  // handler here would fire within milliseconds of every real start and
  // stop the replay loop right after it began. Never add one back without
  // first re-checking that contract.
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  // The backend's own `stop_adb_stream` path drops the reader before this
  // shim would see it, but if a consumer closes the read end first (e.g. a
  // test), stdout writes start failing with EPIPE — treat that as "stop".
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') stop(0);
  });

  timer = setInterval(() => {
    if (stopped) return;
    let out = '';
    for (let emitted = 0; emitted < BATCH_LINES; emitted++) {
      if (index >= lines.length) {
        if (once) {
          if (out) process.stdout.write(out);
          stop(0);
          return;
        }
        index = 0; // loop back to the start of the fixture
      }
      out += lines[index] + '\n';
      index++;
    }
    process.stdout.write(out);
  }, BATCH_INTERVAL_MS);
}

if (argv.includes('devices')) {
  cmdDevices();
} else if (argv.includes('logcat')) {
  cmdLogcat();
} else {
  // e.g. `-s <serial> shell pidof <package>` — empty stdout parses to "no
  // PIDs running", the same as `package_pids` sees for a package that isn't
  // running on a real device.
  process.exit(0);
}
