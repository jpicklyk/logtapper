/**
 * Module-scope registry of in-flight `loadFile` promises.
 *
 * The pre-switch workspace auto-save (`doAutoSave` in `useWorkspace.ts`)
 * builds its manifest from backend `AppState::sessions` — a file whose
 * `load_log_file` IPC call hasn't resolved yet is registered nowhere on
 * either side yet, so a save that races an in-flight load silently drops
 * that file from the saved `.ltw`. `useFileSession.loadFile` registers a
 * promise here for the lifetime of each load (resolved in its `finally`,
 * covering both the success and the stale-discard path); `doAutoSave` awaits
 * `waitForPendingLoads()` before building its save payload so any load that
 * was in flight at switch time gets a chance to land in `state.sessions`
 * first.
 *
 * Module-scope for the same reason as `workspaceEpoch.ts` — `useFileSession`
 * (registers) and `useWorkspace` (awaits) are sibling hooks with no shared
 * ref to thread the registry through.
 *
 * Bounded wait: a hung load (e.g. a stalled decompress on a huge bugreport)
 * must never block a workspace switch indefinitely — `waitForPendingLoads`
 * races the settle against a timeout and proceeds regardless.
 */

const pending = new Map<string, Promise<unknown>>();

/** Register an in-flight load under `id`. Self-removes once `promise`
 *  settles (success or failure) so a rejected/discarded load never wedges
 *  the registry. */
export function registerPendingLoad(id: string, promise: Promise<unknown>): void {
  pending.set(id, promise);
  // Observe settlement via `Promise.allSettled` rather than `promise.finally`
  // directly — `.finally()` returns a new promise that still rejects when
  // `promise` does, and nothing here consumes that derived promise, which
  // trips "unhandled rejection" for a load whose own rejection the *caller*
  // already handles perfectly well (loadFile's try/catch). `allSettled`
  // never rejects, so this observer can't itself become a second unhandled
  // rejection for the same failure.
  Promise.allSettled([promise]).then(() => {
    // Only delete if this is still the entry we registered — a caller could
    // in principle reuse the same id for a later load before this one's
    // settlement observer runs (not expected in practice, since ids are
    // derived from a fresh generation counter per load, but guarding costs
    // nothing).
    if (pending.get(id) === promise) pending.delete(id);
  });
}

/** Snapshot of all currently in-flight load promises. */
export function getPendingLoads(): Promise<unknown>[] {
  return [...pending.values()];
}

const DEFAULT_TIMEOUT_MS = 8000;

/** Await every load in flight right now, bounded by `timeoutMs` so a hung
 *  load can't block the caller forever. Loads that reject are tolerated
 *  (settled, not thrown) — a failed load has nothing to save regardless. */
export async function waitForPendingLoads(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  const loads = getPendingLoads();
  if (loads.length === 0) return;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([Promise.allSettled(loads).then(() => {}), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
