/**
 * Public API of the benchmark module (principle 9).
 *
 * Framework-free: it was installed by both frontends during the bench gate and
 * is reached from `src-solid/` through the `@bench` alias. Nothing here imports
 * a UI framework.
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
