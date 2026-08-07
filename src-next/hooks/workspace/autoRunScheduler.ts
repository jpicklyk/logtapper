/**
 * Deciding *when* to auto-run the pipeline for a restored session (design:
 * `plans/workspace-restore-design.md` §Q2, "auto-run stops being event-sniffed";
 * extended for the `.lts`-path fix).
 *
 * The bug this replaces: on the `.ltw` path the pipeline auto-run never fired for
 * a file that arrived already indexed. `restore_workspace_session` resolves after
 * every `loadFile` await, but `session:loaded` fires *synchronously inside*
 * `loadFile` (mitt has no replay), so the old fallback handler subscribed after
 * the event it waited for. For a file under the 1 MB initial chunk
 * `session:indexing-complete` never fires either, so both paths to the run were
 * closed. Not a size threshold — a restore-ordering bug.
 *
 * Two callers share this one scheduler, keyed by the `workspace-restored`
 * `source` tag so a session is scheduled exactly once:
 *  - the `.ltw` restore core, after each `restore_workspace_session` resolves
 *    (`source: "workspace"`), for non-`.lts` sessions;
 *  - `useWorkspaceRestore`, on a `source: "lts"` emission, for `.lts`-backed
 *    sessions (direct opens and `.lts` embedded in a `.ltw`).
 *
 * Decision: if the session is already fully indexed, run now; otherwise arm a
 * *session-id-keyed* one-shot on `session:indexing-complete` (targeted, per
 * frontend principle #6).
 *
 * The run is handed the session's *restored* chain explicitly rather than reading
 * the global `pipelineChainRef`: `chain:restore` only updates that ref on the
 * next render, which has not happened yet when the run-now path fires. Passing
 * the chain the restore already carries removes the timing dependency and is also
 * more correct for a multi-session workspace, where each session gets its own
 * chain instead of whichever `chain:restore` landed last.
 *
 * Strict one-shot per session id: a duplicate `schedule` for an id that already
 * ran or is already armed is swallowed (belt-and-suspenders against the two
 * callers overlapping on a `.lts`-backed session). `forget` (wired to
 * `session:closed`) clears that record so reopening the same file — including
 * under Q5's deterministic, recurring ids — schedules again.
 *
 * Pure decision + a small bookkeeping object so it can be unit-tested with a fake
 * bus (mirrors `tabSessionMap.test.ts` style).
 *
 * Burst cap (workspace-restore-performance design, part 5): a workspace with
 * several restored sessions can have several `run-now` decisions (or several
 * `session:indexing-complete` firings) land in the same tick, each kicking
 * off a pipeline run against a still-warming cache and competing with
 * whatever background indexers are still running for the same sessions. At
 * most `RUN_CONCURRENCY_LIMIT` runs are allowed in flight at once; the rest
 * queue (FIFO) and start as a running one finishes. This only throttles HOW
 * MANY runs execute simultaneously — every session is still scheduled (run
 * now or armed) synchronously inside `schedule()`, exactly as before, so
 * `isScheduled`/`isPending` and the one-shot swallow guard are unaffected. A
 * workspace with a single restored session never queues (its one run starts
 * immediately), so single-file opens see no behavior change.
 */

export type AutoRunDecision = 'run-now' | 'await-indexing';

/** Max pipeline auto-runs allowed in flight at once, post-restore. */
const RUN_CONCURRENCY_LIMIT = 2;

/**
 * A session that is not indexing is fully loaded — run immediately. Otherwise the
 * run must wait for `session:indexing-complete`. `undefined` (no `isIndexing`
 * carried) is treated as "not indexing": a fully-loaded source (streams, `.lts`
 * entries), matching the prior fallback.
 */
export function decideAutoRun(isIndexing: boolean | undefined): AutoRunDecision {
  return isIndexing ? 'await-indexing' : 'run-now';
}

/** The minimal bus surface the scheduler needs (so tests can pass a fake). */
export interface IndexingCompleteBus {
  on(event: 'session:indexing-complete', handler: (e: { sessionId: string }) => void): void;
  off(event: 'session:indexing-complete', handler: (e: { sessionId: string }) => void): void;
}

/** Runs the pipeline for a restored session with its restored chain. May
 *  return a promise the scheduler awaits to know when the run has finished
 *  (freeing its concurrency slot); a synchronous implementation (as in
 *  existing tests) is also accepted — its slot frees on the next microtask. */
export type AutoRunFn = (sessionId: string, chain: string[], disabled: string[]) => void | Promise<void>;

export interface AutoRunScheduler {
  /** Decide and act for one restored session. Runs now or arms a one-shot that
   *  fires on this session's `session:indexing-complete`. A duplicate call for a
   *  session already scheduled (ran or armed) is swallowed. */
  schedule(sessionId: string, isIndexing: boolean | undefined, chain: string[], disabled: string[]): void;
  /** Drop all record of a session (arms + the "already scheduled" mark) so a
   *  future reopen schedules again. Wire to `session:closed`. */
  forget(sessionId: string): void;
  /** Whether a session is currently waiting on indexing-complete. */
  isPending(sessionId: string): boolean;
  /** Whether a session has been scheduled (ran or armed) and not yet forgotten. */
  isScheduled(sessionId: string): boolean;
  /** Number of armed one-shots (diagnostics / assertions). */
  pendingCount(): number;
  /** Remove every armed one-shot and clear all records. For teardown on unmount. */
  dispose(): void;
}

export function createAutoRunScheduler(bus: IndexingCompleteBus, run: AutoRunFn): AutoRunScheduler {
  const pending = new Map<string, (e: { sessionId: string }) => void>();
  // Sessions scheduled this lifetime (ran-now or armed); the swallow guard.
  const scheduled = new Set<string>();

  // --- Run-concurrency gate (part 5) ---
  let runningCount = 0;
  // Head-index dequeue instead of `Array.shift()` (O(n) per call, since every
  // remaining element shifts down) — `queueHead` advances instead. Reset back
  // to an empty array once fully drained so the backing array doesn't grow
  // across the scheduler's whole lifetime (many workspace restores can share
  // one scheduler instance).
  const runQueue: Array<{ sessionId: string; chain: string[]; disabled: string[] }> = [];
  let queueHead = 0;

  const startNext = (): void => {
    while (runningCount < RUN_CONCURRENCY_LIMIT && queueHead < runQueue.length) {
      const next = runQueue[queueHead++]!;
      runningCount++;
      // `run` may be sync (existing tests) or async (the real pipeline.run) —
      // Promise.resolve() normalizes both so the slot frees exactly once,
      // whether it settles on this microtask or a later one.
      Promise.resolve(run(next.sessionId, next.chain, next.disabled))
        .catch((e: unknown) => { console.warn('[autoRunScheduler] run failed:', e); })
        .finally(() => {
          runningCount--;
          startNext();
        });
    }
    if (queueHead > 0 && queueHead === runQueue.length) {
      runQueue.length = 0;
      queueHead = 0;
    }
  };

  /** Enter the concurrency gate — starts immediately if a slot is free,
   *  otherwise queues (FIFO) and starts when one frees. */
  const runOrQueue = (sessionId: string, chain: string[], disabled: string[]): void => {
    runQueue.push({ sessionId, chain, disabled });
    startNext();
  };

  const disarm = (sessionId: string) => {
    const existing = pending.get(sessionId);
    if (existing) {
      bus.off('session:indexing-complete', existing);
      pending.delete(sessionId);
    }
  };

  return {
    schedule(sessionId, isIndexing, chain, disabled) {
      // Strict one-shot per session id — a second caller for a `.lts`-backed
      // session (routing should prevent it, but guarded) is swallowed so the
      // pipeline never runs twice.
      if (scheduled.has(sessionId)) return;
      scheduled.add(sessionId);

      if (decideAutoRun(isIndexing) === 'run-now') {
        runOrQueue(sessionId, chain, disabled);
        return;
      }

      const handler = (e: { sessionId: string }) => {
        if (e.sessionId !== sessionId) return;
        disarm(sessionId);
        runOrQueue(sessionId, chain, disabled);
      };
      pending.set(sessionId, handler);
      bus.on('session:indexing-complete', handler);
    },
    forget(sessionId) {
      disarm(sessionId);
      scheduled.delete(sessionId);
    },
    isPending(sessionId) {
      return pending.has(sessionId);
    },
    isScheduled(sessionId) {
      return scheduled.has(sessionId);
    },
    pendingCount() {
      return pending.size;
    },
    dispose() {
      for (const handler of pending.values()) {
        bus.off('session:indexing-complete', handler);
      }
      pending.clear();
      scheduled.clear();
      // Drop anything not yet started. Runs already in flight (runningCount
      // > 0) are left to finish on their own — their `.finally` still calls
      // `startNext()`, which is a no-op once the queue is empty.
      runQueue.length = 0;
      queueHead = 0;
    },
  };
}
