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
 * ## Ownership
 *
 * All reactive state lives under a `createRoot` this instance owns, so a
 * `FilterScan` may be constructed outside a component body. The **caller owns
 * the instance**: it must call `dispose()` (typically from `onCleanup`), which
 * cancels any scan in flight, unregisters the progress listener, and tears the
 * root down. Nothing here touches the viewer controller — W2b reads `lines()`
 * and forwards it with `controller.setLineSet(sessionId, 'filter', lines)`.
 */
import { batch, createRoot, createSignal } from 'solid-js';
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
  /** The matched set. `null` = no filter active (render everything). */
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

  constructor(deps: FilterScanDeps) {
    this.deps = deps;
    this.pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;

    const state = createRoot((disposeRoot) => {
      const [phase, setPhase] = createSignal<FilterScanPhase>('idle');
      const [matched, setMatched] = createSignal(0);
      const [total, setTotal] = createSignal(0);
      const [error, setError] = createSignal<string | null>(null);
      const [parseError, setParseError] = createSignal<string | null>(null);
      const [lines, setLines] = createSignal<Set<number> | null>(null);
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
        this.setLines(null);
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
    this.teardownBackendFilter();
    this.clearState('idle');
  }

  /** Cancel, then tear down the reactive root. The instance is unusable after this. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.guard.bump();
    this.teardownBackendFilter();
    this.disposeRoot();
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
      batch(() => {
        this.setLines(null);
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

    const matches: number[] = [];
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

      const newCount = progress.matchedSoFar - lastFetched;
      if (newCount > 0) {
        try {
          const page = await commands.getFilteredLines(filterId, lastFetched, newCount);
          if (listenerDone || !this.guard.isCurrent(gen)) return;
          lastFetched = progress.matchedSoFar;

          // JS second pass: only needed when the backend criteria is a superset
          // (e.g. backend filtered by level:E but the user also wants
          // tag:Activity — JS confirms the tag).
          const confirmed = needsJsPass
            ? page.lines.filter((line: ViewLine) => matchesFilter(ast, line, this.packagePids))
            : page.lines;

          if (confirmed.length > 0) {
            for (const line of confirmed) matches.push(line.lineNum);
            this.flush(matches);
          }
        } catch {
          // Ignore transient fetch errors; the next progress event retries.
        }
      }

      if (progress.done) {
        listenerDone = true;
        if (this.activeFilterId === filterId) this.activeFilterId = null;
        commands.closeFilter(filterId).catch(() => {});
        unlisten?.();
        if (this.unlisten === unlisten) this.unlisten = null;
        if (this.guard.isCurrent(gen)) {
          batch(() => {
            this.flush(matches);
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
    const matches: number[] = [];
    let offset = 0;
    let total = Infinity;
    let batchCount = 0;

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
      for (const line of window.lines) {
        if (matchesFilter(ast, line, this.packagePids)) matches.push(line.lineNum);
      }
      batchCount++;
      const isFirstFlush = batchCount === 1 && matches.length > 0;
      if (isFirstFlush || (batchCount % FLUSH_EVERY === 0 && matches.length > 0)) {
        this.flush(matches);
      }
      offset += window.lines.length;
      if (window.lines.length === 0) break;
    }

    if (this.guard.isCurrent(gen)) {
      batch(() => {
        this.flush(matches);
        this.setPhase('done');
      });
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Publish the accumulated matches as a fresh Set so consumers see a new reference. */
  private flush(matches: number[]): void {
    batch(() => {
      this.setLines(new Set(matches));
      this.setMatched(matches.length);
    });
  }

  private clearState(phase: FilterScanPhase): void {
    batch(() => {
      this.setLines(null);
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
