/**
 * Public API of the benchmark module (principle 9).
 *
 * Framework-free: importable from both `src-next/` (React) and `src-solid/`
 * (Solid, via the `@bench` alias). Nothing here imports a UI framework.
 */
export {
  installBench,
  BENCH_PREFIX,
  DROPPED_FRAME_MS,
  DEFAULT_STEP_LINES,
  DEFAULT_STREAM_SECONDS,
} from './harness';

export type {
  BenchInstallOptions,
  BenchRunOptions,
  BenchHandle,
  BenchResult,
  SweepResult,
  StreamResult,
  FrameStats,
  LongTaskStats,
  HeapResult,
} from './harness';
