/**
 * Framework-free viewer benchmark harness (plan §C).
 *
 * One module, zero dependencies, no React and no Solid imports — both viewers
 * install the *same* code so the numbers are comparable by construction:
 *   - React: one dev-gated `useEffect` in `src-next/viewport/ReadOnlyViewer.tsx`
 *   - Solid: one `createEffect` in `src-solid/viewer/LogViewer.tsx` (via `@bench`)
 *
 * `installBench()` registers `window.__bench`. Everything else is driven from
 * the WebView console — see `scripts/bench.md` for the gate procedure.
 *
 * Every duration is a `performance.now()` millisecond, rounded to 0.01 ms.
 */

/** Console prefix so a result can be scraped out of the WebView log. */
export const BENCH_PREFIX = 'BENCH_RESULT ';
/** A frame slower than this counts as dropped (plan §C: > 20 ms). */
export const DROPPED_FRAME_MS = 20;
/** Lines advanced per scripted scroll step (plan §C: 200-line steps). */
export const DEFAULT_STEP_LINES = 200;
/** Passive observation window in seconds (plan §C: 60 s streaming). */
export const DEFAULT_STREAM_SECONDS = 60;
/** Give up waiting for the first painted row after this long. */
const FIRST_ROW_TIMEOUT_MS = 30_000;

export interface BenchInstallOptions {
  /** Frontend under test — 'react' or 'solid'. Copied into the result. */
  label: string;
  /** The viewer's scroll container, or null before it mounts. */
  getScrollEl: () => HTMLElement | null;
  /** Authoritative line count (the live/stream total in tail mode). */
  getTotalLines: () => number;
  /** Current row height in px. */
  rowHeight: () => number;
  /** True once at least one row element exists in the DOM. */
  isReady: () => boolean;
}

export interface LongTaskStats {
  /** `PerformanceObserver` longtask entries — by definition every one is > 50 ms. */
  count: number;
  maxMs: number;
  totalMs: number;
  /** False when the browser has no `longtask` entry type (numbers are then 0). */
  supported: boolean;
}

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  durationMs: number;
}

export interface SweepResult extends FrameStats {
  /** Scripted `scrollTop` writes performed (one per rAF), both directions. */
  steps: number;
  stepLines: number;
  longTasks: LongTaskStats;
}

export interface StreamResult extends FrameStats {
  seconds: number;
  /** Frames whose delta exceeded `DROPPED_FRAME_MS`. */
  dropped: number;
  droppedPct: number;
  longTasks: LongTaskStats;
  /** Share of the window spent inside tasks ≥ 50 ms — a lower bound on busy%. */
  busyPct: number;
}

export interface HeapResult {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface BenchResult {
  label: string;
  startedAt: string;
  userAgent: string;
  totalLines: number;
  rowHeight: number;
  /** `markLinePage()` → first rAF with a row in the DOM. Null if never marked. */
  firstPaintedRowMs: number | null;
  sweep: SweepResult | null;
  stream: StreamResult | null;
  /** Null when `performance.memory` is absent (WebView2 gates it behind a flag). */
  heap: HeapResult | null;
}

export interface BenchRunOptions {
  stepLines?: number;
  /** 0 skips the passive window — use it for the file-mode pass. */
  streamSeconds?: number;
}

export interface BenchHandle {
  /** Called by the viewer when the first `LinePage` resolves. First call wins. */
  markLinePage(): void;
  run(opts?: BenchRunOptions): Promise<BenchResult>;
  sweep(stepLines?: number): Promise<SweepResult>;
  streamWindow(seconds?: number): Promise<StreamResult>;
  heap(): HeapResult | null;
  /** The last `run()` result, or null. */
  metrics(): BenchResult | null;
}

declare global {
  interface Window {
    __bench?: BenchHandle;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function frameStats(deltas: readonly number[], durationMs: number): FrameStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    frames: deltas.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted.length === 0 ? 0 : sorted[sorted.length - 1]),
    durationMs: round(durationMs),
  };
}

/** Accumulates `longtask` entries until `stop()`; degrades to zeros if unsupported. */
export function observeLongTasks(): { stop: () => LongTaskStats } {
  let count = 0;
  let maxMs = 0;
  let totalMs = 0;
  const add = (entries: readonly PerformanceEntry[]) => {
    for (const entry of entries) {
      count += 1;
      totalMs += entry.duration;
      if (entry.duration > maxMs) maxMs = entry.duration;
    }
  };
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => add(list.getEntries()));
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    observer = null;
  }
  const supported = observer !== null;
  return {
    stop() {
      try {
        add(observer?.takeRecords() ?? []);
        observer?.disconnect();
      } catch {
        /* the observer is already gone — keep what we collected */
      }
      return { count, maxMs: round(maxMs), totalMs: round(totalMs), supported };
    },
  };
}

/** Scripted `scrollTop` sweep 0 → end → 0, one `stepLines` step per rAF. */
async function runSweep(opts: BenchInstallOptions, stepLines: number): Promise<SweepResult> {
  const el = opts.getScrollEl();
  if (!el) throw new Error('bench: no scroll element');
  const stepPx = Math.max(1, stepLines * Math.max(1, opts.rowHeight()));
  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
  const longTasks = observeLongTasks();
  const deltas: number[] = [];
  el.scrollTop = 0;
  let prev = await nextFrame();
  const started = prev;
  let steps = 0;
  const stepTo = async (top: number) => {
    el.scrollTop = top;
    const now = await nextFrame();
    deltas.push(now - prev);
    prev = now;
    steps += 1;
  };
  for (let top = 0; top <= maxTop; top += stepPx) await stepTo(top);
  for (let top = maxTop; top >= 0; top -= stepPx) await stepTo(top);
  return { ...frameStats(deltas, prev - started), steps, stepLines, longTasks: longTasks.stop() };
}

/** Passive rAF observation — drives nothing, just watches the main thread. */
async function runStreamWindow(seconds: number): Promise<StreamResult> {
  const longTasks = observeLongTasks();
  const deltas: number[] = [];
  let prev = await nextFrame();
  const started = prev;
  const until = started + seconds * 1000;
  while (prev < until) {
    const now = await nextFrame();
    deltas.push(now - prev);
    prev = now;
  }
  const durationMs = prev - started;
  const stats = longTasks.stop();
  const dropped = deltas.filter((d) => d > DROPPED_FRAME_MS).length;
  return {
    ...frameStats(deltas, durationMs),
    seconds,
    dropped,
    droppedPct: round(deltas.length === 0 ? 0 : (dropped / deltas.length) * 100),
    longTasks: stats,
    busyPct: round(durationMs <= 0 ? 0 : (stats.totalMs / durationMs) * 100),
  };
}

function readHeap(): HeapResult | null {
  const memory = (performance as Performance & { memory?: Partial<HeapResult> }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== 'number') return null;
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize ?? 0,
    jsHeapSizeLimit: memory.jsHeapSizeLimit ?? 0,
  };
}

// ── Singleton state ────────────────────────────────────────────────────────
// `installBench` is idempotent: both hooks re-run on every render/effect pass,
// so a repeat call refreshes the options and returns the existing handle.
let current: BenchInstallOptions | null = null;
let handle: BenchHandle | null = null;
let linePageAt: number | null = null;
let firstPaintedRowMs: number | null = null;
let lastResult: BenchResult | null = null;

/** Test-only: drop the singleton so each case starts clean. */
export function __resetBench(): void {
  current = null;
  handle = null;
  linePageAt = null;
  firstPaintedRowMs = null;
  lastResult = null;
  if (typeof window !== 'undefined') delete window.__bench;
}

export function installBench(options: BenchInstallOptions): BenchHandle {
  current = options;
  if (handle) return handle;

  handle = {
    markLinePage() {
      if (linePageAt != null) return;
      const started = performance.now();
      linePageAt = started;
      const poll = () => {
        requestAnimationFrame((now) => {
          if (current?.isReady()) {
            firstPaintedRowMs = round(now - started);
          } else if (now - started < FIRST_ROW_TIMEOUT_MS) {
            poll();
          }
        });
      };
      poll();
    },

    async run(runOpts: BenchRunOptions = {}) {
      const opts = current;
      if (!opts) throw new Error('bench: not installed');
      const streamSeconds = runOpts.streamSeconds ?? DEFAULT_STREAM_SECONDS;
      const result: BenchResult = {
        label: opts.label,
        startedAt: new Date().toISOString(),
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        totalLines: opts.getTotalLines(),
        rowHeight: opts.rowHeight(),
        firstPaintedRowMs,
        sweep: await runSweep(opts, runOpts.stepLines ?? DEFAULT_STEP_LINES),
        stream: streamSeconds > 0 ? await runStreamWindow(streamSeconds) : null,
        heap: readHeap(),
      };
      lastResult = result;
      console.log(BENCH_PREFIX + JSON.stringify(result));
      return result;
    },

    async sweep(stepLines = DEFAULT_STEP_LINES) {
      const opts = current;
      if (!opts) throw new Error('bench: not installed');
      return runSweep(opts, stepLines);
    },

    streamWindow(seconds = DEFAULT_STREAM_SECONDS) {
      return runStreamWindow(seconds);
    },

    heap: readHeap,
    metrics: () => lastResult,
  };

  if (typeof window !== 'undefined') window.__bench = handle;
  return handle;
}
