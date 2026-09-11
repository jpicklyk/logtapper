/** @jsxImportSource solid-js */
import { Show, createSignal, onCleanup } from 'solid-js';
import { open } from '@tauri-apps/plugin-dialog';
import { getLines, loadLogFile } from '@bridge/commands';
import {
  CacheManager,
  DataSourceRegistry,
  LogViewer,
  createCacheDataSource,
} from './viewer';
import type { CacheDataSource } from './viewer';
import { createStreamSession } from './viewer/createStreamSession';
import styles from './App.module.css';

/**
 * Solid spike shell: open a file, then show it in the virtualized viewer.
 *
 * The cache manager and data-source registry are app-wide singletons — one each,
 * created once here. React builds them in `CacheProvider`; Solid has no provider
 * in the spike, so they are constructed directly (the barrel re-exports the
 * classes for exactly this reason).
 */

const CACHE_BUDGET = 100_000;
const VIEW_ID = 'solid-main';

/** Bench-only driver (`?bench=1`), so the gate can run without the native dialog. */
interface BenchApp {
  open(path: string): Promise<void>;
  startStream(deviceId?: string): Promise<string>;
  stopStream(): Promise<void>;
}

export function App() {
  const cacheManager = new CacheManager(CACHE_BUDGET);
  const registry = new DataSourceRegistry();

  const [dataSource, setDataSource] = createSignal<CacheDataSource | null>(null);
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [sourceName, setSourceName] = createSignal('');
  const [totalLines, setTotalLines] = createSignal(0);
  const [tailMode, setTailMode] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const disposeSource = () => {
    dataSource()?.dispose?.();
    setDataSource(null);
  };
  onCleanup(disposeSource);

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

  return (
    <main class={styles.page}>
      <header class={styles.bar}>
        <button type="button" class={styles.openButton} onClick={openFile} disabled={loading()}>
          Open file…
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
      </header>

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
    </main>
  );
}
