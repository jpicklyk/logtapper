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

/** Workspaces are a W1a surface; until then every session shares one id. */
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
      workspaceId={WORKSPACE_ID}
      sessionKind={store.focused()?.kind ?? null}
      topBar={topBar}
      slots={{
        presence: () => <PresencePanel store={presence} />,
        sections: () => (
          <SectionsPanel
            store={sections}
            sourceName={store.focused()?.load.sourceName}
            firstTimestamp={store.focused()?.load.firstTimestamp}
            lastTimestamp={store.focused()?.load.lastTimestamp}
          />
        ),
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
