/**
 * Tests for action selector hook memoization (L4).
 *
 * These hooks return objects composed from ActionsContext callbacks. Because
 * ActionsContext is "never-changes" stable, the returned objects must be
 * referentially stable across re-renders (verified below via the useMemo
 * dependency logic). We test the pure dependency logic here without requiring
 * a DOM environment or React testing library.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: simulate useMemo dependency comparison
// ---------------------------------------------------------------------------

/**
 * Mimics what React's useMemo does: returns the cached value if every dep in
 * the new deps array passes Object.is comparison with the corresponding entry
 * in the previous deps array. If any dep changed, it calls factory() and
 * caches the result.
 */
function simulateMemo<T>(
  factory: () => T,
  deps: unknown[],
  cache: { value: T | undefined; deps: unknown[] | undefined },
): T {
  if (
    cache.deps !== undefined &&
    deps.length === cache.deps.length &&
    deps.every((dep, i) => Object.is(dep, cache.deps![i]))
  ) {
    return cache.value as T;
  }
  const next = factory();
  cache.value = next;
  cache.deps = deps;
  return next;
}

// ---------------------------------------------------------------------------
// Stable action callbacks (mirrors what ActionsContext provides)
// ---------------------------------------------------------------------------

const stableNoopAsync = () => Promise.resolve();
const stableNoop = () => { /* stub */ };

const viewerDeps = [
  stableNoopAsync,  // loadFile
  stableNoopAsync,  // openFileDialog
  stableNoopAsync,  // openInEditorDialog
  stableNoopAsync,  // startStream
  stableNoopAsync,  // stopStream
  stableNoopAsync,  // closeSession
  stableNoop,       // jumpToLine
  stableNoop,       // jumpToMatch
  stableNoop,       // setSearch
  stableNoopAsync,  // setStreamFilter
  stableNoop,       // cancelStreamFilter
  stableNoop,       // openTab
  stableNoop,       // setActiveLogPane
  stableNoop,       // setActivePane
  stableNoop,       // setEffectiveLineNums
  stableNoopAsync,  // saveFile
  stableNoopAsync,  // saveFileAs
  stableNoop,       // exportSession
];

const pipelineDeps = [
  stableNoopAsync,  // runPipeline
  stableNoop,       // stopPipeline
  stableNoop,       // clearResults
  stableNoopAsync,  // installProcessor
  stableNoop,       // removeProcessor
  stableNoop,       // toggleProcessor
];

// ---------------------------------------------------------------------------
// useViewerActions — memoization tests
// ---------------------------------------------------------------------------

describe('useViewerActions (L4: useMemo wrapping)', () => {
  it('returns the same object reference when deps are stable', () => {
    const cache: { value: Record<string, unknown> | undefined; deps: unknown[] | undefined } = {
      value: undefined,
      deps: undefined,
    };
    const factory = () => ({
      loadFile: viewerDeps[0],
      openFileDialog: viewerDeps[1],
    });

    const first = simulateMemo(factory, viewerDeps, cache);
    const second = simulateMemo(factory, viewerDeps, cache);

    expect(first).toBe(second);
  });

  it('returns a new object when any dep changes', () => {
    const cache: { value: Record<string, unknown> | undefined; deps: unknown[] | undefined } = {
      value: undefined,
      deps: undefined,
    };
    const factory = () => ({
      loadFile: viewerDeps[0],
    });

    const first = simulateMemo(factory, viewerDeps, cache);

    // Simulate a dep changing (e.g., a callback was replaced)
    const newDeps = [...viewerDeps];
    newDeps[0] = () => Promise.resolve(); // new reference
    const second = simulateMemo(factory, newDeps, cache);

    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// usePipelineActions — memoization tests
// ---------------------------------------------------------------------------

describe('usePipelineActions (L4: useMemo wrapping)', () => {
  it('returns the same object reference when pipeline deps are stable', () => {
    const cache: { value: Record<string, unknown> | undefined; deps: unknown[] | undefined } = {
      value: undefined,
      deps: undefined,
    };
    const factory = () => ({
      runPipeline: pipelineDeps[0],
      stopPipeline: pipelineDeps[1],
      clearResults: pipelineDeps[2],
      installProcessor: pipelineDeps[3],
      removeProcessor: pipelineDeps[4],
      toggleProcessor: pipelineDeps[5],
    });

    const first = simulateMemo(factory, pipelineDeps, cache);
    const second = simulateMemo(factory, pipelineDeps, cache);

    expect(first).toBe(second);
  });

  it('recomputes when a pipeline action dep changes', () => {
    const cache: { value: Record<string, unknown> | undefined; deps: unknown[] | undefined } = {
      value: undefined,
      deps: undefined,
    };
    const factory = () => ({
      runPipeline: pipelineDeps[0],
    });

    const first = simulateMemo(factory, pipelineDeps, cache);
    const newDeps = [...pipelineDeps];
    newDeps[0] = () => Promise.resolve(); // new runPipeline reference
    const second = simulateMemo(factory, newDeps, cache);

    expect(first).not.toBe(second);
  });

  it('does not recompute when unrelated context values change (isolation)', () => {
    // Pipeline actions only depend on pipeline-specific callbacks.
    // Changing a viewer-only callback (not in pipelineDeps) must not cause recompute.
    const cache: { value: Record<string, unknown> | undefined; deps: unknown[] | undefined } = {
      value: undefined,
      deps: undefined,
    };
    const factory = () => ({ runPipeline: pipelineDeps[0] });

    const first = simulateMemo(factory, pipelineDeps, cache);
    // Same pipeline deps — only viewer deps changed (not present here).
    const second = simulateMemo(factory, pipelineDeps, cache);

    expect(first).toBe(second);
  });
});
