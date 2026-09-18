/** @jsxImportSource solid-js */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { onCatalogUpdate } from '@bridge/events';
import {
  CacheManager,
  DataSourceRegistry,
  LogViewer,
  createViewerController,
} from './viewer';
import {
  SessionInfo,
  createAppActions,
  createSessionStore,
  installBenchApp,
  installShortcuts,
  isBenchMode,
} from './app/index';
import type { SessionEntry } from './app/index';
import {
  AppShell,
  REGION_ENTRY_PREFIX,
  SECONDARY_PANE_ID,
  TabStrip,
  ViewerSplit,
  createSplitView,
  createTier,
  isSplitTier,
} from './shell';
import type { ShellLayoutHandle, TabDescriptor } from './shell';
import { QueryBar, createLiveFilterBindings, createQueryStore } from './query';
import type { FilterScan } from './query';
import { PresencePanel, createPresenceStore } from './presence';
import { EditorTabs, createEditorStore } from './editor';
import type { ConfirmClose, EditorStore } from './editor';
import { SectionsPanel, createSectionsStore } from './sections';
import { AnalyzersPanel, createAnalyzerStore } from './analyzers';
import type { CallerLike } from './ui';
import { AnalysesIndex, AnalysesPanel, createAnalysesStore } from './analyses';
import { DeviceStatePanel, TimelineStrip, createDeviceStateStore } from './devicestate';
import { BookmarksPanel, createBookmarksStore } from './bookmarks';
import { WatchesPanel, createWatchesStore } from './watches';
import { Switcher, WorkspaceHome, createWorkspaceStore } from './workspace';
import { ExportDialog, createExportStore } from './export';
import { SettingsPanel, createSettingsStore } from './settings';
import { createPacksStore, UpdatesPrompt } from './packs';
import { StreamControlsPanel, createLiveStreamStore } from './stream';
import type { ThemeController } from './theme';
import styles from './App.module.css';

/**
 * Composition root. Everything here is wiring: build the app-wide singletons,
 * hand them to each other, and place the surfaces in the shell.
 *
 * No state lives in this file beyond which tab-strip surface (session or
 * editor) is showing in the viewer region. Sessions are in `app/sessions.ts`,
 * transitions in `app/actions.ts`, editor documents in `editor/editorStore.ts`,
 * the rendered index space in `viewer/controller.ts`, and the bench driver in
 * `app/benchDriver.ts`.
 */

const CACHE_BUDGET = 100_000;

/** Fallback shell-layout key before the workspace store's `hydrate()` resolves
 *  an activeId (W1a/W1b own the real workspace list). */
const WORKSPACE_ID = 'default';

export interface AppProps {
  /**
   * The live theme/density controller, built in `main.tsx` before first paint.
   * Optional so tests can mount `App` without a `matchMedia` shim.
   */
  theme?: ThemeController;
}

export function App(props: AppProps) {
  const cacheManager = new CacheManager(CACHE_BUDGET);
  const registry = new DataSourceRegistry();

  // Viewer controller (W0a) — owns the rendered index space and pane routing.
  // `focusSession` closes the loop: a jump into a session that is not on screen
  // selects its tab first.
  const controller = createViewerController({ focusSession: (id) => store.setFocused(id) });
  const store = createSessionStore({ cacheManager, registry, controller });
  // Analyzers (W4a store + W4b surface) — per-session pipeline chain, run
  // lifecycle and results; card clicks route matched lines through the same
  // controller every other surface uses. Built before `liveStream` (below) so
  // L3's live-counter path can be wired into it at construction time, same as
  // `deviceState` further down reads it.
  const analyzers = createAnalyzerStore({ sessions: store, controller });
  onCleanup(() => analyzers.dispose());
  // Live incremental filter matching (L4) — the registry of "which FilterScan
  // belongs to which session", the one piece of state this file owns for the
  // wiring below. A `FilterScan` is otherwise private to whichever `QueryBar`
  // constructs it (one per mounted pane); `bind` is the callback handed to
  // every `QueryBar` mount (primary and secondary pane, below) so each can
  // register itself under its OWN session id. Resolution happens per batch,
  // against the capturing session — see `query/liveFilterBindings.ts` for why
  // the single last-write-wins binding this replaced broke live filtering the
  // moment a split opened (H4). Declared before `liveStream` so the accessor
  // closures below can already reference it; `liveSessionId` reads
  // `liveStream.status()` lazily, from inside the batch handler, long after
  // the store below is constructed.
  const liveFilters = createLiveFilterBindings(() => {
    const status = liveStream.status();
    return status.phase === 'streaming' ? status.sessionId : null;
  });
  const bindLiveFilter = (sessionId: string, scan: FilterScan): (() => void) =>
    liveFilters.bind(sessionId, scan);
  // Live stream (L1) — the one place a `start_adb_stream` result becomes a
  // registered session (tab, focus) and a stopped one becomes an ordinary
  // postmortem session again. Built before `actions` so `close()` can stop a
  // running stream before its session closes; `benchDriver.ts`'s
  // `startStream`/`stopStream` and `stream-controls`'s panel below both drive
  // this same instance — see its own module doc for why that's the point.
  // `analyzers` is passed in (L3) so batched `AdbProcessorUpdate`/
  // `AdbProcessorsExcluded` Channel messages feed the analyzer cards' live
  // counters — see `streamStore.ts`'s module doc. `filter` (L4) closes the
  // gap L1 left open: `createStreamSession`'s own doc comment named this as
  // unwired because `FilterScan` had no AST/pids accessor and `query/` was
  // out of L1's scope — both now exist (`FilterScan.currentFilter()` /
  // `.appendMatches()`), and `liveFilters` above is what resolves the batch's
  // own session to the `FilterScan` that owns it.
  const liveStream = createLiveStreamStore({
    cacheManager,
    registry,
    sessions: store,
    analyzers,
    clearError: () => actions.clearError(),
    filter: liveFilters.hooks,
  });
  const actions = createAppActions({ store, controller, stopLiveSession: liveStream.stopIfCurrent });
  // Query bar (W2b) — reads/writes per-session query state and plugs its
  // `SearchQuery` provider into the session store's `fetchLines`.
  const queryStore = createQueryStore({ cacheManager, controller, sessions: store });
  onCleanup(() => {
    queryStore.dispose();
    liveStream.dispose();
    store.dispose();
    controller.dispose();
  });

  // Split panes (S1) — a second `viewer`-region pane, independent of the tab
  // strip: the primary pane always shows the focused session, unchanged from
  // before this package; the secondary pane shows whichever open session its
  // own picker selects. Per-session state (cursor, query, view mode) already
  // lives on the controller keyed by session id, so two panes showing two
  // different sessions get separate cursor/query state for free — no
  // controller change was needed for that half of the task. `ViewerSplit`
  // (shell/) is the split's chrome; wiring below is only which session/pane
  // goes where.
  const splitView = createSplitView();
  // The app's ONE tier subscription (review B-L6). `createTier()` registers
  // three `matchMedia` listeners and mirrors the result onto
  // `<html data-tier>`; `AppShell` and `ViewerSplit` used to create their own
  // as well, so three ran and two wrote the same attribute. Both now take it
  // as a prop. It is read here directly to gate the "Split view" control.
  const tier = createTier();

  // A session closing — from this UI or a foreign (agent) close, neither of
  // which routes through a single call site — must not leave the secondary
  // pane pointing at an id nothing can resolve any more.
  createEffect(
    on(store.order, (order, previousOrder) => {
      if (!previousOrder) return;
      for (const id of previousOrder) {
        if (!order.includes(id)) splitView.handleSessionClosed(id);
      }
    }),
  );

  // `ViewerSplit`'s picker already excludes the focused session from the
  // secondary pane's options, but the *primary* pane's session can also
  // change from underneath the split — the tab strip switches focus straight
  // to whatever session the secondary pane is already showing. Without this,
  // both panes would end up rendering the same session, which would also
  // make them share its cursor/query state (that state is keyed by session
  // id on the controller, not by pane — see `ViewerSplitProps.secondaryOptions`).
  createEffect(
    on(store.focusedId, (focusedId) => {
      if (focusedId !== null && focusedId === splitView.secondarySessionId()) {
        splitView.setSecondarySession(null);
      }
    }),
  );

  // Sections navigator (W3) — bugreport/dumpstate section tree for the
  // focused session; couples to the app only through the controller and
  // session store, same as every other surface.
  const sections = createSectionsStore({ sessions: store, controller });
  onCleanup(() => sections.dispose());

  // Analyses (W6) — workspace-owned analysis artifacts: list, reader,
  // publish/update/delete. Couples to the app only through the controller
  // and session store, same as the sections navigator above.
  const analyses = createAnalysesStore({ sessions: store, controller });
  onCleanup(() => analyses.dispose());

  // Bookmarks (W7) — per-session line pins, categories, create-from-cursor,
  // markdown export. Couples to the app only through the controller and
  // session store, same as sections/analyses above.
  // `anonymizerMode` is read lazily: `settings` is built further down (it needs
  // `presence`), and the accessor is only ever called from an export click.
  const bookmarks = createBookmarksStore({
    sessions: store,
    controller,
    anonymizerMode: () => settings.anonymizerMode(),
  });
  onCleanup(() => bookmarks.dispose());

  // Workspace home + switcher (W1b) — the workspace list, open/save/switch,
  // rename/delete over B3's wrappers. `store`/`actions` already satisfy the
  // structural `WorkspaceSessions`/`WorkspaceSessionActions` deps, so no
  // adapter is needed.
  //
  // `shellLayout` round-trips three of `SolidLayout`'s four shell-state
  // fields (S1c):
  //  - `split` — S1's viewer-region split pane, via `splitView` as before.
  //  - `columns` — `AppShell`'s per-region splitter widths. `AppShell` hands
  //    back its live `RegionWidths` store through `onReady` below (the
  //    `shellBox` forward reference, same trick `editorStoreBox` uses two
  //    lines down); `read()` snapshots it, `apply()` seeds it. Region widths
  //    were already per-workspace before this — `Splitter.ts`'s
  //    `localStorage` keyed them by workspace id — so this moves the source
  //    of truth into the `.ltw` blob (portable across machines) while
  //    `localStorage` stays as the per-machine fallback for a region the
  //    blob has no entry for (an older save, or a region added later).
  //  - `collapsed` — two things in one array, distinguished by a prefix so
  //    older blobs keep reading correctly. The rail's open-drawer id
  //    (`AppShell`'s `openDrawer`) is written bare, as a 0-or-1-element
  //    head; each collapsed grid region follows it as `region:<id>`
  //    (`ShellLayoutHandle.collapse.toEntries`). `apply()` takes the FIRST
  //    entry without the `region:` prefix as the drawer id and hands the
  //    whole array to `collapse.applyEntries`, which ignores everything
  //    else. Both are part of the arrangement a user made for a workspace,
  //    the same way the split and the column widths are; the drawer id is
  //    re-validated against the restoring window's own tier/mode
  //    (`ShellLayoutHandle.applyDrawer`) instead of springing open a drawer
  //    that no longer applies, and an unknown region id is dropped.
  //
  // `tabs`/`activeTab` are deliberately left empty. The tab strip's order
  // and selection are already fully determined by the restored session
  // order and focused session (`applyRestore` replays the manifest through
  // `store.order()`/`actions.focus`), so persisting a second copy of "which
  // tab is where" here would just be a second source of truth for the same
  // thing, free to drift from the first on the next reorder.
  //
  // `getEditorTabs` closes over a forward reference: the workspace store must
  // exist before `createEditorStore` (the editor store reads the workspace's
  // pending-tabs signal), but the workspace store's own constructor is where
  // W9's save-time provider is injected. A boxed reference filled in right
  // after breaks the cycle without changing W1a's `WorkspaceStoreDeps` shape.
  const editorStoreBox: { current?: Pick<EditorStore, 'toLtwTabs'> } = {};
  // Same forward-reference trick for `AppShell`'s region-width store and
  // open-drawer state — `AppShell` is only constructed below, in the JSX
  // this function returns, but `onReady` fires during that construction
  // (Solid runs a component's setup body once, synchronously), which is
  // still before `startupRestore()`/`openWorkspace()` ever call `apply()`
  // (both run from `onMount`, which fires only after the whole initial
  // render — including `AppShell`'s own setup — has completed).
  const shellBox: { current?: ShellLayoutHandle } = {};
  const workspace = createWorkspaceStore({
    sessions: store,
    actions,
    getEditorTabs: () => editorStoreBox.current?.toLtwTabs() ?? [],
    shellLayout: {
      read: () => ({
        columns: shellBox.current?.widths.toColumns() ?? {},
        collapsed: (() => {
          const id = shellBox.current?.openDrawer() ?? null;
          const regions = shellBox.current?.collapse.toEntries() ?? [];
          return id === null ? regions : [id, ...regions];
        })(),
        tabs: [],
        activeTab: null,
        split: splitView.toLayout(),
      }),
      apply: (layout) => {
        shellBox.current?.widths.applyColumns(layout.columns);
        shellBox.current?.applyDrawer(
          layout.collapsed.find((entry) => !entry.startsWith(REGION_ENTRY_PREFIX)) ?? null,
        );
        shellBox.current?.collapse.applyEntries(layout.collapsed);
        splitView.applyLayout(layout.split);
      },
    },
  });
  onCleanup(() => workspace.dispose());

  // Editor tabs (W9) — scratch/file documents opened alongside sessions, with
  // dirty tracking and Save/Save As. Restore is pull-based: this store reads
  // `workspace.pendingEditorTabs()` reactively and adopts them once.
  const editorStore = createEditorStore({ workspace });
  editorStoreBox.current = editorStore;
  onCleanup(() => editorStore.dispose());

  /** Which half of the merged tab strip is currently shown in the viewer
   *  region — a session's `LogViewer` or an editor document. Set by
   *  `selectTab`; `closeTab` falls back to `'session'` when closing the last
   *  editor tab leaves nothing for `'editor'` to point at. */
  const [activeSurface, setActiveSurface] = createSignal<'session' | 'editor'>('session');

  const selectTab = (key: string, kind: 'session' | 'editor'): void => {
    if (kind === 'editor') {
      editorStore.setActive(key);
      setActiveSurface('editor');
    } else {
      actions.focus(key);
      setActiveSurface('session');
    }
  };

  /** Refuses to close a dirty document rather than silently discarding it —
   *  `window.confirm` only offers a binary choice, so "discard" is reached by
   *  cancelling here and using a future dedicated dialog (see this task's
   *  implementation notes). */
  const confirmEditorClose: ConfirmClose = async (doc) =>
    window.confirm(`"${doc.label}" has unsaved changes. Save before closing?`) ? 'save' : 'cancel';

  const closeTab = (key: string, kind: 'session' | 'editor'): void => {
    if (kind === 'editor') {
      // A one-shot read of the current value once the close settles, not a
      // reactive binding — there is nothing here for a tracked scope to own.
      // eslint-disable-next-line solid/reactivity -- snapshot after close settles, by design (see above)
      void editorStore.close(key, confirmEditorClose).then(() => {
        if (activeSurface() === 'editor' && editorStore.activeId() === null) setActiveSurface('session');
        // A cancelled Save-As dialog resolves (see `editorStore.close`'s own
        // handling), so a rejection here is always a real write failure — the
        // tab stayed open and dirty (close() never reached `removeTab`); this
        // just keeps it from becoming an unhandled rejection and reuses the
        // same `actions.reportError` plumbing `EditorTabs`'s `onError` uses.
      }).catch((e: unknown) => actions.reportError(String(e)));
    } else {
      // A close the backend rejects has already dropped the tab; swallowing
      // keeps it out of the unhandled-rejection channel.
      void actions.close(key).catch(() => undefined);
    }
  };

  // Agent presence (A2). An agent's navigation request routes through the
  // controller, which focuses the right session and jumps the pane.
  const presence = createPresenceStore({
    navigate: (target) =>
      controller.scrollToLine(target.sessionId, target.line ?? 0, {
        highlight: true,
        source: 'agent',
      }),
  });
  onCleanup(() => presence.dispose());

  // Device state + timeline (W5) — cursor-tied state-tracker snapshot, field
  // diffs, transition navigation, and the on-demand timeline strip. Reads
  // W4a's `analyzers` store for which trackers are active and when the
  // pipeline last ran; couples to the app only through those plus the
  // controller and session store, same as every other surface.
  const deviceState = createDeviceStateStore({ sessions: store, controller, analyzers });
  onCleanup(() => deviceState.dispose());

  // Export (W8) — session/processor counts and the `.lts` export run for
  // the `export` rail surface. The open editor documents ride along, read at
  // export time (`editorStore` is built above, so no forward reference here).
  const exportStore = createExportStore({ getEditorTabs: () => editorStore.toLtwTabs() });
  onCleanup(() => exportStore.dispose());

  // Settings (W8) — General/PII/Themes/Sources tabs for the `settings` rail
  // surface. Reuses A2's `presence.status` (`McpStatus`, already polled
  // every 5s) instead of polling the bridge a second time. `refreshMcpStatus`
  // is the undebounced re-read the security-relevant setters call after a
  // write, so a rejected raw-access toggle is corrected from the backend at
  // once rather than after the next poll.
  //
  // `onAnonymizerModeChanged`: the viewer is the one in-app surface whose
  // *content* the anonymizer mode changes — `get_lines` redacts a Ui page
  // only under `All` — so entering or leaving `All` refetches every open
  // session's lines. That is `replace()`'s own recipe (`app/sessions.ts`):
  // drop the cached content, discard in-flight pages, and bump the
  // controller's revision through `setViewMode` re-set to its current value
  // (the documented unconditional bump `createCacheBinding` resets on). A
  // search's highlights ride the refetched page (the backend recomputes them
  // on the redacted text); a filter's line set is unchanged by design — the
  // backend scans raw text in every mode, so the matched set is the same.
  // Live sessions are included: their batches to the Ui follow the same
  // decision, and `get_lines` serves a stream's retained lines like a file's.
  const refetchSessionLines = (sessionId: string): void => {
    const entry = store.byId(sessionId);
    if (!entry) return;
    cacheManager.clearSession(sessionId);
    entry.dataSource.invalidate();
    controller.setViewMode(sessionId, controller.viewMode(sessionId));
  };
  const settings = createSettingsStore({
    mcpStatus: presence.status,
    refreshMcpStatus: presence.refreshStatus,
    onAnonymizerModeChanged: (prev, next) => {
      if (prev !== 'all' && next !== 'all') return;
      for (const id of untrack(store.order)) refetchSessionLines(id);
    },
  });
  onCleanup(() => settings.dispose());
  // The pinned PII card renders the mode from the persisted config, and the
  // General tab's raw-access checkbox is gated on it — load it once here
  // rather than only when Settings → PII mounts.
  onMount(() => settings.refreshAnonymizerConfig());
  /** An agent is talking to the bridge right now: the orb is anything but
   *  `detached` (which already folds in `running` and the idle threshold). */
  const agentConnected = (): boolean =>
    (presence.status()?.running ?? false) && presence.agent.state() !== 'detached';
  const bridgeRunning = (): boolean => presence.status()?.running ?? false;
  /**
   * Bring the Analyzers panel into view — the export dialog's "Change" link
   * for the anonymizer mode, whose only writer is that panel's pinned card.
   * On compact the panel is a rail drawer (`applyDrawer` opens it, and one
   * drawer at a time means the export drawer goes away); on standard and
   * wider it is the `details` column, which may be folded — unfold it. Both
   * calls are no-ops where they do not apply, same as the analyses opener.
   */
  const showAnalyzers = (): void => {
    shellBox.current?.applyDrawer('analyzers');
    shellBox.current?.collapse.set('details', false);
  };

  // Packs (P1) — the remote marketplace half (browse/install/uninstall/
  // update) for the Packs tab now mounted where `settings` used to hold a
  // standalone Sources tab. `sources`/`refreshSources` are `settings`'s own
  // (SourcesTab remains the only place a source is added or removed — see
  // `PacksPanel.tsx`'s doc comment).
  const packs = createPacksStore({
    sources: settings.sources,
    refreshSources: settings.refreshSources,
  });
  onCleanup(() => packs.dispose());

  // The installed catalog changed — a processor or pack was installed,
  // uninstalled or updated, by this UI's Packs tab or by an agent over the
  // bridge (F1). This listener is the ONE path by which either store learns
  // of it: `analyzers` re-fetches its catalog (every session's "Add analyzer"
  // list and the cards' names), `packs` its installed set (the "already
  // added" badges). A UI-initiated install reaches `analyzers` through this
  // same echo rather than a direct store-to-store callback, so an agent's
  // install and a human's are indistinguishable downstream. Both refreshes
  // are fire-and-forget: a failed re-fetch leaves the previous catalog in
  // place, which is no worse than not having heard the event at all.
  const catalogListener = onCatalogUpdate(() => {
    void analyzers.refreshCatalog();
    void packs.refreshInstalled();
  });
  onCleanup(() => {
    // Unlisten-safe: a `listen()` promise that settles after this root is
    // disposed unlistens itself instead of leaking (same pattern as every
    // store's `track()`).
    void catalogListener.then((unlisten) => unlisten()).catch(() => undefined);
  });

  /** Who last ran this session's pipeline, from the presence journal — the
   *  analyzers surface has no journal access of its own (A2 owns that). */
  const lastRunCaller = (sessionId: string): CallerLike | null => {
    const entries = presence.entries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.sessionId === sessionId && entry.action === 'pipeline.run') return entry.caller;
    }
    return null;
  };

  // Watches (L2) — per-session live watches: list, create, cancel, running
  // match-count badges. Couples to the app only through the session store
  // (no controller: see `watches/watchesStore.ts`'s doc comment for why
  // there is no line-level data to route through it).
  const watches = createWatchesStore({ sessions: store });
  onCleanup(() => watches.dispose());

  /** A watch's caller, from the same presence journal `lastRunCaller` reads
   *  above — `WatchInfo` carries no caller field (see `watchesStore.ts`'s
   *  doc comment, point 2), so this is the only place that information
   *  exists on the frontend. `watch.create`'s journalled summary is exactly
   *  `"watch {watch_id}"` (`services/watches.rs`). */
  const watchCaller = (watchId: string, sessionId: string): CallerLike | null => {
    const entries = presence.entries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.sessionId === sessionId &&
        entry.action === 'watch.create' &&
        entry.summary === `watch ${watchId}`
      ) {
        return entry.caller;
      }
    }
    return null;
  };

  const tabs = createMemo<TabDescriptor[]>(() => [
    ...store.order().map((id) => ({
      key: id,
      label: store.byId(id)?.load.sourceName ?? id,
      kind: 'session' as const,
      closable: true,
    })),
    ...editorStore.tabs().map((doc) => ({
      key: doc.id,
      label: doc.label,
      kind: 'editor' as const,
      dirty: editorStore.isDirty(doc.id),
      closable: true,
    })),
  ]);

  /** Rows a pane's viewer sizes its spacer for: the line set's, when one is set. */
  const renderedLineCountFor = (entry: SessionEntry): number =>
    controller.lineNumbers(entry.load.sessionId)?.length ?? entry.totalLines;

  const renderedLineCount = (): number => {
    const entry = store.focused();
    return entry ? renderedLineCountFor(entry) : 0;
  };

  // Both of these are side effects, so they belong in `onMount`, not in the
  // render body (project rule; review A-M8). `hydrate()` only catches its
  // first `getAppState` — every later await, and all of `startupRestore`
  // (`consumeStartupFile`, `applyRestore`), could reject into nothing, so a
  // workspace that fails to restore used to surface as an unhandled rejection
  // the user never saw. It goes on the same error line every other failure
  // uses; `workspace.warnings()` still carries the per-file detail.
  onMount(() => {
    void workspace
      .hydrate()
      .then(() => workspace.startupRestore())
      .catch((e: unknown) => actions.reportError(`Workspace restore failed: ${String(e)}`));

    if (isBenchMode()) installBenchApp({ actions, stream: liveStream });
  });

  const newDocument = (): void => {
    editorStore.newDoc();
    setActiveSurface('editor');
  };

  // Owned here rather than inside `SessionInfo` so the sections navigator's
  // "File info" button (beside the device model and date span, where the user
  // looks for it) and the footer chip drive the same popover.
  const [sessionInfoOpen, setSessionInfoOpen] = createSignal(false);

  const openInEditor = async (): Promise<void> => {
    const selected = await openDialog({
      multiple: false,
      filters: [
        { name: 'Text Files', extensions: ['md', 'markdown', 'txt', 'yaml', 'yml'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected !== 'string') return;
    try {
      await editorStore.open(selected);
      setActiveSurface('editor');
    } catch (e) {
      actions.reportError(String(e));
    }
  };

  // Global shortcuts (C3) — one `window` `keydown` listener for the whole
  // app: Ctrl/Cmd+N new workspace, +O open file, +Shift+O open in editor,
  // +Shift+S save workspace, +Shift+E open export. Plain Ctrl+S is
  // deliberately excluded (`shortcuts.ts`'s module doc) — it stays
  // `EditorTabs.tsx:58`'s own listener.
  //
  // `openExport` has no imperative "open" call of its own to reach: the
  // export surface is a rail drawer whose open/closed state is private to
  // `AppShell` (`shell/AppShell.tsx`, out of this package's ownership — see
  // this task's implementation-notes for the follow-up this should get). The
  // rail button is the one affordance already public outside `shell/`, at a
  // fixed rail placement in every mode/tier (`shell/surfaces.ts`'s `export`
  // entry), so this invokes it exactly as a click would, scoped to the rail
  // nav so it can never match a same-named control inside a drawer body.
  onMount(() => {
    const openExport = (): void => {
      document
        .querySelector<HTMLButtonElement>('nav[aria-label="Surfaces"] button[title="Export"]')
        ?.click();
    };
    const disposeShortcuts = installShortcuts({
      newWorkspace: () =>
        void workspace.newWorkspace().catch((e: unknown) => actions.reportError(String(e))),
      openFileDialog: () => void actions.openFileDialog(),
      openInEditor: () => void openInEditor(),
      saveWorkspace: () =>
        void workspace.saveWorkspace().catch((e: unknown) => actions.reportError(String(e))),
      openExport,
      isBusy: actions.busy,
    });
    onCleanup(disposeShortcuts);
  });

  const topBar = (
    <>
      <Switcher store={workspace} />
      <button
        type="button"
        class={styles.openButton}
        onClick={() => void actions.openFileDialog()}
        disabled={actions.busy()}
      >
        Open file…
      </button>
      {/* The editor's own toolbar only exists once a document is open, so the
          first document has to be created from here (found by the phase 2b
          parity smoke: with these on the editor toolbar alone, the editor was
          unreachable). Both switch the viewer region to the editor surface. */}
      <button type="button" class={styles.openButton} onClick={newDocument}>
        New document
      </button>
      <button type="button" class={styles.openButton} onClick={() => void openInEditor()}>
        Open in editor…
      </button>
      <button
        type="button"
        class={styles.openButton}
        onClick={() => splitView.split()}
        disabled={splitView.active() || !isSplitTier(tier())}
        title={isSplitTier(tier()) ? undefined : 'Widen the window to split the viewer'}
      >
        Split view
      </button>
    </>
  );


  // Status line (footer). The session name and line count, the loading
  // indicator and the last failure all lived in the top bar beside the action
  // buttons, so a long error message pushed the window controls off the end
  // and a healthy session's count sat between two buttons as if it were one.
  // The user asked for these in the footer: they are state, not actions, and
  // the shell has reserved a status bar for exactly this since the shell
  // landed. Order is left to right by how often it changes — the session line
  // is stable, the busy flag is transient, and an error deserves the eye last.
  const statusBar = (
    <>
      <Show when={store.focused()}>
        {(entry) => (
          <SessionInfo
            entry={entry()}
            open={sessionInfoOpen}
            onOpenChange={setSessionInfoOpen}
            // Bugreport/dumpstate device fields the sections store already
            // fetches for the focused session (`sections/sectionsStore.ts`'s
            // `metadata()`) — no second `getDumpstateMetadata` call here.
            metadata={sections.metadata()}
            onReopenAs={(sourceType) => {
              const path = entry().load.filePath;
              if (!path) return;
              // Same tab, same id — see `SessionInfo.tsx`'s doc comment for
              // why this must not close the session first.
              void actions
                .openPath(path, { sourceType, replace: true })
                .catch((e: unknown) => actions.reportError(String(e)));
            }}
          />
        )}
      </Show>
      <Show when={actions.busy()}>
        <span class={styles.session}>Loading…</span>
      </Show>
      {/* Restore warnings live on workspace home (the store keeps them until
          dismissed); the footer only points there, since a restore that
          reopened some sessions may have closed the home drawer. */}
      <Show when={workspace.warnings().length > 0}>
        <span class={styles.warning} data-testid="status-restore-warnings">
          {workspace.warnings().length === 1
            ? '1 restore warning — see Workspace'
            : `${workspace.warnings().length} restore warnings — see Workspace`}
        </span>
      </Show>
      <Show when={actions.error()}>
        <span class={styles.error} role="alert">
          {actions.error()}
          <button
            type="button"
            class={styles.errorDismiss}
            aria-label="Dismiss error"
            title="Dismiss"
            onClick={actions.clearError}
          >
            ×
          </button>
        </span>
      </Show>
    </>
  );

  return (
    <>
      <AppShell
        workspaceId={workspace.activeId() ?? WORKSPACE_ID}
        sessionKind={store.focused()?.kind ?? null}
        tier={tier}
        // Land on workspace home when the app opens with nothing loaded, so A1's
        // attach-a-device and open-a-capture actions are the first thing seen
        // rather than sitting behind a rail glyph. Read once by the shell, so a
        // restore that populates sessions a moment later does not yank it away,
        // and closing it makes it stay closed.
        initialDrawer={store.order().length === 0 ? 'workspace-home' : null}
        // See the `shellBox` comment above `createWorkspaceStore`: this is
        // the forward reference the `shellLayout` port reads and seeds.
        onReady={(handle) => {
          shellBox.current = handle;
        }}
        topBar={topBar}
        statusBar={statusBar}
        slots={{
          'workspace-home': () => (
            <WorkspaceHome
              store={workspace}
              sessions={store}
              actions={actions}
              liveStream={liveStream}
              anonymizerMode={settings.anonymizerMode}
              // The same path as clicking the session's tab: focus it AND show
              // the session surface (the editor may be in front), then put the
              // home drawer away so the file is actually visible — a no-op on
              // tiers where the home is a column.
              onFocusSession={(id) => {
                selectTab(id, 'session');
                shellBox.current?.applyDrawer(null);
              }}
              bookmarks={<BookmarksPanel store={bookmarks} sessions={store} />}
              analyses={
                <AnalysesIndex
                  store={analyses}
                  // On compact the analyses surface is a drawer; `applyDrawer`
                  // opens it only where it IS a drawer (standard and wider
                  // already show it as a column), so this is a no-op there.
                  onOpen={() => shellBox.current?.applyDrawer('analyses')}
                />
              }
            />
          ),
          presence: () => <PresencePanel store={presence} />,
          sections: () => (
            <SectionsPanel
              store={sections}
              sourceName={store.focused()?.load.sourceName}
              firstTimestamp={store.focused()?.load.firstTimestamp}
              lastTimestamp={store.focused()?.load.lastTimestamp}
              // A toggle, not an opener: a second click on the same button is
              // the natural way to put the popover away again.
              onShowFileInfo={store.focused() ? () => setSessionInfoOpen((v) => !v) : undefined}
            />
          ),
          analyzers: () => (
            <Show when={store.focused()}>
              {(entry) => (
                <AnalyzersPanel
                  store={analyzers}
                  controller={controller}
                  sessionId={entry().load.sessionId}
                  sessionName={entry().load.sourceName}
                  lastRunCaller={lastRunCaller}
                  anonymizerMode={settings.anonymizerMode}
                  setAnonymizerMode={settings.setAnonymizerMode}
                  bridgeRunning={bridgeRunning}
                  agentConnected={agentConnected}
                  anonymizerLoading={() => settings.anonymizerConfig() === null}
                  onOpenDeviceState={(processorId) =>
                    deviceState.setSelectedTracker(entry().load.sessionId, processorId)
                  }
                />
              )}
            </Show>
          ),
          'device-state': () => (
            <Show when={store.focused()}>
              {(entry) => <DeviceStatePanel store={deviceState} sessionId={entry().load.sessionId} />}
            </Show>
          ),
          analyses: () => <AnalysesPanel store={analyses} />,
          watches: () => <WatchesPanel store={watches} sessions={store} callerFor={watchCaller} />,
          viewer: () => (
            <ViewerSplit
              split={splitView}
              tier={tier}
              // The same session can never be picked for both panes — cursor,
              // query and view-mode state are keyed by session id on the
              // controller, not by pane, so showing one session in two panes
              // would make them share that state instead of each having its own.
              secondaryOptions={() => {
                const primaryId = store.focusedId();
                return store
                  .order()
                  .filter((id) => id !== primaryId)
                  .map((id) => ({ sessionId: id, label: store.byId(id)?.load.sourceName ?? id }));
              }}
              primary={() => (
                <>
                  <TabStrip
                    tabs={tabs()}
                    activeKey={activeSurface() === 'editor' ? editorStore.activeId() : store.focusedId()}
                    onSelect={(key) => selectTab(key, tabs().find((t) => t.key === key)?.kind ?? 'session')}
                    onClose={(key) => closeTab(key, tabs().find((t) => t.key === key)?.kind ?? 'session')}
                  />
                  <Show
                    when={activeSurface() === 'editor' && editorStore.active()}
                    fallback={
                      <Show
                        when={store.focused()}
                        fallback={<div class={styles.empty}>No log open. Choose a file to begin.</div>}
                      >
                        {(entry) => (
                          <>
                            {/* Keyed on the session id: QueryBar snapshots its session at
                                mount by design, so it must be remounted per session. The
                                outer non-keyed Show does NOT remount on a truthy→truthy
                                switch between two open tabs. */}
                            <Show when={entry().load.sessionId} keyed>
                              {(sid) => (
                                <QueryBar
                                  sessionId={sid}
                                  store={queryStore}
                                  controller={controller}
                                  active={splitView.activePane() === 'main'}
                                  bindLiveFilter={bindLiveFilter}
                                />
                              )}
                            </Show>
                            <LogViewer
                              dataSource={entry().dataSource}
                              totalLineCount={renderedLineCount()}
                              sessionId={entry().load.sessionId}
                              tailMode={entry().kind === 'live'}
                              controller={controller}
                              onError={actions.reportError}
                              onActivate={() => splitView.setActivePane('main')}
                            />
                          </>
                        )}
                      </Show>
                    }
                  >
                    <EditorTabs store={editorStore} onError={actions.reportError} />
                  </Show>
                </>
              )}
              secondary={(sessionId) => (
                <Show
                  when={store.byId(sessionId)}
                  fallback={<div class={styles.empty}>That session is no longer open.</div>}
                >
                  {(entry) => (
                    <>
                      <Show when={entry().load.sessionId} keyed>
                        {(sid) => (
                          <QueryBar
                            sessionId={sid}
                            store={queryStore}
                            controller={controller}
                            active={splitView.activePane() === 'secondary'}
                            bindLiveFilter={bindLiveFilter}
                          />
                        )}
                      </Show>
                      <LogViewer
                        dataSource={entry().dataSource}
                        totalLineCount={renderedLineCountFor(entry())}
                        sessionId={entry().load.sessionId}
                        tailMode={entry().kind === 'live'}
                        controller={controller}
                        paneId={SECONDARY_PANE_ID}
                        onError={actions.reportError}
                        onActivate={() => splitView.setActivePane('secondary')}
                      />
                    </>
                  )}
                </Show>
              )}
            />
          ),
          timeline: () => (
            <Show when={store.focused()}>
              {(entry) => (
                <TimelineStrip
                  store={deviceState}
                  controller={controller}
                  sessionId={entry().load.sessionId}
                  totalLines={entry().totalLines}
                />
              )}
            </Show>
          ),
          export: () => (
            <ExportDialog store={exportStore} anonymizerMode={settings.anonymizerMode} onChangeMode={showAnalyzers} />
          ),
          settings: () => <SettingsPanel store={settings} packs={packs} theme={props.theme} />,
          'stream-controls': () => (
            <StreamControlsPanel store={liveStream} anonymizerMode={settings.anonymizerMode} />
          ),
        }}
      />
      {/* Launch-time updates prompt — over the whole window, whatever surface
          the app opened on. Session-long dismissal lives in the packs store. */}
      <Show when={packs.updatePromptOpen()}>
        <UpdatesPrompt store={packs} />
      </Show>
    </>
  );
}
