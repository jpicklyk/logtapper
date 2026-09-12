/** @jsxImportSource solid-js */
import { Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  CacheManager,
  DataSourceRegistry,
  LogViewer,
  createViewerController,
} from './viewer';
import { createAppActions, createSessionStore, installBenchApp, isBenchMode } from './app/index';
import { AppShell, TabStrip } from './shell';
import type { TabDescriptor } from './shell';
import { QueryBar, createQueryStore } from './query';
import { PresencePanel, createPresenceStore } from './presence';
import { EditorTabs, createEditorStore } from './editor';
import type { ConfirmClose, EditorStore } from './editor';
import { SectionsPanel, createSectionsStore } from './sections';
import { AnalyzersPanel, createAnalyzerStore } from './analyzers';
import type { CallerLike } from './ui';
import { AnalysesPanel, createAnalysesStore } from './analyses';
import { DeviceStatePanel, TimelineStrip, createDeviceStateStore } from './devicestate';
import { BookmarksPanel, createBookmarksStore } from './bookmarks';
import { Switcher, WorkspaceHome, createWorkspaceStore } from './workspace';
import { ExportDialog, createExportStore } from './export';
import { SettingsPanel, createSettingsStore } from './settings';
import type { ThemeController } from './theme/applyTheme';
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
  const actions = createAppActions({ store, controller });
  // Query bar (W2b) — reads/writes per-session query state and plugs its
  // `SearchQuery` provider into the session store's `fetchLines`.
  const queryStore = createQueryStore({ cacheManager, controller, sessions: store });
  onCleanup(() => {
    queryStore.dispose();
    store.dispose();
    controller.dispose();
  });

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
  const bookmarks = createBookmarksStore({ sessions: store, controller });
  onCleanup(() => bookmarks.dispose());

  // Workspace home + switcher (W1b) — the workspace list, open/save/switch,
  // rename/delete over B3's wrappers. `store`/`actions` already satisfy the
  // structural `WorkspaceSessions`/`WorkspaceSessionActions` deps, so no
  // adapter is needed. `shellLayout` is not wired yet — that needs a port out
  // of `shell/Splitter.ts`, which is outside this file's scope (see W1a's own
  // "Ask for W1b" in its implementation notes); until then a save/restore
  // round-trips only React's layout keys, never Solid's own pane widths.
  //
  // `getEditorTabs` closes over a forward reference: the workspace store must
  // exist before `createEditorStore` (the editor store reads the workspace's
  // pending-tabs signal), but the workspace store's own constructor is where
  // W9's save-time provider is injected. A boxed reference filled in right
  // after breaks the cycle without changing W1a's `WorkspaceStoreDeps` shape.
  const editorStoreBox: { current?: Pick<EditorStore, 'toLtwTabs'> } = {};
  const workspace = createWorkspaceStore({
    sessions: store,
    actions,
    getEditorTabs: () => editorStoreBox.current?.toLtwTabs() ?? [],
  });
  onCleanup(() => workspace.dispose());
  void workspace.hydrate().then(() => workspace.startupRestore());

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

  // Analyzers (W4a store + W4b surface) — per-session pipeline chain, run
  // lifecycle and results; card clicks route matched lines through the same
  // controller every other surface uses.
  const analyzers = createAnalyzerStore({ sessions: store, controller });
  onCleanup(() => analyzers.dispose());

  // Device state + timeline (W5) — cursor-tied state-tracker snapshot, field
  // diffs, transition navigation, and the on-demand timeline strip. Reads
  // W4a's `analyzers` store for which trackers are active and when the
  // pipeline last ran; couples to the app only through those plus the
  // controller and session store, same as every other surface.
  const deviceState = createDeviceStateStore({ sessions: store, controller, analyzers });
  onCleanup(() => deviceState.dispose());

  // Export (W8) — session/processor counts and the `.lts` export run for
  // the `export` rail surface.
  const exportStore = createExportStore();
  onCleanup(() => exportStore.dispose());

  // Settings (W8) — General/PII/Themes/Sources tabs for the `settings` rail
  // surface. Reuses A2's `presence.status` (`McpStatus`, already polled
  // every 5s) instead of polling the bridge a second time.
  const settings = createSettingsStore({ mcpStatus: presence.status });
  onCleanup(() => settings.dispose());

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

  /** Rows the viewer sizes its spacer for: the line set's, when one is set. */
  const renderedLineCount = (): number => {
    const entry = store.focused();
    if (!entry) return 0;
    return controller.lineNumbers(entry.load.sessionId)?.length ?? entry.totalLines;
  };

  if (isBenchMode()) installBenchApp({ actions, store, cacheManager, registry });

  const newDocument = (): void => {
    editorStore.newDoc();
    setActiveSurface('editor');
  };

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
      <Show when={store.focused()}>
        {(entry) => (
          <span class={styles.session}>
            {entry().load.sourceName} — {entry().totalLines.toLocaleString()} lines
            <Show when={entry().isIndexing}> (indexing…)</Show>
          </span>
        )}
      </Show>
      <Show when={actions.busy()}>
        <span class={styles.session}>Loading…</span>
      </Show>
      <Show when={actions.error()}>
        <span class={styles.error}>{actions.error()}</span>
      </Show>
    </>
  );

  return (
    <AppShell
      workspaceId={workspace.activeId() ?? WORKSPACE_ID}
      sessionKind={store.focused()?.kind ?? null}
      topBar={topBar}
      slots={{
        'workspace-home': () => <WorkspaceHome store={workspace} sessions={store} actions={actions} />,
        presence: () => <PresencePanel store={presence} />,
        sections: () => (
          <SectionsPanel
            store={sections}
            sourceName={store.focused()?.load.sourceName}
            firstTimestamp={store.focused()?.load.firstTimestamp}
            lastTimestamp={store.focused()?.load.lastTimestamp}
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
        bookmarks: () => <BookmarksPanel store={bookmarks} sessions={store} />,
        viewer: () => (
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
                          <QueryBar sessionId={sid} store={queryStore} controller={controller} />
                        )}
                      </Show>
                      <LogViewer
                        dataSource={entry().dataSource}
                        totalLineCount={renderedLineCount()}
                        sessionId={entry().load.sessionId}
                        tailMode={entry().kind === 'live'}
                        controller={controller}
                      />
                    </>
                  )}
                </Show>
              }
            >
              <EditorTabs store={editorStore} onError={actions.reportError} />
            </Show>
          </>
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
        export: () => <ExportDialog store={exportStore} />,
        settings: () => <SettingsPanel store={settings} theme={props.theme} />,
      }}
    />
  );
}
