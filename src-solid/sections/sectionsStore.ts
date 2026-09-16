/**
 * Sections navigator store (W3): the bugreport/dumpstate section tree for the
 * focused session, active-section tracking off the viewer controller's
 * cursor, and checkbox selection composed into the controller's `'section'`
 * line set.
 *
 * Reuses three framework-free modules from the React `FileInfoPanel` verbatim
 * via the `@fileinfo` alias: `sectionTree.ts` (tree building), `formatters.ts`
 * (timestamp/duration), `sectionDescriptions.ts` (per-section tooltips) — see
 * `SectionsPanel.tsx` for where those are consumed.
 *
 * Lifetime: the store owns a `createRoot` (the same pattern as
 * `presence/presenceStore.ts` and `viewer/controller.ts`), so it can be built
 * outside a component body. Each per-session state owns a *nested* root, so a
 * closed session's `lineSet` memo and push effect can be torn down on their
 * own (a detached root is not disposed with its parent — that is exactly why
 * `dispose()` and the prune sweep both call `state.dispose()` explicitly).
 * `dispose()` clears the notice timer, disposes every session state and tears
 * the store root down.
 */
import { createEffect, createMemo, createRoot, createSignal, getOwner, on, runWithOwner, untrack } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import { getDumpstateMetadata, getSections } from '@bridge/commands';
import { isBugreportLike } from '@bridge/types';
import type { DumpstateMetadata } from '@bridge/types';
import type { SectionEntry } from '@fileinfo';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { SessionStore } from '../app/index';
import type { ViewerController } from '../viewer';

/** How long a jump-refusal notice stays up before it auto-clears. */
export const NOTICE_MS = 3_000;

export const OUTSIDE_FILTER_NOTICE = 'That section is outside the active section filter.';

export interface SectionsStoreDeps {
  sessions: SessionStore;
  controller: ViewerController;
}

/** Per-session reactive state, created lazily under the store's root. */
interface SessionSectionsState {
  sections: Accessor<SectionEntry[]>;
  setSections: (v: SectionEntry[]) => void;
  metadata: Accessor<DumpstateMetadata | null>;
  setMetadata: (v: DumpstateMetadata | null) => void;
  /**
   * Checkbox selection, keyed by `startLine`. Names are NOT unique — a
   * dumpstate repeats `DUMP OF SERVICE …` blocks — so keying on the name made
   * two same-named sections check and filter together. `startLine` is unique,
   * equally stable across filtering/grouping, and is already the row identity
   * `flattenRows` / `containingGroupKey` / `activeStartLine` use.
   */
  selected: Accessor<ReadonlySet<number>>;
  setSelected: (fn: (prev: ReadonlySet<number>) => ReadonlySet<number>) => void;
  expanded: Accessor<ReadonlySet<string>>;
  setExpanded: (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  /** Union of the selected sections' line ranges, or `null` when nothing is selected. */
  lineSet: Accessor<Set<number> | null>;
  /** Last fetch failure for this session, surfaced by the panel with a Retry. */
  error: Accessor<string | null>;
  setError: (v: string | null) => void;
  /** Tears down this session's nested root (the `lineSet` memo and push effect). */
  dispose: () => void;
}

export interface SectionsStore {
  /** Whether the focused session is a Bugreport/Dumpstate. */
  isBugreportSession: Accessor<boolean>;
  /** Backend is still indexing the focused session — sections are not fetchable yet. */
  scanning: Accessor<boolean>;
  sections: Accessor<SectionEntry[]>;
  metadata: Accessor<DumpstateMetadata | null>;
  /** Index into `sections()` containing `controller.cursor()`'s line, or -1. */
  activeIndex: Accessor<number>;
  /** The focused session's last fetch failure, or `null`. */
  error: Accessor<string | null>;
  /** Clear the error and re-run the focused session's fetch. */
  retry(): void;
  isSelected(startLine: number): boolean;
  selectionCount: Accessor<number>;
  toggle(startLine: number): void;
  toggleGroup(startLines: readonly number[]): void;
  clearSelection(): void;
  isExpanded(key: string): boolean;
  toggleExpanded(key: string): void;
  /** Jump to a section's start line, or surface `notice` when it is outside the active filter. */
  jumpTo(section: SectionEntry): void;
  notice: Accessor<string | null>;
  dispose(): void;
}

/**
 * Reverse iteration prefers the most specific (child) section when ranges
 * overlap — children come after parents in the backend's array and have
 * narrower ranges, so the last match is the most specific. Mirrors
 * `useFileInfo.ts`'s `activeSectionIndex` exactly.
 */
export function activeSectionIndexAt(sections: readonly SectionEntry[], line: number | null): number {
  if (line == null) return -1;
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (line >= s.startLine && line <= s.endLine) return i;
  }
  return -1;
}

/** The union of every line in the sections starting at `startLines`, or `null` when it is empty. */
export function linesForSelection(
  sections: readonly SectionEntry[],
  startLines: ReadonlySet<number>,
): Set<number> | null {
  if (startLines.size === 0) return null;
  const lines = new Set<number>();
  for (const s of sections) {
    if (!startLines.has(s.startLine)) continue;
    for (let i = s.startLine; i <= s.endLine; i++) lines.add(i);
  }
  return lines;
}

function createSessionSectionsState(sessionId: string, controller: ViewerController): SessionSectionsState {
  return createRoot((disposeState) => {
    const [sections, setSectionsSignal] = createSignal<SectionEntry[]>([]);
    const [metadata, setMetadataSignal] = createSignal<DumpstateMetadata | null>(null);
    const [selected, setSelectedSignal] = createSignal<ReadonlySet<number>>(new Set());
    const [expanded, setExpandedSignal] = createSignal<ReadonlySet<string>>(new Set());
    const [error, setErrorSignal] = createSignal<string | null>(null);

    const lineSet = createMemo(() => linesForSelection(sections(), selected()));

    // Push the composed selection into the controller whenever it *changes*.
    //
    // `{ defer: true }` is load-bearing, not a style choice. A plain
    // `createEffect` runs once on creation, which would write
    // `('section', null)` — a no-op selection — and `setLineSet` bumps the
    // session's `revision` unconditionally. `viewer/cacheBinding.ts` treats a
    // revision change exactly like a source swap, so that 0→1 bump threw away
    // the viewport cache the `LogViewer` had just warmed and refetched the
    // first screen, on every session focus. Deferring means the controller
    // hears from this session only once a checkbox is actually ticked.
    createEffect(
      on(
        lineSet,
        (lines) => {
          controller.setLineSet(sessionId, 'section', lines);
        },
        { defer: true },
      ),
    );

    return {
      sections,
      setSections: (v) => setSectionsSignal(v),
      metadata,
      setMetadata: (v) => setMetadataSignal(v),
      selected,
      setSelected: (fn) => setSelectedSignal((prev) => fn(prev)),
      expanded,
      setExpanded: (fn) => setExpandedSignal((prev) => fn(prev)),
      lineSet,
      error,
      setError: (v) => setErrorSignal(v),
      dispose: disposeState,
    };
  });
}

export function createSectionsStore(deps: SectionsStoreDeps): SectionsStore {
  const { sessions, controller } = deps;

  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;
    const states = new Map<string, SessionSectionsState>();
    const fetchedIds = new Set<string>();
    /** Per-session fetch generation — see the fetch effect (M8). */
    const generations = new Map<string, number>();
    let disposed = false;

    // `states` is a plain Map, invisible to Solid. Every read of it happens
    // through this tick so the memos below actually re-run when a session
    // state appears or is pruned (the `analysesStore.cacheVersion` pattern).
    const [statesTick, setStatesTick] = createSignal(0);

    const ensureState = (sessionId: string): SessionSectionsState => {
      let state = states.get(sessionId);
      if (!state) {
        state = runWithOwner(owner, () => createSessionSectionsState(sessionId, controller)) as SessionSectionsState;
        states.set(sessionId, state);
        setStatesTick((n) => n + 1);
      }
      return state;
    };

    const dropState = (sessionId: string): void => {
      const state = states.get(sessionId);
      if (!state) return;
      states.delete(sessionId);
      // A selected multi-million-line dumpstate section is a sorted `number[]`
      // of that size inside the controller; releasing it is the point of the
      // sweep. Only touch the controller when there is something to release —
      // `setLineSet` would otherwise re-create the controller's own per-session
      // state for a session `app/` may already have called `forgetSession` on.
      const hadLines = untrack(() => state.lineSet()) !== null;
      state.dispose();
      if (hadLines) controller.setLineSet(sessionId, 'section', null);
    };

    const focusedState = createMemo<SessionSectionsState | null>(() => {
      statesTick();
      const id = sessions.focusedId();
      return id ? (states.get(id) ?? null) : null;
    });

    const isBugreportSession = createMemo(() => {
      const entry = sessions.focused();
      return !!entry && isBugreportLike(entry.load.sourceType);
    });

    const scanning = createMemo(() => isBugreportSession() && (sessions.focused()?.isIndexing ?? false));

    const sectionsAccessor = createMemo<SectionEntry[]>(() => focusedState()?.sections() ?? []);
    const metadataAccessor = createMemo<DumpstateMetadata | null>(() => focusedState()?.metadata() ?? null);
    const error = createMemo<string | null>(() => focusedState()?.error() ?? null);

    const activeIndex = createMemo(() => {
      const id = sessions.focusedId();
      if (!id) return -1;
      const cursor = controller.cursor();
      if (!cursor || cursor.sessionId !== id) return -1;
      return activeSectionIndexAt(sectionsAccessor(), cursor.line);
    });

    // Per-session state is created HERE, in an effect — never inside a memo.
    // Creating it is a write (into `states`, and formerly into the controller),
    // and the gate is what keeps a plain logcat from ever getting a sections
    // state, a `lineSet` memo, or a controller line-set entry at all.
    createEffect(() => {
      const id = sessions.focusedId();
      if (!id || disposed) return;
      const entry = sessions.byId(id);
      if (!entry || !isBugreportLike(entry.load.sourceType)) return;
      ensureState(id);
    });

    // A session restored or opened while the backend is still indexing can
    // report `isIndexing: false` at load time and only flip to true on the
    // first progress event — by which point the gate below has already
    // fetched a partial index (the live bug: a 586-section dumpstate showed
    // 7). So the true→false transition of ANY session invalidates its cache
    // and bumps `indexedTick`, which the fetch effect reads, so the completed
    // index is fetched whenever that session is (re)focused.
    const wasIndexing = new Set<string>();
    const [indexedTick, setIndexedTick] = createSignal(0);
    createEffect(() => {
      for (const id of sessions.order()) {
        if (sessions.byId(id)?.isIndexing) {
          wasIndexing.add(id);
        } else if (wasIndexing.delete(id)) {
          fetchedIds.delete(id);
          setIndexedTick((n) => n + 1);
        }
      }
    });

    const [retryTick, setRetryTick] = createSignal(0);

    // Fetch sections + dumpstate metadata once per session id, gated on the
    // session being bugreport-like and fully indexed — mirrors
    // `useFileInfo.ts`'s fetch effects. `fetchedIds` makes this idempotent
    // across repeated focus changes (the cache requirement); it is cleared
    // for a session whose indexing just completed (above) and by `retry()`.
    createEffect(() => {
      indexedTick();
      retryTick();
      const id = sessions.focusedId();
      if (!id || disposed) return;
      const entry = sessions.byId(id);
      if (!entry || !isBugreportLike(entry.load.sourceType) || entry.isIndexing) return;
      if (fetchedIds.has(id)) return;
      fetchedIds.add(id);

      // `fetchedIds` alone cannot order two in-flight fetches for one session:
      // the indexing-completion effect deliberately *deletes* the entry to
      // force a re-fetch, so a slow fetch started against a partial index can
      // resolve after the complete one and overwrite it. The generation
      // counter (the shape `analyzerStore`'s `runGuards` uses) drops any
      // result that is no longer the newest request for that session.
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);

      const state = ensureState(id);
      Promise.all([
        getSections(id),
        getDumpstateMetadata(id).catch(() => null),
      ])
        .then(([secs, meta]) => {
          if (disposed || generations.get(id) !== generation) return;
          state.setSections(secs);
          state.setMetadata(meta);
          state.setError(null);
        })
        .catch((e: unknown) => {
          if (disposed || generations.get(id) !== generation) return;
          // Allow a retry, and say so — an empty tree used to claim a
          // perfectly good dumpstate simply had no sections.
          fetchedIds.delete(id);
          state.setError(String(e));
        });
    });

    // ── Session cleanup ──────────────────────────────────────────────────
    // Same sweep as `analyzers/analyzerStore.ts`: diff the per-session records
    // against `sessions.order()` and drop whatever no longer has a session.
    // Without it every closed bugreport left a live `lineSet` effect, a
    // `states` entry and (for a selected section) a multi-megabyte `number[]`
    // inside the controller, for the lifetime of the app.
    createEffect(() => {
      const known = new Set(sessions.order());
      for (const id of [...fetchedIds]) if (!known.has(id)) fetchedIds.delete(id);
      // `wasIndexing` only ever loses an id on a true→false transition, so a
      // session closed mid-index stayed in it forever (L12).
      for (const id of [...wasIndexing]) if (!known.has(id)) wasIndexing.delete(id);
      for (const id of [...generations.keys()]) if (!known.has(id)) generations.delete(id);
      const stale = [...states.keys()].filter((id) => !known.has(id));
      if (stale.length === 0) return;
      untrack(() => {
        for (const id of stale) dropState(id);
      });
      setStatesTick((n) => n + 1);
    });

    const [notice, setNotice] = createSignal<string | null>(null);
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const showNotice = (message: string): void => {
      setNotice(message);
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
    };

    const toggle = (startLine: number): void => {
      focusedState()?.setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(startLine)) next.delete(startLine);
        else next.add(startLine);
        return next;
      });
    };

    const toggleGroup = (startLines: readonly number[]): void => {
      focusedState()?.setSelected((prev) => {
        const allSelected = startLines.every((n) => prev.has(n));
        const next = new Set(prev);
        for (const n of startLines) {
          if (allSelected) next.delete(n);
          else next.add(n);
        }
        return next;
      });
    };

    const clearSelection = (): void => {
      focusedState()?.setSelected(() => new Set());
    };

    const retry = (): void => {
      const id = untrack(sessions.focusedId);
      if (id) {
        fetchedIds.delete(id);
        untrack(() => states.get(id)?.setError(null));
      }
      setRetryTick((n) => n + 1);
    };

    const jumpTo = (section: SectionEntry): void => {
      const id = sessions.focusedId();
      const state = focusedState();
      if (!id || !state) return;
      const activeLines = state.lineSet();
      if (activeLines && !activeLines.has(section.startLine)) {
        showNotice(OUTSIDE_FILTER_NOTICE);
        return;
      }
      controller.scrollToLine(id, section.startLine, { source: 'user' });
    };

    const selectionCount = createMemo(() => focusedState()?.selected().size ?? 0);

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      // Nested roots are detached: tearing the store root down would leave
      // every per-session `lineSet` memo and push effect alive.
      for (const state of states.values()) state.dispose();
      states.clear();
      fetchedIds.clear();
      generations.clear();
      wasIndexing.clear();
      disposeRoot();
    };

    return {
      isBugreportSession,
      scanning,
      sections: sectionsAccessor,
      metadata: metadataAccessor,
      activeIndex,
      error,
      retry,
      isSelected: (startLine) => focusedState()?.selected().has(startLine) ?? false,
      selectionCount,
      toggle,
      toggleGroup,
      clearSelection,
      isExpanded: (key) => focusedState()?.expanded().has(key) ?? false,
      toggleExpanded: (key) => {
        focusedState()?.setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      },
      jumpTo,
      notice,
      dispose,
    };
  });
}
