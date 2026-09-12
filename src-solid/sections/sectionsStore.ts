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
 * outside a component body. `dispose()` clears the notice timer and tears the
 * root down.
 */
import { createEffect, createMemo, createRoot, createSignal, getOwner, runWithOwner, untrack } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import { getDumpstateMetadata, getSections } from '@bridge/commands';
import { isBugreportLike } from '@bridge/types';
import type { DumpstateMetadata } from '@bridge/types';
import type { SectionEntry } from '@fileinfo/sectionTree';
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
  /** Checkbox selection, keyed by section name (stable across filtering/grouping). */
  selected: Accessor<ReadonlySet<string>>;
  setSelected: (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  expanded: Accessor<ReadonlySet<string>>;
  setExpanded: (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  /** Union of the selected sections' line ranges, or `null` when nothing is selected. */
  lineSet: Accessor<Set<number> | null>;
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
  isSelected(name: string): boolean;
  selectionCount: Accessor<number>;
  toggle(name: string): void;
  toggleGroup(names: readonly string[]): void;
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

/** The union of every line in the named sections, or `null` when `names` is empty. */
export function linesForSelection(
  sections: readonly SectionEntry[],
  names: ReadonlySet<string>,
): Set<number> | null {
  if (names.size === 0) return null;
  const lines = new Set<number>();
  for (const s of sections) {
    if (!names.has(s.name)) continue;
    for (let i = s.startLine; i <= s.endLine; i++) lines.add(i);
  }
  return lines;
}

function createSessionSectionsState(sessionId: string, controller: ViewerController): SessionSectionsState {
  const [sections, setSectionsSignal] = createSignal<SectionEntry[]>([]);
  const [metadata, setMetadataSignal] = createSignal<DumpstateMetadata | null>(null);
  const [selected, setSelectedSignal] = createSignal<ReadonlySet<string>>(new Set());
  const [expanded, setExpandedSignal] = createSignal<ReadonlySet<string>>(new Set());

  const lineSet = createMemo(() => linesForSelection(sections(), selected()));

  // Push the composed selection into the controller whenever it changes. This
  // runs for every session that has been touched, focused or not — harmless,
  // since only the mounted `LogViewer` for the focused session ever reads
  // `controller.lineNumbers(sessionId)`.
  //
  // `controller.setLineSet` reads the controller's own per-session signal
  // (to merge in the other two line-set keys) before writing it — read then
  // write on the *same* signal. Calling it untracked is required: without
  // it, that internal read is attributed to *this* effect (the currently
  // tracked computation), so the write right after immediately re-queues
  // this same effect, forever.
  createEffect(() => {
    const lines = lineSet();
    untrack(() => controller.setLineSet(sessionId, 'section', lines));
  });

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
  };
}

export function createSectionsStore(deps: SectionsStoreDeps): SectionsStore {
  const { sessions, controller } = deps;

  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;
    const states = new Map<string, SessionSectionsState>();
    const fetchedIds = new Set<string>();
    let disposed = false;

    const stateFor = (sessionId: string): SessionSectionsState => {
      let state = states.get(sessionId);
      if (!state) {
        state = runWithOwner(owner, () => createSessionSectionsState(sessionId, controller)) as SessionSectionsState;
        states.set(sessionId, state);
      }
      return state;
    };

    const focusedState = createMemo<SessionSectionsState | null>(() => {
      const id = sessions.focusedId();
      return id ? stateFor(id) : null;
    });

    const isBugreportSession = createMemo(() => {
      const entry = sessions.focused();
      return !!entry && isBugreportLike(entry.load.sourceType);
    });

    const scanning = createMemo(() => isBugreportSession() && (sessions.focused()?.isIndexing ?? false));

    const sectionsAccessor = createMemo<SectionEntry[]>(() => focusedState()?.sections() ?? []);
    const metadataAccessor = createMemo<DumpstateMetadata | null>(() => focusedState()?.metadata() ?? null);

    const activeIndex = createMemo(() => {
      const id = sessions.focusedId();
      if (!id) return -1;
      const cursor = controller.cursor();
      if (!cursor || cursor.sessionId !== id) return -1;
      return activeSectionIndexAt(sectionsAccessor(), cursor.line);
    });

    // Fetch sections + dumpstate metadata once per session id, gated on the
    // session being bugreport-like and fully indexed — mirrors
    // `useFileInfo.ts`'s fetch effects. `fetchedIds` makes this idempotent
    // across repeated focus changes (the cache requirement).
    createEffect(() => {
      const id = sessions.focusedId();
      if (!id || disposed) return;
      const entry = sessions.byId(id);
      if (!entry || !isBugreportLike(entry.load.sourceType) || entry.isIndexing) return;
      if (fetchedIds.has(id)) return;
      fetchedIds.add(id);

      const state = stateFor(id);
      Promise.all([
        getSections(id),
        getDumpstateMetadata(id).catch(() => null),
      ])
        .then(([secs, meta]) => {
          if (disposed) return;
          state.setSections(secs);
          state.setMetadata(meta);
        })
        .catch(() => {
          // Leave sections empty on error, like useFileInfo.
          fetchedIds.delete(id);
        });
    });

    const [notice, setNotice] = createSignal<string | null>(null);
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const showNotice = (message: string): void => {
      setNotice(message);
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
    };

    const toggle = (name: string): void => {
      focusedState()?.setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    };

    const toggleGroup = (names: readonly string[]): void => {
      focusedState()?.setSelected((prev) => {
        const allSelected = names.every((n) => prev.has(n));
        const next = new Set(prev);
        for (const n of names) {
          if (allSelected) next.delete(n);
          else next.add(n);
        }
        return next;
      });
    };

    const clearSelection = (): void => {
      focusedState()?.setSelected(() => new Set());
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
      states.clear();
      fetchedIds.clear();
      disposeRoot();
    };

    return {
      isBugreportSession,
      scanning,
      sections: sectionsAccessor,
      metadata: metadataAccessor,
      activeIndex,
      isSelected: (name) => focusedState()?.selected().has(name) ?? false,
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
