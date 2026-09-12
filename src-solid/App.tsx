/** @jsxImportSource solid-js */
import { For, Show, createSignal, onCleanup } from 'solid-js';
import { open } from '@tauri-apps/plugin-dialog';
import { getLines, loadLogFile, readTextFile } from '@bridge/commands';
import {
  CacheManager,
  DataSourceRegistry,
  LogViewer,
  createCacheDataSource,
} from './viewer';
import type { CacheDataSource } from './viewer';
import { createStreamSession } from './viewer/createStreamSession';
import { AppShell } from './shell';
import type { SessionKind } from './shell';
import { PresencePanel, createPresenceStore } from './presence';
import type { NavTarget } from './presence';
import { EditorTab } from './editor';
import { BASE_THEMES } from './theme/applyTheme';
import type { Density, ThemeController, ThemeMode } from './theme/applyTheme';
import styles from './App.module.css';

/**
 * Solid spike shell: open a file, then show it in the virtualized viewer,
 * inside the §F layout shell.
 *
 * The cache manager and data-source registry are app-wide singletons — one each,
 * created once here. React builds them in `CacheProvider`; Solid has no provider
 * in the spike, so they are constructed directly (the barrel re-exports the
 * classes for exactly this reason).
 */

const CACHE_BUDGET = 100_000;
const VIEW_ID = 'solid-main';

/**
 * Workspaces are a 2b surface; until then every session shares one id, which is
 * the key the shell's column widths are stored under.
 */
const WORKSPACE_ID = 'default';

const THEME_MODES: readonly ThemeMode[] = ['system', ...BASE_THEMES];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];

/** Bench-only driver (`?bench=1`), so the gate can run without the native dialog. */
interface BenchApp {
  open(path: string): Promise<void>;
  startStream(deviceId?: string): Promise<string>;
  stopStream(): Promise<void>;
}

export interface AppProps {
  /**
   * The live theme/density controller, built in `main.tsx` before first paint.
   * Optional so tests can mount `App` without a `matchMedia` shim; the theme
   * selector only renders when one is supplied.
   */
  theme?: ThemeController;
}

export function App(props: AppProps) {
  const cacheManager = new CacheManager(CACHE_BUDGET);
  const registry = new DataSourceRegistry();

  const [dataSource, setDataSource] = createSignal<CacheDataSource | null>(null);
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [sessionKind, setSessionKind] = createSignal<SessionKind>(null);
  const [sourceName, setSourceName] = createSignal('');
  const [totalLines, setTotalLines] = createSignal(0);
  const [tailMode, setTailMode] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  // E1 demo: a text document open in the `details` region's editor tab. Separate
  // from the log session above — opening a note does not touch the viewer.
  const [editorPath, setEditorPath] = createSignal<string | null>(null);
  const [editorContent, setEditorContent] = createSignal<string | null>(null);

  const disposeSource = () => {
    dataSource()?.dispose?.();
    setDataSource(null);
  };
  onCleanup(disposeSource);

  // ── Agent presence (A2) ──────────────────────────────────────────────────
  // One store per app. Applying a navigation target cannot scroll the viewer
  // yet: `LogViewer` (P3) exposes no scroll-to-line prop or imperative handle,
  // so a target for the open session is recorded and shown rather than
  // applied. Switching to a *different* session is a 2b surface anyway.
  const [navTarget, setNavTarget] = createSignal<NavTarget | null>(null);
  const presence = createPresenceStore({ navigate: setNavTarget });
  onCleanup(() => presence.dispose());

  const navTargetText = () => {
    const target = navTarget();
    if (!target) return '';
    const where = target.sessionId === sessionId() ? 'here' : presence.sessionName(target.sessionId);
    const what =
      target.line !== undefined
        ? `line ${target.line}`
        : (target.analysisId ?? target.watchId ?? target.bookmarkId ?? 'session');
    return `Requested: ${where} · ${what}`;
  };

  /** Point the single viewer at a backend session (file or live stream). */
  const attachSession = (id: string, name: string, total: number, tail: boolean) => {
    disposeSource();
    cacheManager.releaseView(VIEW_ID);
    const viewCache = cacheManager.allocateView(VIEW_ID, id);

    const ds = createCacheDataSource({
      sessionId: id,
      viewCache,
      fetchLines: (offset, count) =>
        getLines({
          sessionId: id,
          mode: { mode: 'Full' },
          offset,
          count,
          context: 0,
          processorId: null,
          search: null,
        }),
      registry,
    });
    ds.updateTotalLines(total);

    setSessionId(id);
    setSourceName(name);
    setTotalLines(total);
    setTailMode(tail);
    setSessionKind(tail ? 'live' : 'file');
    setDataSource(ds);
  };

  const probeTotal = async (id: string) => {
    const head = await getLines({
      sessionId: id,
      mode: { mode: 'Full' },
      offset: 0,
      count: 1,
      context: 0,
      processorId: null,
      search: null,
    });
    return head.totalLines;
  };

  /**
   * Open a file session. `waitForIndex` (bench only) polls the line total until
   * it has been stable for two consecutive probes, so a benchmark sweeps the
   * whole file rather than whatever the indexer had reached at open time.
   * The UI path does not wait: subscribing to indexing events is a 2b item.
   */
  const openPath = async (path: string, waitForIndex = false) => {
    setError('');
    setLoading(true);
    try {
      const [result] = await loadLogFile(path);
      const id = result.sessionId;

      // Probe for the authoritative total before building the source, so the
      // viewer's spacer is correct on its very first paint.
      let total = await probeTotal(id);
      if (waitForIndex) {
        const deadline = Date.now() + 120_000;
        let previous = -1;
        while (Date.now() < deadline && !(total > 0 && total === previous)) {
          previous = total;
          await new Promise((r) => setTimeout(r, 750));
          total = await probeTotal(id);
        }
      }
      attachSession(id, result.sourceName, total, false);
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setLoading(false);
    }
  };

  const openFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Log Files', extensions: ['log', 'txt', 'zip', 'gz', 'lts'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected !== 'string') return;
    await openPath(selected).catch(() => undefined);
  };

  /**
   * Open a markdown/text document in the editor tab. `read_text_file` is the
   * same `Ui`-only command the React editor tab uses; the dialog is the consent
   * step, so no bridge route is involved.
   */
  const openInEditor = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Text Files', extensions: ['md', 'markdown', 'txt', 'yaml', 'yml'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected !== 'string') return;
    try {
      const content = await readTextFile(selected);
      setEditorPath(selected);
      setEditorContent(content);
    } catch (e) {
      setError(String(e));
    }
  };

  // ── Bench driver (?bench=1 only) ─────────────────────────────────────────
  // Mirrors what the UI does, minus the dialog, so scripts/bench.md can open
  // the fixture and start the fake-adb stream over CDP. Not part of the UI.
  if (location.search.includes('bench=1')) {
    const stream = createStreamSession({ cacheManager, registry });
    const benchApp: BenchApp = {
      open: (path) => openPath(path, true),
      startStream: async (deviceId) => {
        await stream.start(deviceId);
        const st = stream.status();
        if (st.phase !== 'streaming') throw new Error(`stream not started: ${JSON.stringify(st)}`);
        attachSession(st.sessionId, st.sourceName, st.totalLines, true);
        return st.sessionId;
      },
      stopStream: () => stream.stop(),
    };
    (window as unknown as { __benchApp?: BenchApp }).__benchApp = benchApp;
    onCleanup(() => { void stream.stop(); });
  }

  const topBar = (
    <>
      <button type="button" class={styles.openButton} onClick={openFile} disabled={loading()}>
        Open file…
      </button>
      <button type="button" class={styles.openButton} onClick={openInEditor}>
        Open in editor…
      </button>
      <Show when={sourceName()}>
        <span class={styles.session}>
          {sourceName()} — {totalLines().toLocaleString()} lines
        </span>
      </Show>
      <Show when={loading()}>
        <span class={styles.session}>Loading…</span>
      </Show>
      <Show when={error()}>
        <span class={styles.error}>{error()}</span>
      </Show>
      <Show when={navTargetText()}>
        <span class={styles.session}>{navTargetText()}</span>
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
      sessionKind={sessionKind()}
      topBar={topBar}
      slots={{
        presence: () => <PresencePanel store={presence} />,
        viewer: () => (
          <Show
            when={dataSource()}
            fallback={<div class={styles.empty}>No log open. Choose a file to begin.</div>}
          >
            {(ds) => (
              <LogViewer
                dataSource={ds()}
                totalLineCount={totalLines()}
                sessionId={sessionId() ?? undefined}
                tailMode={tailMode()}
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
