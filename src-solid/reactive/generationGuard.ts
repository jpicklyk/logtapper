/**
 * `createGenerationGuard()` — the "supersede in-flight async work" pattern
 * extracted from the five shapes the 2b root review catalogued:
 *
 *  - `analyzers/analyzerStore.ts`'s `run()`: bump before starting a pipeline
 *    run, guard the two points that write `result`/`lastError` back.
 *  - `devicestate/deviceStateStore.ts`'s per-session snapshot fetch: bump
 *    before scheduling the debounced `getStateAtLine`, guard the resolve and
 *    reject handlers (the debounce timer itself stays local to the store —
 *    it is a `setTimeout` handle, not a generation concept).
 *  - `devicestate/deviceStateStore.ts`'s per-(session, tracker) transition
 *    fetch: same bump-then-guard shape around `getStateTransitions`, distinct
 *    from the snapshot guard above because it lives on a different runtime
 *    object with its own lifetime.
 *  - `query/filterScan.ts`'s `this.gen`: bump on every `setExpression`,
 *    `cancel()` and `dispose()`; guard every checkpoint in the backend and
 *    fallback scan loops before touching reactive state.
 *  - `viewer/cacheBinding.ts`'s `fetchGen`: bumped only on a data-source swap
 *    or a view-revision change (not on every fetch attempt — a fetch merely
 *    *captures* the current generation via {@link GenerationGuard.current}
 *    and checks it again after the await).
 *
 * All five reduce to the same three operations: advance a counter, read it,
 * and ask "is this token I captured earlier still the current one?". A
 * `false` answer means a newer bump superseded the token's caller — its
 * result must be discarded, never applied, because a *slower* older call can
 * otherwise resolve *after* a faster newer one and clobber it with stale data
 * (the out-of-order-completion case every call site above guards against).
 *
 * Deliberately NOT part of this primitive: per-generation *caching*
 * (`analyzerStore`'s `RunCache`, `deviceStateStore`'s `snapshotCache` and
 * `TrackerRuntime.fetchedGeneration`) — each keys a differently-shaped cache
 * (a `Map` of promises, a single cached snapshot, a bare number comparison)
 * off a generation value, but the comparison itself is a plain `===`, not a
 * guard against out-of-order completion. Folding that into this primitive
 * would mean inventing a generic cache shape none of the four call sites
 * actually share.
 *
 * Not reactive on purpose: nothing in any of the five call sites reads a
 * generation number from a `createMemo` or JSX — it is bookkeeping consulted
 * from imperative code (a `.then`/`.catch` callback, a loop body), so a plain
 * mutable counter is correct and cheaper than a signal. If a future caller
 * needs to *render* the current generation, wrap `.current()` in a signal at
 * that call site rather than making every existing caller pay for one.
 */

export interface GenerationGuard {
  /** The current generation number. Starts at 0, before any `bump()`. */
  current(): number;
  /**
   * Advance to a new generation and return its token. Every token captured
   * before this call — via a prior `bump()` or `current()` — stops being
   * current as of this call.
   */
  bump(): number;
  /**
   * `true` when `token` is still the current generation. `false` means a
   * later `bump()` superseded it: discard whatever async work produced this
   * token's result rather than applying it.
   */
  isCurrent(token: number): boolean;
}

export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return {
    current: () => generation,
    bump: () => ++generation,
    isCurrent: (token: number) => token === generation,
  };
}
