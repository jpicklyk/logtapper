// @vitest-environment jsdom
/**
 * Tests for the pane-id -> artifact-id handoff used to seed AnalysisReader's
 * initial selection before it mounts (see pendingSelection.ts's module doc
 * for the race this closes: openCenterTab resolves the target pane
 * synchronously, but React doesn't commit the resulting mount/switch-render
 * until after the current task, so a plain `analysis:open` bus event fired
 * immediately after is missed by a reader that doesn't exist yet).
 */
import { describe, it, expect } from 'vitest';
import { setPendingAnalysisSelection, takePendingAnalysisSelection } from './pendingSelection';

describe('pendingAnalysisSelection', () => {
  it('returns null when nothing was seeded for a pane', () => {
    expect(takePendingAnalysisSelection('pane-never-seeded')).toBeNull();
  });

  it('returns the seeded artifact id exactly once, then null', () => {
    setPendingAnalysisSelection('pane-1', 'artifact-A');

    expect(takePendingAnalysisSelection('pane-1')).toBe('artifact-A');
    // Consumed — a second read (e.g. a StrictMode double-invoke of the
    // consuming effect) must not resurrect the same value.
    expect(takePendingAnalysisSelection('pane-1')).toBeNull();
  });

  it('keeps separate panes independent', () => {
    setPendingAnalysisSelection('pane-1', 'artifact-A');
    setPendingAnalysisSelection('pane-2', 'artifact-B');

    expect(takePendingAnalysisSelection('pane-2')).toBe('artifact-B');
    // pane-1's value is untouched by consuming pane-2's.
    expect(takePendingAnalysisSelection('pane-1')).toBe('artifact-A');
  });

  it('a later seed for the same pane overwrites an unconsumed earlier one', () => {
    setPendingAnalysisSelection('pane-1', 'artifact-A');
    setPendingAnalysisSelection('pane-1', 'artifact-B');

    expect(takePendingAnalysisSelection('pane-1')).toBe('artifact-B');
    expect(takePendingAnalysisSelection('pane-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AnalysisReader's resolve-initial-selection effect consumes this module
// destructively (read-and-delete), so a naive StrictMode double-invoke of
// that effect would see the pending value on the first call and null on the
// second — and, without the functional-update guard, the second call's
// "no pending, fall back to auto-select" branch would overwrite the
// already-applied selection with `artifacts[0]`. This reproduces that exact
// effect body (functional-update form) against a fake queued-setState
// processor — the same simulate-StrictMode-double-call technique
// useCenterTree.test.ts uses for L7/L10 — to lock in the fix without
// needing a full component render.
// ---------------------------------------------------------------------------

describe('resolve-initial-selection effect is StrictMode-safe (functional update form)', () => {
  type Update = string | null | ((prev: string | null) => string | null);

  /** Mimics React's setState queue: updates for the same state variable are
   *  applied in order, each seeing the result of the previous one. */
  function applyQueue(initial: string | null, queue: Update[]): string | null {
    let state = initial;
    for (const u of queue) {
      state = typeof u === 'function' ? u(state) : u;
    }
    return state;
  }

  /** The effect body from AnalysisReader, minus the actual setState call —
   *  returns what it WOULD have queued, so both StrictMode invocations can
   *  be composed through `applyQueue` above. */
  function resolveSelectionUpdate(paneId: string, artifacts: string[]): Update {
    const pending = takePendingAnalysisSelection(paneId);
    if (pending !== null) return pending;
    return (prev) => (prev !== null ? prev : (artifacts.length > 0 ? artifacts[0] : null));
  }

  it('a StrictMode double-invoke does not let the auto-select fallback clobber the pending selection', () => {
    setPendingAnalysisSelection('pane-1', 'artifact-clicked');

    // Both invocations run back-to-back against the same pre-effect state
    // (null), exactly as StrictMode's mount -> cleanup -> mount does before
    // any intervening render.
    const call1 = resolveSelectionUpdate('pane-1', ['artifact-newest', 'artifact-older']);
    const call2 = resolveSelectionUpdate('pane-1', ['artifact-newest', 'artifact-older']);

    // First call found the pending value; the (StrictMode-duplicate) second
    // call found it already consumed and queued the auto-select fallback.
    expect(call1).toBe('artifact-clicked');
    expect(typeof call2).toBe('function');

    const finalState = applyQueue(null, [call1, call2]);
    expect(finalState).toBe('artifact-clicked');
  });

  it('with no pending value, a StrictMode double-invoke still converges on the same auto-selected artifact', () => {
    const call1 = resolveSelectionUpdate('pane-never-seeded', ['artifact-newest', 'artifact-older']);
    const call2 = resolveSelectionUpdate('pane-never-seeded', ['artifact-newest', 'artifact-older']);

    const finalState = applyQueue(null, [call1, call2]);
    expect(finalState).toBe('artifact-newest');
  });
});
