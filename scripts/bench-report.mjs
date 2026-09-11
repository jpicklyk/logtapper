#!/usr/bin/env node
/**
 * Compare two bench harness results and print the plan §C gate table.
 *
 *   node scripts/bench-report.mjs <react.json> <solid.json>
 *        [--react-stream <f>] [--solid-stream <f>]
 *        [--react-heap-growth <bytes>] [--solid-heap-growth <bytes>]
 *        [--json]
 *
 * Each positional file is a `BENCH_RESULT` payload (see scripts/bench.md). Stream
 * numbers may live in the same file (`run()` with a non-zero `streamSeconds`) or in
 * a separate `streamWindow()` capture passed with `--*-stream`.
 *
 * Verdicts follow plan §C:
 *   (a) Solid ≤ React on every metric, no regression > 5 %
 *   (b) scroll p95 ≤ 16.7 ms, scroll max ≤ 33 ms, zero long tasks in the 60 s
 *       stream window, first painted row < 300 ms, heap growth ≤ React + 15 %
 * (a) fails  → gate FAIL. (b) fails while (a) passes → CONDITIONAL PASS.
 */
import { readFileSync } from 'node:fs';

const REGRESSION_TOLERANCE = 0.05; // (a): no regression > 5 %
const HEAP_TOLERANCE = 0.15; // (b): heap growth ≤ React + 15 %

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (key === 'json') flags.json = true;
      else flags[key] = argv[++i];
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mb = (bytes) => (bytes == null ? null : Math.round((bytes / 1048576) * 100) / 100);
const fmt = (v) => (v == null ? '—' : String(v));

/** A metric row. `lowerIsBetter` is true for every metric in this gate. */
function row(label, source, react, solid, bar, check) {
  let delta = '—';
  let regressed = false;
  if (react != null && solid != null) {
    if (react === 0) {
      delta = solid === 0 ? '0%' : '+∞';
      regressed = solid > 0;
    } else {
      const ratio = (solid - react) / react;
      delta = `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`;
      regressed = ratio > REGRESSION_TOLERANCE;
    }
  }
  const absolute = check == null || solid == null ? null : check(solid);
  return { label, source, react, solid, delta, regressed, bar, absolute };
}

function build(reactFile, solidFile, flags) {
  const r = read(reactFile);
  const s = read(solidFile);
  const rs = flags['react-stream'] ? read(flags['react-stream']) : r.stream;
  const ss = flags['solid-stream'] ? read(flags['solid-stream']) : s.stream;
  const rStream = rs && rs.stream ? rs.stream : rs;
  const sStream = ss && ss.stream ? ss.stream : ss;
  const rGrowth = num(Number(flags['react-heap-growth']));
  const sGrowth = num(Number(flags['solid-heap-growth']));

  return [
    row('First painted row (ms)', 'firstPaintedRowMs', num(r.firstPaintedRowMs), num(s.firstPaintedRowMs),
      '< 300 ms', (v) => v < 300),
    row('Scroll frame p50 (ms)', 'sweep.p50', num(r.sweep?.p50), num(s.sweep?.p50), '—', null),
    row('Scroll frame p95 (ms)', 'sweep.p95', num(r.sweep?.p95), num(s.sweep?.p95),
      '≤ 16.7 ms', (v) => v <= 16.7),
    row('Scroll frame max (ms)', 'sweep.max', num(r.sweep?.max), num(s.sweep?.max),
      '≤ 33 ms', (v) => v <= 33),
    row('Sweep long tasks (count)', 'sweep.longTasks.count', num(r.sweep?.longTasks?.count), num(s.sweep?.longTasks?.count), '—', null),
    row('Sweep long task max (ms)', 'sweep.longTasks.maxMs', num(r.sweep?.longTasks?.maxMs), num(s.sweep?.longTasks?.maxMs), '—', null),
    row('Stream dropped frames (%)', 'stream.droppedPct', num(rStream?.droppedPct), num(sStream?.droppedPct), '—', null),
    row('Stream frame p95 (ms)', 'stream.p95', num(rStream?.p95), num(sStream?.p95), '—', null),
    row('Stream long tasks (count)', 'stream.longTasks.count', num(rStream?.longTasks?.count), num(sStream?.longTasks?.count),
      '0', (v) => v === 0),
    row('Stream busy (%)', 'stream.busyPct', num(rStream?.busyPct), num(sStream?.busyPct), '—', null),
    row('Heap after run (MB)', 'heap.usedJSHeapSize', mb(num(r.heap?.usedJSHeapSize)), mb(num(s.heap?.usedJSHeapSize)), '—', null),
    row('Heap growth / 5 min (MB)', '--*-heap-growth', mb(rGrowth), mb(sGrowth),
      '≤ React + 15 %', sGrowth == null || rGrowth == null ? null : () => sGrowth <= rGrowth * (1 + HEAP_TOLERANCE)),
  ];
}

function table(rows) {
  const head = ['Metric', 'Source', 'React', 'Solid', 'Δ', 'Bar (b)', 'Verdict'];
  const body = rows.map((x) => [
    x.label, x.source, fmt(x.react), fmt(x.solid), x.delta, x.bar,
    x.absolute == null ? (x.react == null || x.solid == null ? 'no data' : x.regressed ? 'REGRESSED' : 'ok')
      : `${x.absolute ? 'PASS' : 'FAIL'}${x.regressed ? ' / REGRESSED' : ''}`,
  ]);
  const widths = head.map((_, i) => Math.max(head[i].length, ...body.map((r) => r[i].length)));
  const line = (cells) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  return [line(head), '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|', ...body.map(line)].join('\n');
}

function verdict(rows) {
  const missing = rows.filter((x) => x.react == null || x.solid == null).map((x) => x.label);
  const regressions = rows.filter((x) => x.regressed).map((x) => `${x.label} (${x.delta})`);
  const absoluteFails = rows.filter((x) => x.absolute === false).map((x) => `${x.label} = ${x.solid} (bar ${x.bar})`);
  const gate = regressions.length > 0 ? 'FAIL'
    : absoluteFails.length > 0 ? 'CONDITIONAL PASS'
      : 'PASS';
  return { gate, regressions, absoluteFails, missing };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length !== 2) {
  console.error('usage: node scripts/bench-report.mjs <react.json> <solid.json> [--react-stream f] [--solid-stream f] [--react-heap-growth n] [--solid-heap-growth n] [--json]');
  process.exit(2);
}

const rows = build(positional[0], positional[1], flags);
const result = verdict(rows);

if (flags.json) {
  console.log(JSON.stringify({ rows, ...result }, null, 2));
} else {
  console.log(table(rows));
  console.log('');
  if (result.missing.length) console.log(`No data (not judged): ${result.missing.join(', ')}`);
  if (result.regressions.length) console.log(`(a) regressions > 5 %: ${result.regressions.join(', ')}`);
  if (result.absoluteFails.length) console.log(`(b) absolute misses: ${result.absoluteFails.join(', ')}`);
  console.log(`\nGATE: ${result.gate}`);
  if (result.gate === 'FAIL') console.log('→ plan §C fallback: React 19 + compiler; remove src-solid, keep tokens/bench/backend.');
  if (result.gate === 'CONDITIONAL PASS') console.log('→ plan §C: report the absolute misses to the user and let them decide.');
  console.log('\nRemember scripts/bench.md §6 — a dev-mode comparison run flatters Solid.');
}

process.exit(result.gate === 'FAIL' ? 1 : 0);
