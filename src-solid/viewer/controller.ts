/**
 * The viewer controller — the one routing surface between everything that wants
 * to move the log viewer (presence navigation, editor line refs, sections,
 * bookmarks, analyses, analyzer cards, search) and the pane that actually
 * scrolls.
 *
 * Callers only ever name a **session**. The controller resolves that to a pane
 * via `bindSession`/`paneForSession` (one pane until S1's split, two after),
 * focuses the session first when the pane is showing a different one, and
 * then drives the pane's `PaneHandle`. Nothing outside `LogViewer` touches
 * the DOM.
 *
 * It also owns the per-session *view* state the data source and the cache
 * binding read back:
 *  - `viewMode` — what `get_lines` is asked for.
 *  - four line sets (`section` / `filter` / `search` / `matched`) whose
 *    ascending intersection is the rendered index space (`lineNumbers`, wired
 *    into `createCacheDataSource({ getLineNumbers })`).
 *  - controller highlights, merged over `ViewLine.highlights` by `Row`.
 *  - `revision`, bumped by every one of those setters, which `createCacheBinding`
 *    treats exactly like a `sourceId` swap.
 *
 * Lifetime: the controller owns a `createRoot`, so it may be built outside a
 * component body (the same pattern as `presence/presenceStore.ts` and
 * `theme/applyTheme.ts`). `dispose()` tears the root down.
 */
import { createMemo, createRoot, createSignal, getOwner, runWithOwner, untrack } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import type { HighlightSpan } from '@bridge/generated/HighlightSpan';
import type { ViewMode } from '@bridge/generated/ViewMode';
import { sessionScrollPositions } from '@viewport/sessionScrollPositions';

/**
 * The independent line-number filters whose intersection is rendered.
 *
 * `matched` is the analyzer/processor "show matched lines" set; it is kept
 * separate from `filter` (the query bar's) so turning one off does not silently
 * discard the other. The intersection walk is key-agnostic — adding a key here
 * needs no change to `intersectSorted`.
 */
export type LineSetKey = 'section' | 'filter' | 'search' | 'matched';

/** Who asked for a jump. Recorded on the cursor so surfaces can attribute it. */
export type NavSource = 'user' | 'agent' | 'search' | 'analysis';

/** What a mounted pane exposes to the controller. `LogViewer` supplies one. */
export interface PaneHandle {
  /**
   * Scroll an **absolute backend line number** into view.
   *
   * Absolute is the only coordinate system that crosses this boundary: every
   * caller of `scrollToLine` (analyzers, search, bookmarks, sections, analyses,
   * device state, agent navigation) names a file line, and a line set changes
   * what row that line is drawn on without changing the line itself. The pane
   * — and only the pane — maps absolute → rendered via
   * `ViewerController.lineNumbers(sessionId)`.
   */
  jumpToLine(line: number): void;
  /** Focus the pane's scroll container so keyboard navigation lands there. */
  focus(): void;
  /**
   * Select an inclusive `[start, end]` range of **absolute backend line
   * numbers**, or clear with `null`. Mapped to rendered rows by the pane.
   */
  setSelection(range: [number, number] | null): void;
}

export interface ScrollToLineOptions {
  /** Reserved for the caller's own highlight bookkeeping; recorded on the cursor. */
  highlight?: boolean;
  /** Inclusive line range to select once the jump lands. */
  select?: [number, number];
  source?: NavSource;
}

/**
 * Where the cursor is. `sessionId` + `line` are the frozen shape every consumer
 * may rely on; `source`/`highlight` are extra context from `scrollToLine` and
 * are absent for a plain `setCursor` from the viewer itself.
 */
export interface CursorPosition {
  sessionId: string;
  line: number;
  source?: NavSource;
  highlight?: boolean;
}

export interface ViewerControllerDeps {
  /** Bring `sessionId` to the front. W0b wires this to the session store. */
  focusSession: (sessionId: string) => void;
}

export interface ViewerController {
  /**
   * Focus the session (when its pane is showing another one), jump, optionally
   * select, and record the cursor — in that order.
   */
  scrollToLine(sessionId: string, line: number, opts?: ScrollToLineOptions): void;

  setViewMode(sessionId: string, mode: ViewMode): void;
  viewMode(sessionId: string): ViewMode;

  /**
   * Replace one of the line sets. `null` removes it from the intersection.
   *
   * The merge read of the other keys is `untrack`ed internally, so a caller
   * inside a reactive scope does NOT need its own `untrack` wrapper.
   */
  setLineSet(sessionId: string, key: LineSetKey, lines: Set<number> | null): void;
  /**
   * The rendered index space: the ascending intersection of whichever line sets
   * are set, or `undefined` when they are all `null` (i.e. render every line).
   * An empty intersection is `[]`, which renders nothing — not `undefined`.
   */
  lineNumbers(sessionId: string): number[] | undefined;

  setHighlights(sessionId: string, spans: Map<number, HighlightSpan[]> | null): void;
  highlights(sessionId: string): Map<number, HighlightSpan[]> | null;

  /** Bumped by `setViewMode`, `setLineSet` and `setHighlights`; never by a read. */
  revision(sessionId: string): number;

  cursor: Accessor<CursorPosition | null>;
  onCursorChange(cb: (cursor: CursorPosition | null) => void): () => void;
  /** Called by the viewer when its own cursor moves (click, arrow keys). */
  setCursor(sessionId: string, line: number): void;

  /** Focus the active pane's scroll container. */
  focus(): void;

  attachPane(paneId: string, handle: PaneHandle): () => void;
  bindSession(sessionId: string, paneId: string): void;
  paneForSession(sessionId: string): string;

  /**
   * Mark `paneId` as the one `focus()` targets, without touching any session
   * binding. `LogViewer` calls this on pointer-down and on native focus, so
   * clicking or Tab-ing into an already-bound pane (S1: a second, split pane)
   * makes it the keyboard-shortcut target immediately — before this,
   * `activePaneId` only ever moved on `attachPane`/`bindSession`, so a pane
   * showing a session nothing just navigated to could never become active.
   */
  focusPane(paneId: string): void;

  /**
   * Drop every trace of a closed session: its line sets, highlight map, view
   * mode and memos, plus its saved scroll position.
   *
   * Without this, an `open_file` → `close_session` cycle (an agent walking a
   * directory of large logs) retains one `SessionState` per session for the
   * app's lifetime, each holding a `number[]` with one entry per matched line
   * and a highlight `Map`. Safe to call for a session the controller has never
   * seen. The session store owns the call — see the handoff note.
   */
  forgetSession(sessionId: string): void;

  dispose(): void;
}

/** The pane every session resolves to until multi-pane lands. */
export const DEFAULT_PANE_ID = 'main';

/** What `viewMode()` answers for a session nothing has configured. */
export const DEFAULT_VIEW_MODE: ViewMode = Object.freeze({ mode: 'Full' }) as ViewMode;

type LineSets = Record<LineSetKey, number[] | null>;

const NO_LINE_SETS: LineSets = Object.freeze({
  section: null,
  filter: null,
  search: null,
  matched: null,
});

/** Ascending copy of a set. Sorting once here keeps the intersection a pure merge-walk. */
function ascending(lines: Set<number>): number[] {
  return Array.from(lines).sort((a, b) => a - b);
}

/**
 * Intersect ascending, duplicate-free arrays with a merge-walk.
 *
 * Every iteration takes the largest current head as the candidate and advances
 * each cursor to the first value `>= candidate`, so at least one cursor moves
 * per iteration: the whole walk is O(total elements), never a `Set`
 * intersection plus a sort on every read.
 */
export function intersectSorted(lists: readonly (readonly number[])[]): number[] {
  const n = lists.length;
  if (n === 0) return [];
  if (n === 1) return lists[0].slice();

  const cursors = new Array<number>(n).fill(0);
  const out: number[] = [];

  for (;;) {
    let candidate = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if (cursors[i] >= lists[i].length) return out;
      const head = lists[i][cursors[i]];
      if (head > candidate) candidate = head;
    }

    let all = true;
    for (let i = 0; i < n; i++) {
      const list = lists[i];
      let c = cursors[i];
      while (c < list.length && list[c] < candidate) c++;
      cursors[i] = c;
      if (c >= list.length) return out;
      if (list[c] !== candidate) all = false;
    }

    if (all) {
      out.push(candidate);
      for (let i = 0; i < n; i++) cursors[i]++;
    }
  }
}

/** Per-session reactive state, created lazily under the controller's root. */
interface SessionState {
  viewMode: Accessor<ViewMode>;
  writeViewMode: (mode: ViewMode) => void;
  sets: Accessor<LineSets>;
  writeSets: (sets: LineSets) => void;
  highlights: Accessor<Map<number, HighlightSpan[]> | null>;
  writeHighlights: (spans: Map<number, HighlightSpan[]> | null) => void;
  revision: Accessor<number>;
  bump: () => void;
  lineNumbers: Accessor<number[] | undefined>;
}

function createSessionState(): SessionState {
  const [viewMode, writeViewMode] = createSignal<ViewMode>(DEFAULT_VIEW_MODE);
  const [sets, writeSetsSignal] = createSignal<LineSets>(NO_LINE_SETS);
  const [highlights, writeHighlightsSignal] =
    createSignal<Map<number, HighlightSpan[]> | null>(null);
  const [revision, setRevision] = createSignal(0);

  // Memoised per session: the walk re-runs only when a line set is replaced,
  // not on every `getLineNumbers()` call the data source makes.
  const lineNumbers = createMemo<number[] | undefined>(() => {
    const current = sets();
    const present = (Object.keys(current) as LineSetKey[])
      .map((key) => current[key])
      .filter((l): l is number[] => l !== null);
    return present.length === 0 ? undefined : intersectSorted(present);
  });

  return {
    viewMode,
    writeViewMode: (mode) => writeViewMode(() => mode),
    sets,
    writeSets: (next) => writeSetsSignal(next),
    highlights,
    writeHighlights: (spans) => writeHighlightsSignal(() => spans),
    revision,
    bump: () => setRevision((v) => v + 1),
    lineNumbers,
  };
}

export function createViewerController(deps: ViewerControllerDeps): ViewerController {
  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;

    /** `sessionId` → its reactive view state. Created on first touch. */
    const sessions = new Map<string, SessionState>();
    /** `paneId` → the mounted pane handle. */
    const panes = new Map<string, PaneHandle>();
    /** `paneId` → the session that pane is currently showing. */
    const boundSessions = new Map<string, string>();

    let activePaneId = DEFAULT_PANE_ID;
    let disposed = false;

    const [cursor, setCursorSignal] = createSignal<CursorPosition | null>(null);
    const cursorListeners = new Set<(cursor: CursorPosition | null) => void>();

    /**
     * Session state is created inside the controller's own root — `createMemo`
     * needs an owner, and reading `lineNumbers()` must never subscribe the
     * *caller's* computation to the creation itself (`runWithOwner` clears the
     * listener, so only the returned accessor tracks).
     */
    const stateFor = (sessionId: string): SessionState => {
      let state = sessions.get(sessionId);
      if (!state) {
        state = runWithOwner(owner, createSessionState) as SessionState;
        sessions.set(sessionId, state);
      }
      return state;
    };

    const emitCursor = (next: CursorPosition | null): void => {
      setCursorSignal(next);
      for (const cb of [...cursorListeners]) cb(next);
    };

    const paneForSession = (sessionId: string): string => {
      for (const [paneId, bound] of boundSessions) {
        if (bound === sessionId) return paneId;
      }
      return DEFAULT_PANE_ID;
    };

    const scrollToLine = (
      sessionId: string,
      line: number,
      opts?: ScrollToLineOptions,
    ): void => {
      const paneId = paneForSession(sessionId);
      // The pane is showing something else (or nothing yet) — bring the session
      // forward first, so the jump lands in a pane that holds the right source.
      if (boundSessions.get(paneId) !== sessionId) deps.focusSession(sessionId);

      activePaneId = paneId;
      const handle = panes.get(paneId);
      if (handle) {
        handle.jumpToLine(line);
        if (opts?.select) handle.setSelection(opts.select);
      }

      emitCursor({
        sessionId,
        line,
        ...(opts?.source !== undefined ? { source: opts.source } : {}),
        ...(opts?.highlight !== undefined ? { highlight: opts.highlight } : {}),
      });
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      sessions.clear();
      panes.clear();
      boundSessions.clear();
      cursorListeners.clear();
      disposeRoot();
    };

    return {
      scrollToLine,

      setViewMode: (sessionId, mode) => {
        const state = stateFor(sessionId);
        state.writeViewMode(mode);
        state.bump();
      },
      viewMode: (sessionId) => stateFor(sessionId).viewMode(),

      setLineSet: (sessionId, key, lines) => {
        // Clearing a key on a session this controller does not hold is a no-op:
        // the per-session prune sweeps (sections, bookmarks, watches) run off
        // `sessions.order()` *after* `forgetSession` has already run for the
        // same close, and `stateFor` would otherwise re-create the state the
        // close just released (feature review, W5/W6 seam).
        if (lines === null && !sessions.has(sessionId)) return;
        const state = stateFor(sessionId);
        // `writeSets` merges the other keys, which means reading `sets()` — a
        // signal read inside a setter. Untracked here, once, so no caller has to
        // remember its own `untrack` wrapper (three of four did; one did not).
        state.writeSets({ ...untrack(state.sets), [key]: lines ? ascending(lines) : null });
        state.bump();
      },
      lineNumbers: (sessionId) => stateFor(sessionId).lineNumbers(),

      setHighlights: (sessionId, spans) => {
        // Same rule as `setLineSet`: a null write on an unknown session is a
        // no-op rather than a state re-creation.
        if (spans === null && !sessions.has(sessionId)) return;
        const state = stateFor(sessionId);
        state.writeHighlights(spans);
        state.bump();
      },
      highlights: (sessionId) => stateFor(sessionId).highlights(),

      revision: (sessionId) => stateFor(sessionId).revision(),

      cursor,
      onCursorChange: (cb) => {
        cursorListeners.add(cb);
        return () => { cursorListeners.delete(cb); };
      },
      setCursor: (sessionId, line) => emitCursor({ sessionId, line }),

      focus: () => panes.get(activePaneId)?.focus(),

      attachPane: (paneId, handle) => {
        panes.set(paneId, handle);
        // Deliberately NOT `activePaneId = paneId`: mounting a pane is a
        // structural event, not a focus one. The secondary pane appearing (S1's
        // split) must not retarget `focus()` away from the pane the user is
        // typing in. `focusPane` — called from pointer-down / focus-in — and
        // `scrollToLine` are the two things that move focus.
        return () => {
          // Only detach our own handle: a remount may already have replaced it.
          if (panes.get(paneId) !== handle) return;
          panes.delete(paneId);
          // A session left bound to a pane that no longer has a handle would
          // make `paneForSession` return a dead id forever (S1: unsplitting
          // unmounts the secondary pane). Clearing the binding here — not in
          // a component — is the fix; `paneForSession` falls back to
          // `DEFAULT_PANE_ID` for a session nothing claims.
          boundSessions.delete(paneId);
        };
      },

      focusPane: (paneId) => {
        activePaneId = paneId;
      },

      forgetSession: (sessionId) => {
        sessions.delete(sessionId);
        for (const [paneId, bound] of [...boundSessions]) {
          if (bound === sessionId) boundSessions.delete(paneId);
        }
        sessionScrollPositions.delete(sessionId);
      },

      bindSession: (sessionId, paneId) => {
        // A session lives in exactly one pane — drop any earlier binding first.
        for (const [id, bound] of [...boundSessions]) {
          if (bound === sessionId && id !== paneId) boundSessions.delete(id);
        }
        boundSessions.set(paneId, sessionId);
        // Same reasoning as `attachPane`: binding a session to a background
        // pane is structural and must not steal `focus()`.
      },

      paneForSession,

      dispose,
    };
  });
}
