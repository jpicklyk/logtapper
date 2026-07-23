/**
 * Reference-counted suppression for workspace auto-save.
 *
 * Auto-save fires on `workspace:mutated`. Restore paths legitimately produce a
 * burst of those events — every `loadFile` during a workspace open is a tracked
 * mutation — but persisting during a restore is wrong twice over: it rewrites
 * what was just read, and if the restore only partially succeeded it overwrites
 * the good `.ltw` with the partial state.
 *
 * Counting rather than a boolean because restores can overlap: a workspace open
 * can trigger a nested `.lts` import, and a boolean would let the inner one's
 * completion re-enable saving while the outer restore is still running.
 */
export interface AutoSaveGate {
  /** Enter a restore. Safe to nest. */
  beginRestore(): void;
  /** Leave a restore. Never drops below zero, so a stray end cannot enable
   *  saving mid-restore. */
  endRestore(): void;
  /** True while any restore is in flight. */
  isSuppressed(): boolean;
  /** Current nesting depth — exposed for assertions and diagnostics. */
  depth(): number;
  /** Force-clear all suppression. For teardown only; a missed `endRestore`
   *  would otherwise disable auto-save for the rest of the session. */
  reset(): void;
}

export function createAutoSaveGate(): AutoSaveGate {
  let depth = 0;
  return {
    beginRestore() {
      depth += 1;
    },
    endRestore() {
      depth = Math.max(0, depth - 1);
    },
    isSuppressed() {
      return depth > 0;
    },
    depth() {
      return depth;
    },
    reset() {
      depth = 0;
    },
  };
}
