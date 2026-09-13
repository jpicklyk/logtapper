/**
 * The search-execution engine — a Solid port of `PaneSearchContext`'s
 * `setSearch`/`jumpToMatch` for one active session at a time (mirrors
 * `FilterScan`: a single instance, `run(sessionId, …)` supersedes whatever was
 * running, because only one session's query bar is ever mounted).
 *
 * Ownership: state lives under a `createRoot` this instance owns, so it can be
 * built inside `QueryBar`'s component body and disposed from `onCleanup`.
 */
import { batch, createRoot, createSignal, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { onSearchProgress } from '@bridge/events';
import type { SearchProgress, SearchQuery, SearchSummary } from '@bridge/types';
import type { ViewerController } from '../viewer';

export type SearchPhase = 'idle' | 'searching' | 'done' | 'error';

/** The subset of `@bridge/commands` a run needs. Injected so tests can log calls. */
export interface SearchRunnerCommands {
  searchLogs(sessionId: string, query: SearchQuery): Promise<SearchSummary>;
}

export interface SearchRunnerDeps {
  controller: ViewerController;
  /** `onSearchProgress` in the app; a fake the test can emit through in tests. */
  listen: typeof onSearchProgress;
  commands: SearchRunnerCommands;
}

export interface SearchRunner {
  readonly phase: Accessor<SearchPhase>;
  /** Ascending, duplicate-free match line numbers accumulated so far. */
  readonly hits: Accessor<number[]>;
  /** The backend's final answer once `searchLogs` resolves; `null` mid-scan. */
  readonly summary: Accessor<SearchSummary | null>;
  /** Index into `hits()` the viewer is parked on, or `-1` before any jump. */
  readonly current: Accessor<number>;
  readonly error: Accessor<string | null>;

  /** Run `query` against `sessionId`, superseding any run in flight. `null`
   *  clears everything (equivalent to `PaneSearchActions.setSearch(null)`). */
  run(sessionId: string, query: SearchQuery | null): void;
  /** Toggle whether `hits()` also narrows the rendered line set. */
  setMatchesOnly(matchesOnly: boolean): void;
  /** Advance to the next / previous hit, wrapping at either end. */
  next(): void;
  prev(): void;
  /** Stop the run in flight; leaves the last accumulated hits in place. */
  cancel(): void;
  dispose(): void;
}

function ascendingUnique(nums: readonly number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function createSearchRunner(deps: SearchRunnerDeps): SearchRunner {
  const { controller, listen, commands } = deps;

  return createRoot((disposeRoot) => {
    const [phase, setPhase] = createSignal<SearchPhase>('idle');
    const [hits, setHits] = createSignal<number[]>([]);
    const [summary, setSummary] = createSignal<SearchSummary | null>(null);
    const [current, setCurrent] = createSignal(-1);
    const [error, setError] = createSignal<string | null>(null);

    /** Bumped by `run`, `cancel` and `dispose` — a superseded run's late
     *  progress and its `searchLogs` resolution are both dropped. */
    let gen = 0;
    let sessionId: string | null = null;
    let matchesOnly = false;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    // These three helpers are called from both event handlers (`next`/`prev`,
    // `setMatchesOnly`) and from progress/promise callbacks that run outside any
    // tracked scope — they read the *current* signal value as a plain snapshot,
    // not to subscribe, so every read is `untrack`ed.
    const publishLineSet = (): void => {
      if (!sessionId) return;
      controller.setLineSet(sessionId, 'search', matchesOnly ? new Set(untrack(hits)) : null);
    };

    const teardown = (): void => {
      unlisten?.();
      unlisten = null;
    };

    const clearState = (nextPhase: SearchPhase): void => {
      batch(() => {
        setHits([]);
        setSummary(null);
        setCurrent(-1);
        setError(null);
        setPhase(nextPhase);
      });
    };

    const jumpTo = (index: number): void => {
      if (!sessionId) return;
      const list = untrack(hits);
      if (index < 0 || index >= list.length) return;
      setCurrent(index);
      // Select the hit as well as scrolling to it: the viewer's selected row is
      // what the user reads as "the current match" while cycling with n / N.
      const line = list[index];
      controller.scrollToLine(sessionId, line, { highlight: true, select: [line, line], source: 'search' });
    };

    const run = (targetSession: string, query: SearchQuery | null): void => {
      const myGen = ++gen;
      teardown();
      sessionId = targetSession;

      if (!query || !query.text.trim()) {
        clearState('idle');
        publishLineSet();
        return;
      }

      clearState('searching');
      let jumpedFirst = false;

      const onProgress = (payload: SearchProgress): void => {
        if (gen !== myGen || payload.sessionId !== targetSession) return;
        if (payload.newMatches.length === 0) return;

        let mergedLength = 0;
        batch(() => {
          const merged = ascendingUnique([...untrack(hits), ...payload.newMatches]);
          mergedLength = merged.length;
          setHits(merged);
          setSummary((prev) => ({
            totalMatches: payload.matchedSoFar,
            matchLineNums: merged,
            byLevel: prev?.byLevel ?? {},
            byTag: prev?.byTag ?? {},
          }));
          publishLineSet();
        });

        if (!jumpedFirst && mergedLength > 0) {
          jumpedFirst = true;
          jumpTo(0);
        }
      };

      listen(onProgress).then((fn) => {
        if (gen !== myGen) { fn(); return; }
        unlisten = fn;
      });

      commands
        .searchLogs(targetSession, query)
        .then((finalSummary) => {
          if (gen !== myGen) return;
          const merged = ascendingUnique(finalSummary.matchLineNums);
          batch(() => {
            setHits(merged);
            setSummary(finalSummary);
            setPhase('done');
            publishLineSet();
          });
          if (!jumpedFirst && merged.length > 0) {
            jumpedFirst = true;
            jumpTo(0);
          }
        })
        .catch((e: unknown) => {
          if (gen !== myGen) return;
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
        })
        .finally(() => {
          if (gen === myGen) teardown();
        });
    };

    const setMatchesOnly = (value: boolean): void => {
      matchesOnly = value;
      publishLineSet();
    };

    const stepBy = (direction: 1 | -1): void => {
      const list = untrack(hits);
      if (list.length === 0) return;
      const at = untrack(current);
      const nextIndex = at < 0 ? 0 : (at + direction + list.length) % list.length;
      jumpTo(nextIndex);
    };
    const next = (): void => stepBy(1);
    const prev = (): void => stepBy(-1);

    const cancel = (): void => {
      gen++;
      teardown();
      clearState('idle');
      publishLineSet();
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      gen++;
      teardown();
      disposeRoot();
    };

    return { phase, hits, summary, current, error, run, setMatchesOnly, next, prev, cancel, dispose };
  });
}
