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
 * pair, not a new capability surface.
 */

/** Schedule `fn` to run once, in a microtask. Calling the returned function
 *  again before that microtask fires is a no-op — the whole burst coalesces
 *  into the single call `fn` was going to make anyway. */
export function coalesceMicrotask(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      fn();
    });
  };
}
