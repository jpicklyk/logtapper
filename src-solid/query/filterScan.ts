/**
 * `FilterScan` — the filter-expression scan engine, ported from React's
 * `src-next/hooks/useLogViewer/useFilterScan.ts`.
 *
 * Everything load-bearing in the original is carried over verbatim:
 *
 * - the **generation counter**: a superseded scan's late progress events and
 *   late page fetches are dropped, and its backend filter is cancelled + closed;
 * - the **serialized handler chain**: `filter-progress` arrives faster than one
 *   `getFilteredLines` round-trip on large files, and each handler run awaits
 *   its page before advancing `lastFetched` — interleaved runs would read a
 *   stale `lastFetched` and fetch overlapping pages (duplicate, out-of-order
 *   matches). Runs are therefore serialized on one promise chain;
 * - the **`needsJsPass` second pass**, re-validating each backend candidate page
 *   with `matchesFilter` when the extracted criteria is only a superset;
 * - the **full-JS fallback** for expressions the backend cannot reduce at all
 *   (top-level NOT, `tid:`, heterogeneous ORs), which fetches through `getLines`
 *   windows — reading `LogSource` directly, including lines a stream has spilled
 *   to disk. It never reads the render cache, which only holds the LRU window.
 *
 * As of L4, `currentFilter()` and `appendMatches()` let a live stream
 * (`createStreamSession`, `src-solid/stream/`) report matches for newly
 * arrived batches — lines beyond the scan's own snapshot, which the scan
 * itself never sees. Both are additive: nothing about post-mortem filtering
 * changes when no caller ever invokes them.
 *
 * ## Ownership
 *
 * All reactive state lives under a `createRoot` this instance owns, so a
 * `FilterScan` may be constructed outside a component body. The **caller owns
 * the instance**: it must call `dispose()` (typically from `onCleanup`), which
 * cancels any scan in flight, unregisters the progress listener, and tears the
 * root down. Nothing here touches the viewer controller — W2b reads `lines()`
 * and forwards it with `controller.setLineSet(sessionId, 'filter', lines)`.
 */
import { batch, createRoot, createSignal, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { FilterParseError, matchesFilter, parseFilter, extractPackageNames } from '@filter/index';
import type { FilterNode } from '@filter/index';
import type { onFilterProgress } from '@bridge/events';
import type {
  FilterCreateResult,
  FilterCriteria,
  FilteredLinesResult,
  LinePage,
  LineRequest,
  ViewLine,
} from '@bridge/types';
import { buildBackendFilter } from './backendFilter';
import { createGenerationGuard } from '../reactive';
import type { GenerationGuard } from '../reactive';

export type FilterScanPhase = 'idle' | 'parsing' | 'scanning' | 'done' | 'error';

/** The subset of `@bridge/commands` a scan needs. Injected so tests can log calls. */
export interface FilterScanCommands {
  createFilter(sessionId: string, criteria: FilterCriteria): Promise<FilterCreateResult>;
  getFilteredLines(filterId: string, offset: number, count: number): Promise<FilteredLinesResult>;
  cancelFilter(filterId: string): Promise<void>;
  closeFilter(filterId: string): Promise<void>;
  getLines(request: LineRequest): Promise<LinePage>;
}

export interface FilterScanDeps {
  commands: FilterScanCommands;
  /** `onFilterProgress` in the app; a fake the test can emit through in tests. */
  listen: typeof onFilterProgress;
  /** Window size for the full-JS fallback's `getLines` reads. */
  pageSize?: number;
  /**
   * Resolve `package:` names to PIDs (ADB only). Absent — the app's file mode —
   * leaves the map empty, exactly like React with no stream device serial: a
   * `package:` atom then matches nothing.
   */
  resolvePackagePids?: (names: string[]) => Promise<Map<string, number[]>>;
}

/** Default `getLines` window for the fallback scan. Matches React's `BATCH`. */
export const DEFAULT_PAGE_SIZE = 20_000;

/**
 * The backend's own per-request cap on `get_filtered_lines`:
 * `filter.get_page(offset, count.min(MAX_LINES_PAGE))` with
 * `MAX_LINES_PAGE = 1_000` (`src-tauri/src/services/filters.rs`). A single
 * request can therefore never satisfy a progress tick that reports more new
 * matches than this, which is why `handleProgress` pages in a loop and
 * advances by what each page actually returned.
 */
export const MAX_FILTERED_PAGE = 1_000;

/** Fallback scan flushes to `lines()` every N windows (~60K lines). React's `FLUSH_EVERY`. */
const FLUSH_EVERY = 3;

export class FilterScan {
  /** `'parsing'` → `'scanning'` → `'done'`; `'error'` for a parse or create rejection. */
  readonly phase: Accessor<FilterScanPhase>;
  /** Confirmed matches so far — the size `lines()` would have if read now. */
  readonly matched: Accessor<number>;
  /** Lines in the source being scanned (the backend's snapshot at create time). */
  readonly total: Accessor<number>;
  /** A backend rejection (e.g. an invalid regex refused by `create_filter`). */
  readonly error: Accessor<string | null>;
  /** A `FilterParseError` from the expression itself. */
  readonly parseError: Accessor<string | null>;
  /**
   * The matched set. `null` = no filter active (render everything).
   *
   * Read-only to consumers, and **not** to be retained: a non-null value is
   * the current generation's live `merged` Set, mutated in place and
   * republished as matches arrive (M9), so a stored reference keeps changing
   * under whoever holds it. Copy what you need (`controller.setLineSet`
   * already materialises its own ascending array). The signal is declared
   * `equals: false` for exactly this reason — the reference does not change
   * between flushes, the contents do.
   */
  readonly lines: Accessor<Set<number> | null>;

  private readonly setPhase: (v: FilterScanPhase) => void;
  private readonly setMatched: (v: number) => void;
  private readonly setTotal: (v: number) => void;
  private readonly setError: (v: string | null) => void;
  private readonly setParseError: (v: string | null) => void;
  private readonly setLines: (v: Set<number> | null) => void;
  private readonly disposeRoot: () => void;

  private readonly deps: FilterScanDeps;
  private readonly pageSize: number;

  /** Bumped by every `setExpression`, `cancel` and `dispose`. */
  private readonly guard: GenerationGuard = createGenerationGuard();
  private activeFilterId: string | null = null;
  private unlisten: (() => void) | null = null;
  /** Resolved `package:` → pids, cached across expressions like React's ref. */
  private readonly packagePids = new Map<string, number[]>();
  private disposed = false;

  /**
   * The AST currently committed for matching, exposed read-only via
   * {@link currentFilter}. Mirrors React's `filterAstRef`: set synchronously
   * the moment `setExpression` finishes parsing — *before* the `await` for
   * package-pid resolution — and reset to `null` for every other outcome
   * (empty expression, parse error, `cancel`, `dispose`). `null` means "no
   * filter active"; a live batch matcher (`createStreamSession`) must treat
   * that as "nothing to match against", not "match everything".
   */
  private committedAst: FilterNode | null = null;
  /**
   * The active generation's matched line numbers — the scan's own confirmed
   * matches *and* whatever `appendMatches` reported for live batches, in one
   * membership `Set` that is **mutated in place** and republished by
   * `flush()` (M9). It replaced a `scanMatches`/`liveMatches` array pair that
   * `flush()` re-unioned into a brand-new `Set` on every call: with a broad
   * filter on a busy capture (200k matches, a batch every ~50 ms) that copied
   * every match into a fresh `Set` twenty times a second. Appending is now
   * O(new lines).
   *
   * Replaced by a **fresh** `Set` (never cleared in place — a consumer may
   * still hold the previous instance) at the top of every `setExpression`,
   * `cancel` and `dispose`, synchronously and before any `await`, same moment
   * as `committedAst`. That ordering is what stops a stale live batch from
   * resurrecting a superseded expression's results: by the time a new
   * generation's scan can publish anything, this Set has already been
   * replaced for it.
   */
  private merged = new Set<number>();

  constructor(deps: FilterScanDeps) {
    this.deps = deps;
    this.pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;

    const state = createRoot((disposeRoot) => {
      const [phase, setPhase] = createSignal<FilterScanPhase>('idle');
      const [matched, setMatched] = createSignal(0);
      const [total, setTotal] = createSignal(0);
      const [error, setError] = createSignal<string | null>(null);
      const [parseError, setParseError] = createSignal<string | null>(null);
      // `equals: false`: `flush()` republishes the *same* mutated Set (M9), so
      // reference equality would swallow every update after the first.
      const [lines, setLines] = createSignal<Set<number> | null>(null, { equals: false });
      return {
        phase, setPhase, matched, setMatched, total, setTotal,
        error, setError, parseError, setParseError, lines, setLines,
        disposeRoot,
      };
    });

    this.phase = state.phase;
    this.matched = state.matched;
    this.total = state.total;
    this.error = state.error;
    this.parseError = state.parseError;
    this.lines = state.lines;
    this.setPhase = state.setPhase;
    this.setMatched = state.setMatched;
    this.setTotal = state.setTotal;
    this.setError = state.setError;
    this.setParseError = state.setParseError;
    this.setLines = state.setLines;
    this.disposeRoot = state.disposeRoot;
  }

  /**
   * Scan `sessionId` for `expr`. Supersedes any scan already running — the old
   * one's backend filter is cancelled and closed, and its late events ignored.
   * An empty or null expression is the fast path: everything clears, nothing is
   * scanned.
   */
  async setExpression(sessionId: string, expr: string | null): Promise<void> {
    const gen = this.guard.bump();
    // New generation: discard whatever the previous expression committed and
    // whatever live batches appended for it, synchronously and before any
    // `await` below — see the fields' own doc comments for why the ordering
    // matters.
    this.committedAst = null;
    this.merged = new Set();

    if (!expr || !expr.trim()) {
      this.teardownBackendFilter();
      this.clearState('idle');
      return;
    }

    this.setPhase('parsing');

    let ast: FilterNode | null;
    try {
      ast = parseFilter(expr);
    } catch (e) {
      this.teardownBackendFilter();
      batch(() => {
        this.clearLines();
        this.setMatched(0);
        this.setError(null);
        this.setParseError(e instanceof FilterParseError ? e.message : String(e));
        this.setPhase('error');
      });
      return;
    }

    // A whitespace-only or comment-only expression parses to nothing to do.
    if (!ast) {
      this.teardownBackendFilter();
      this.clearState('idle');
      return;
    }

    // Committed synchronously here — before the pid-resolution `await` below
    // — so a live batch that arrives mid-resolution already matches against
    // the new expression instead of a stale one. Mirrors React's
    // `filterAstRef.current = ast` (set before its own `await Promise.all(…)`
    // for the same reason).
    this.committedAst = ast;

    if (this.deps.resolvePackagePids) {
      const unresolved = extractPackageNames(ast).filter((p) => !this.packagePids.has(p));
      if (unresolved.length > 0) {
        try {
          const resolved = await this.deps.resolvePackagePids(unresolved);
          for (const [pkg, pids] of resolved) this.packagePids.set(pkg, pids);
        } catch {
          for (const pkg of unresolved) this.packagePids.set(pkg, []);
        }
        if (!this.guard.isCurrent(gen)) return;
      }
    }

    // Cancel any previous backend filter before starting a new one.
    this.teardownBackendFilter();
    batch(() => {
      this.setError(null);
      this.setParseError(null);
      this.setMatched(0);
      this.setPhase('scanning');
    });

    // Extract the tightest backend pre-filter from the AST. This is always a
    // superset: the backend narrows the candidate pool, then JS applies the
    // full expression to confirm matches.
    //
    //   level:E                → backend exact (needsJsPass=false)
    //   level:E tag:Activity   → backend filters to error lines only, JS checks tag
    //   tid:7                  → null → full JS scan (backend can't help)
    //   !level:E               → null → full JS scan (NOT can't be a superset)
    const backendFilter = buildBackendFilter(ast);

    if (backendFilter) {
      await this.runBackendScan(sessionId, gen, ast, backendFilter.criteria, backendFilter.needsJsPass);
    } else {
      await this.runFallbackScan(sessionId, gen, ast);
    }
  }

  /** Stop the running scan and clear results. The stored expression is the caller's. */
  cancel(): void {
    this.guard.bump();
    this.committedAst = null;
    this.merged = new Set();
    this.teardownBackendFilter();
    this.clearState('idle');
  }

  /** Cancel, then tear down the reactive root. The instance is unusable after this. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.guard.bump();
    this.committedAst = null;
    this.merged = new Set();
    this.teardownBackendFilter();
    this.disposeRoot();
  }

  // ── Live incremental matching (L4) ──────────────────────────────────────

  /**
   * The filter currently committed for matching, and its resolved
   * `package:` → pids — read fresh by `createStreamSession.handleBatch` on
   * every arriving live batch (mirrors React's `filterAstRef.current` /
   * `packagePidsRef.current`). `ast` is `null` when no filter is active:
   * idle, cleared, a parse/backend error, or momentarily while a *new*
   * expression is still resolving package pids for its first scan (during
   * which `ast` is already the new one — see `setExpression`). Not a Solid
   * signal: nothing renders directly off it, it is only ever read
   * imperatively from an event handler, same as the React ref it replaces.
   */
  currentFilter(): { ast: FilterNode | null; packagePids: Map<string, number[]> } {
    return { ast: this.committedAst, packagePids: this.packagePids };
  }

  /**
   * Append line numbers a live batch matched against `currentFilter().ast`
   * to the active scan's results. Routed through `flush()` — the exact merge
   * the scan's own progress/completion events use — rather than writing a
   * second `setLines`/`setMatched` pair that could drift from it.
   *
   * A no-op when there is no committed filter (`currentFilter().ast` is
   * `null`): a live batch matched against an expression that has since been
   * cleared, cancelled or superseded has nothing left to append to.
   * `committedAst` and `merged` are both reset to their new generation's
   * values synchronously, before any `await`, at the top of every
   * `setExpression`/`cancel`/`dispose` call — so by the time a call here
   * could be "for the old expression", `currentFilter().ast` has already
   * moved on (or gone `null`) and `merged` has already been replaced for the
   * new generation. A late call therefore either targets the generation that
   * is current right now, or is silently dropped — it can never resurrect
   * results into a scan that superseded it.
   */
  appendMatches(lineNums: number[]): void {
    if (lineNums.length === 0 || this.committedAst === null) return;
    for (const lineNum of lineNums) this.merged.add(lineNum);
    this.flush();
  }

  // ── Backend scan ────────────────────────────────────────────────────────

  private async runBackendScan(
    sessionId: string,
    gen: number,
    ast: FilterNode,
    criteria: FilterCriteria,
    needsJsPass: boolean,
  ): Promise<void> {
    const { commands } = this.deps;

    let created: FilterCreateResult;
    try {
      created = await commands.createFilter(sessionId, criteria);
    } catch (e) {
      // The backend rejects an invalid regex at create time. Surface it next to
      // the parse errors — a rejection the user can't see is no better than the
      // silent zero-match scan it replaced.
      if (!this.guard.isCurrent(gen)) return;
      // No filter ends up active for this generation — clear the committed AST
      // too, not just the displayed lines, so a live batch arriving after this
      // rejection has nothing to match against (see `currentFilter()`'s
      // contract: `null` on any parse/backend error, not just while idle).
      this.committedAst = null;
      this.merged = new Set();
      batch(() => {
        this.clearLines();
        this.setMatched(0);
        this.setError(e instanceof Error ? e.message : String(e));
        this.setPhase('error');
      });
      return;
    }

    if (!this.guard.isCurrent(gen)) {
      commands.cancelFilter(created.filterId).catch(() => {});
      commands.closeFilter(created.filterId).catch(() => {});
      return;
    }

    const filterId = created.filterId;
    this.activeFilterId = filterId;
    this.setTotal(created.totalLines);

    let lastFetched = 0;
    let listenerDone = false;
    let unlisten: (() => void) | null = null;
    let handlerChain: Promise<void> = Promise.resolve();

    const handleProgress = async (progress: { filterId: string; matchedSoFar: number; done: boolean }) => {
      if (listenerDone || progress.filterId !== filterId) return;
      if (!this.guard.isCurrent(gen)) {
        listenerDone = true;
        commands.cancelFilter(filterId).catch(() => {});
        commands.closeFilter(filterId).catch(() => {});
        unlisten?.();
        return;
      }

      // One request can only ever return `MAX_FILTERED_PAGE` lines (the
      // backend caps it — see that constant), while a progress tick fires
      // every 50 000 scanned lines and can report far more new matches than
      // that. Page in a loop until `lastFetched` has caught up, advancing by
      // what each page **actually returned**, never by what was asked for:
      // advancing by the asked-for count is H1, which silently dropped every
      // match past the first 1000 of each tick (any filter with a >2% hit
      // rate) while still reporting `phase 'done'`.
      while (lastFetched < progress.matchedSoFar) {
        const want = Math.min(progress.matchedSoFar - lastFetched, MAX_FILTERED_PAGE);
        let page: FilteredLinesResult;
        try {
          page = await commands.getFilteredLines(filterId, lastFetched, want);
        } catch {
          // Transient fetch error. `lastFetched` stays put, so the next
          // progress event refetches this same offset — except on the final
          // event, which has no next one: that case is reported below.
          break;
        }
        if (listenerDone || !this.guard.isCurrent(gen)) return;
        // A short (or empty) page means the backend has nothing more to give
        // for this offset right now; stop rather than spin on it.
        if (page.lines.length === 0) break;
        lastFetched += page.lines.length;

        // JS second pass: only needed when the backend criteria is a superset
        // (e.g. backend filtered by level:E but the user also wants
        // tag:Activity — JS confirms the tag). It narrows what is *kept*, not
        // how far the backend's own match cursor advanced.
        const confirmed = needsJsPass
          ? page.lines.filter((line: ViewLine) => matchesFilter(ast, line, this.packagePids))
          : page.lines;

        if (confirmed.length > 0) {
          for (const line of confirmed) this.merged.add(line.lineNum);
          this.flush();
        }
      }

      if (progress.done) {
        listenerDone = true;
        if (this.activeFilterId === filterId) this.activeFilterId = null;
        commands.closeFilter(filterId).catch(() => {});
        unlisten?.();
        if (this.unlisten === unlisten) this.unlisten = null;
        // L10: the final page fetch has no later progress event to retry it,
        // so a failure (or a short page) here means the result is missing
        // matches. Say so instead of reporting a clean `done` over a
        // silently truncated set.
        const missing = progress.matchedSoFar - lastFetched;
        if (this.guard.isCurrent(gen)) {
          batch(() => {
            this.flush();
            if (missing > 0) {
              this.setError(
                `Incomplete: ${missing.toLocaleString()} of ` +
                `${progress.matchedSoFar.toLocaleString()} matches could not be loaded.`,
              );
            }
            this.setPhase('done');
          });
        }
      }
    };

    const fn = await this.deps.listen((progress) => {
      handlerChain = handlerChain.then(() => handleProgress(progress)).catch(() => {});
    });

    if (listenerDone || !this.guard.isCurrent(gen)) {
      // Already done, or a newer scan started while this listener was still
      // registering — unregister immediately instead of storing a stale
      // listener, which would orphan the newer scan's own listener.
      fn();
    } else {
      unlisten = fn;
      this.unlisten = fn;
    }
  }

  // ── Full-JS fallback scan ───────────────────────────────────────────────

  private async runFallbackScan(sessionId: string, gen: number, ast: FilterNode): Promise<void> {
    const { commands } = this.deps;
    let offset = 0;
    let total = Infinity;
    let batchCount = 0;
    /** Matches added to `merged` since the last flush — nothing new, nothing to publish. */
    let pendingSinceFlush = 0;

    while (offset < total) {
      if (!this.guard.isCurrent(gen)) return;
      let window: LinePage;
      try {
        window = await commands.getLines({
          sessionId,
          mode: { mode: 'Full' },
          offset,
          count: this.pageSize,
          context: 0,
          processorId: null,
          search: null,
        });
      } catch {
        break;
      }
      if (!this.guard.isCurrent(gen)) return;

      total = window.totalLines;
      this.setTotal(window.totalLines);
      let foundInWindow = 0;
      for (const line of window.lines) {
        if (matchesFilter(ast, line, this.packagePids)) {
          this.merged.add(line.lineNum);
          foundInWindow++;
        }
      }
      batchCount++;
      pendingSinceFlush += foundInWindow;
      if (pendingSinceFlush > 0 && (batchCount === 1 || batchCount % FLUSH_EVERY === 0)) {
        this.flush();
        pendingSinceFlush = 0;
      }
      offset += window.lines.length;
      if (window.lines.length === 0) break;
    }

    if (this.guard.isCurrent(gen)) {
      batch(() => {
        this.flush();
        this.setPhase('done');
      });
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Republish `merged` — the one accumulator both the scan's own pages and
   * `appendMatches` add into, so a line number found by both is stored (and
   * counted) once. It belongs to the current generation only (see its doc
   * comment), so this can never mix in a superseded scan's or a stale live
   * batch's results. The Set instance is unchanged between flushes; the
   * `lines` signal is `equals: false` so subscribers still see every update.
   */
  private flush(): void {
    batch(() => {
      this.setLines(this.merged);
      this.setMatched(this.merged.size);
    });
  }

  /**
   * Publish "no filter active" — but only when something *is* published.
   * `lines` is `equals: false` (see its doc comment), so a redundant
   * null→null write would still notify, reach `controller.setLineSet` and
   * have its `bump()` reset the viewer's cache for nothing.
   */
  private clearLines(): void {
    if (untrack(this.lines) !== null) this.setLines(null);
  }

  private clearState(phase: FilterScanPhase): void {
    batch(() => {
      this.clearLines();
      this.setMatched(0);
      this.setTotal(0);
      this.setError(null);
      this.setParseError(null);
      this.setPhase(phase);
    });
  }

  /** Cancel + close the live backend filter and drop the progress listener. */
  private teardownBackendFilter(): void {
    if (this.activeFilterId) {
      const filterId = this.activeFilterId;
      this.activeFilterId = null;
      this.deps.commands.cancelFilter(filterId).catch(() => {});
      this.deps.commands.closeFilter(filterId).catch(() => {});
    }
    this.unlisten?.();
    this.unlisten = null;
  }
}
