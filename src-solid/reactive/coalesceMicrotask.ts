/**
 * `coalesceMicrotask()` — collapses a synchronous burst of calls into one
 * deferred invocation of `fn`, extracted from
 * `analyses/analysesStore.ts`'s `scheduleListRefresh`: a run of
 * `analysis-update` events delivered in the same tick must trigger exactly
 * one `listAnalyses()` refetch, not one per event.
 *
 * `bookmarks/bookmarksStore.ts` was named alongside `analysesStore.ts` in the
 * task scope as a second call site, but it does not have this shape — its own
 * module doc explains why: a `bookmark-update` payload already carries the
 * full `Bookmark`, so it is applied directly to that session's list with no
 * refetch to coalesce (see `implementation-notes` for this package). Nothing
 * in `bookmarksStore.ts` migrates to this primitive.
 *
 * Returns the schedule function itself (not an object wrapping it) because
 * exactly one operation is needed at the one real call site — this is a
 * drop-in replacement for the local `refreshScheduled` flag + `queueMicrotask`
 * pair, not a new capability surface. `cancel` hangs off that same function
 * (review A-L5) rather than turning it into a `{ schedule, cancel }` pair, so
 * the primitive stays call-site compatible.
 */

/** A coalescing scheduler: call it to schedule, `.cancel()` to disarm. */
export interface CoalescedSchedule {
  (): void;
  /**
   * Drop a pending invocation. A queued microtask that has already been
   * handed to the platform cannot be unqueued, so the flag is what is
   * cleared — the microtask still runs, sees it, and returns without calling
   * `fn`.
   *
   * Call this from the owner's `onCleanup`: without it, a burst scheduled in
   * the last tick before disposal still invokes `fn` afterwards, which is why
   * every caller had to carry its own `disposed` flag to stay safe.
   */
  cancel(): void;
}

/** Schedule `fn` to run once, in a microtask. Calling the returned function
 *  again before that microtask fires is a no-op — the whole burst coalesces
 *  into the single call `fn` was going to make anyway. */
export function coalesceMicrotask(fn: () => void): CoalescedSchedule {
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      if (!scheduled) return;
      scheduled = false;
      fn();
    });
  };
  schedule.cancel = (): void => {
    scheduled = false;
  };
  return schedule;
}
