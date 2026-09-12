/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@bridge/commands';
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
import { EditorTab } from './editor';
import { SectionsPanel, createSectionsStore } from './sections';
import { AnalyzersPanel, createAnalyzerStore } from './analyzers';
import type { CallerLike } from './ui';
import { AnalysesPanel, createAnalysesStore } from './analyses';
import { DeviceStatePanel, TimelineStrip, createDeviceStateStore } from './devicestate';
import { BookmarksPanel, createBookmarksStore } from './bookmarks';
import { Switcher, WorkspaceHome, createWorkspaceStore } from './workspace';
import { BASE_THEMES } from './theme/applyTheme';
import type { Density, ThemeController, ThemeMode } from './theme/applyTheme';
import styles from './App.module.css';

/**
 * Composition root. Everything here is wiring: build the app-wide singletons,
 * hand them to each other, and place the surfaces in the shell.
 *
 * No state lives in this file beyond the editor demo's two signals. Sessions
 * are in `app/sessions.ts`, transitions in `app/actions.ts`, the rendered index
 * space in `viewer/controller.ts`, and the bench driver in `app/benchDriver.ts`.
 */

const CACHE_BUDGET = 100_000;

/** Fallback shell-layout key before the workspace store's `hydrate()` resolves
 *  an activeId (W1a/W1b own the real workspace list). */
const WORKSPACE_ID = 'default';

const THEME_MODES: readonly ThemeMode[] = ['system', ...BASE_THEMES];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];

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
  const workspace = createWorkspaceStore({ sessions: store, actions });
  onCleanup(() => workspace.dispose());
  void workspace.hydrate().then(() => workspace.startupRestore());

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

  // E1 demo: a text document in the `details` region. W9 turns this into real
  // editor tabs on the strip below; until then it is one document, not a tab.
  const [editorPath, setEditorPath] = createSignal<string | null>(null);
  const [editorContent, setEditorContent] = createSignal<string | null>(null);

  const openInEditor = async (): Promise<void> => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Text Files', extensions: ['md', 'markdown', 'txt', 'yaml', 'yml'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected !== 'string') return;
    try {
      setEditorContent(await readTextFile(selected));
      setEditorPath(selected);
    } catch (e) {
      actions.reportError(String(e));
    }
  };

  const tabs = createMemo<TabDescriptor[]>(() =>
    store.order().map((id) => ({
      key: id,
      label: store.byId(id)?.load.sourceName ?? id,
      kind: 'session' as const,
      closable: true,
    })),
  );

  /** Rows the viewer sizes its spacer for: the line set's, when one is set. */
  const renderedLineCount = (): number => {
    const entry = store.focused();
    if (!entry) return 0;
    return controller.lineNumbers(entry.load.sessionId)?.length ?? entry.totalLines;
  };

  if (isBenchMode()) installBenchApp({ actions, store, cacheManager, registry });

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
      <Show when={props.theme}>
        {(theme) => (
          <span class={styles.controls}>
            <label class={styles.control}>
              Theme
              <select
                class={styles.select}
                value={theme().mode()}
                onChange={(event) => theme().setMode(event.currentTarget.value as ThemeMode)}
              >
                <For each={THEME_MODES}>{(value) => <option value={value}>{value}</option>}</For>
              </select>
            </label>
            <label class={styles.control}>
              Density
              <select
                class={styles.select}
                value={theme().density()}
                onChange={(event) => theme().setDensity(event.currentTarget.value as Density)}
              >
                <For each={DENSITIES}>{(value) => <option value={value}>{value}</option>}</For>
              </select>
            </label>
          </span>
        )}
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
              activeKey={store.focusedId()}
              onSelect={actions.focus}
              // A close that the backend rejects has already dropped the tab;
              // swallowing keeps it out of the unhandled-rejection channel.
              onClose={(key) => void actions.close(key).catch(() => undefined)}
            />
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
      }}
      regionSlots={{
        // The editor tab is not a brief §4 surface, so it mounts through the
        // region escape hatch S1 provides rather than through `slots`.
        details: () => (
          <Show when={editorContent() !== null}>
            <EditorTab
              filePath={editorPath()}
              content={editorContent() ?? ''}
              onFilePathChanged={setEditorPath}
            />
          </Show>
        ),
      }}
    />
  );
}
