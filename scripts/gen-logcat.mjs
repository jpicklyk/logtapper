#!/usr/bin/env node
/**
 * Deterministic Android logcat "threadtime" fixture generator (LogTapper P4 bench).
 *
 * Emits lines in the exact format `LogcatParser::threadtime_re()` expects
 * (src-tauri/src/core/logcat_parser.rs):
 *
 *   MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message
 *
 * Deterministic: a fixed seed (mulberry32 PRNG) means the same `--lines`
 * value always produces byte-identical output, so bench runs are comparable
 * across machines and across React/Solid.
 *
 * Usage:
 *   node scripts/gen-logcat.mjs [--lines 1000000] [--out bench/logcat-1m.log]
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── CLI args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { lines: 1_000_000, out: resolve(REPO_ROOT, 'bench/logcat-1m.log') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lines') out.lines = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--out') out.out = resolve(process.cwd(), argv[++i]);
  }
  if (!Number.isFinite(out.lines) || out.lines <= 0) {
    throw new Error(`--lines must be a positive integer, got: ${out.lines}`);
  }
  return out;
}

// ── Seeded PRNG (mulberry32) — deterministic across platforms/Node versions ──
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x4c4f_4754; // 'LOGT' — arbitrary, fixed for determinism
const rng = mulberry32(SEED);

/** Pick a weighted-random entry: `weights` is [[value, weight], ...]. */
function weightedPick(weights, totalWeight) {
  let r = rng() * totalWeight;
  for (const [value, weight] of weights) {
    r -= weight;
    if (r <= 0) return value;
  }
  return weights[weights.length - 1][0];
}
function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function randInt(min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// ── Processes / threads (realistic Android system + one app process) ────
const PROCESSES = [
  { pid: 812, name: 'system_server', tids: [812, 845, 861, 902, 933] },
  { pid: 1204, name: 'surfaceflinger', tids: [1204, 1211] },
  { pid: 1390, name: 'com.android.systemui', tids: [1390, 1402, 1415, 1440] },
  { pid: 2001, name: 'com.example.myapp', tids: [2001, 2010, 2018, 2025, 2031] },
  { pid: 2200, name: 'com.google.android.gms', tids: [2200, 2215, 2260] },
  { pid: 512, name: 'zygote64', tids: [512] },
  { pid: 733, name: 'logd', tids: [733] },
  { pid: 1600, name: 'com.android.bluetooth', tids: [1600, 1607] },
  { pid: 990, name: 'audioserver', tids: [990, 995] },
  { pid: 2450, name: 'com.android.phone', tids: [2450, 2455] },
];

// ── Tags, weighted by real-world log volume (system chatter dominates) ───
const TAGS = [
  ['ActivityManager', 12], ['ActivityTaskManager', 6], ['PackageManager', 4],
  ['WindowManager', 10], ['InputDispatcher', 8], ['Choreographer', 9],
  ['OpenGLRenderer', 5], ['SurfaceFlinger', 6], ['ViewRootImpl', 7],
  ['PowerManagerService', 3], ['BatteryStatsService', 2], ['NetworkPolicy', 2],
  ['WifiService', 3], ['ConnectivityService', 3], ['GnssLocationProvider', 1],
  ['CameraService', 1], ['MediaCodec', 2], ['AudioFlinger', 4],
  ['DisplayManager', 2], ['InputMethodManager', 3], ['Zygote', 2],
  ['System.err', 2], ['AndroidRuntime', 1], ['chromium', 3], ['OkHttp', 5],
  ['MyApp', 14], ['MyApp/Network', 6], ['MyApp/Db', 4], ['Glide', 3],
  ['Firebase', 2], ['bt_stack', 2],
];
const TAG_TOTAL_WEIGHT = TAGS.reduce((s, [, w]) => s + w, 0);

// LEVEL letters as they appear in threadtime output.
const LEVELS = [['D', 34], ['I', 38], ['V', 5], ['W', 14], ['E', 7], ['F', 2]];
const LEVEL_TOTAL_WEIGHT = LEVELS.reduce((s, [, w]) => s + w, 0);

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const HTTP_PATHS = ['/api/v1/users', '/api/v1/sync', '/api/v1/events', '/api/v1/session/refresh'];
const STACK_CLASSES = [
  'com.example.myapp.MainActivity', 'com.example.myapp.net.ApiClient',
  'com.example.myapp.data.Repository', 'com.example.myapp.ui.HomeFragment',
  'kotlinx.coroutines.internal.ScopeCoroutine', 'okhttp3.internal.http.RealInterceptorChain',
];

/** Build one message body for the given tag; occasionally very long. */
function buildMessage(tag, veryLong) {
  if (veryLong) {
    // Simulate a full response-body / bitmap-dump log line (~6000 chars).
    let blob = '';
    for (let i = 0; i < 750; i++) blob += randInt(0, 0xffffffff).toString(16).padStart(8, '0');
    return `dumping payload (${blob.length} bytes): ${blob}`;
  }
  if (tag === 'OkHttp' || tag === 'MyApp/Network') {
    const method = pick(HTTP_METHODS);
    const path = pick(HTTP_PATHS);
    const status = pick([200, 200, 200, 201, 304, 400, 401, 404, 500]);
    const ms = randInt(4, 850);
    return `--> ${method} ${path} (${status}) ${ms}ms`;
  }
  if (tag === 'MyApp/Db') {
    return `query took ${randInt(1, 120)}ms, rows=${randInt(0, 500)}`;
  }
  if (tag === 'Choreographer') {
    return `Skipped ${randInt(1, 40)} frames!  The application may be doing too much work on its main thread.`;
  }
  if (tag === 'ActivityManager') {
    return `Displayed com.example.myapp/.MainActivity: +${randInt(100, 900)}ms`;
  }
  return `${tag} event #${randInt(1, 999999)} state=${pick(['idle', 'active', 'pending', 'done'])}`;
}

/** A synthetic uncaught-exception stack trace: several logcat lines sharing one tag/header. */
function buildStackTrace() {
  const lines = ['FATAL EXCEPTION: main'];
  lines.push(`Process: com.example.myapp, PID: 2001`);
  lines.push(`java.lang.RuntimeException: Unable to start activity ${pick(STACK_CLASSES)}`);
  const frameCount = randInt(5, 14);
  for (let i = 0; i < frameCount; i++) {
    lines.push(`\tat ${pick(STACK_CLASSES)}.method${i}(File${i}.java:${randInt(10, 900)})`);
  }
  lines.push(`Caused by: java.lang.NullPointerException: Attempt to invoke method on a null object reference`);
  const causeFrames = randInt(3, 8);
  for (let i = 0; i < causeFrames; i++) {
    lines.push(`\tat ${pick(STACK_CLASSES)}.inner${i}(Inner${i}.java:${randInt(10, 400)})`);
  }
  return lines;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function pad3(n) {
  return String(n).padStart(3, '0');
}

function formatTimestamp(epochMs) {
  const d = new Date(epochMs);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())}`;
}

async function main() {
  const { lines: targetLines, out: outPath } = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(outPath), { recursive: true });

  const startedAt = Date.now();
  const stream = createWriteStream(outPath, { encoding: 'utf8' });
  const waitDrain = () => new Promise((res) => stream.once('drain', res));

  let clockMs = Date.UTC(2024, 0, 1, 8, 0, 0, 0);
  let written = 0;
  const CHUNK_LINES = 20_000;
  // Sprinkle ~1 stack trace per 60k lines and ~1 very-long line per 40k lines,
  // both deterministic given the fixed seed.
  const STACK_TRACE_EVERY = 60_000;
  const LONG_LINE_EVERY = 40_000;

  let buf = [];
  const flush = async () => {
    if (buf.length === 0) return;
    const chunk = buf.join('\n') + '\n';
    buf = [];
    if (!stream.write(chunk)) await waitDrain();
  };

  while (written < targetLines) {
    const proc = pick(PROCESSES);
    const tid = pick(proc.tids);
    const level = weightedPick(LEVELS, LEVEL_TOTAL_WEIGHT);
    const tag = weightedPick(TAGS, TAG_TOTAL_WEIGHT);

    // Bursty timestamp advance: mostly sub-millisecond-scale gaps, occasional pauses.
    clockMs += rng() < 0.02 ? randInt(50, 400) : randInt(0, 4);
    const ts = formatTimestamp(clockMs);

    const dueStackTrace = tag === 'AndroidRuntime' || written % STACK_TRACE_EVERY === STACK_TRACE_EVERY - 1;
    if (dueStackTrace) {
      const frames = buildStackTrace();
      for (const frameMsg of frames) {
        buf.push(`${ts}  ${proc.pid}  ${tid} E AndroidRuntime: ${frameMsg}`);
        written++;
        if (written >= targetLines) break;
      }
    } else {
      const veryLong = written % LONG_LINE_EVERY === LONG_LINE_EVERY - 1;
      const message = buildMessage(tag, veryLong);
      buf.push(`${ts}  ${proc.pid}  ${tid} ${level} ${tag}: ${message}`);
      written++;
    }

    if (buf.length >= CHUNK_LINES) await flush();
  }
  await flush();

  await new Promise((res, rej) => stream.end((err) => (err ? rej(err) : res())));

  const elapsedMs = Date.now() - startedAt;
  console.log(`wrote ${written} lines to ${outPath} in ${elapsedMs}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
