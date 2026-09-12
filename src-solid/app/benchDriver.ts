/**
 * The `?bench=1` driver.
 *
 * `scripts/bench.md` drives the app over CDP and has no access to the native
 * file dialog or the ADB device picker, so it calls `window.__benchApp`
 * instead. The shape is a contract with that document — `{ open, startStream,
 * stopStream }` — and must not change without updating it.
 *
 * Moved out of `App.tsx` in W0b so the component is composition only. The
 * behaviour is identical: `open` waits for the line index to settle, and
 * `startStream` registers the live session exactly as the UI would.
 */
import { onCleanup } from 'solid-js';
import { createStreamSession } from '../viewer/createStreamSession';
import type { CacheManager, DataSourceRegistry } from '../viewer';
import type { LoadResult } from '@bridge/types';
import type { AppActions } from './actions';
import type { SessionStore } from './sessions';

/** The object published at `window.__benchApp`. Read by `scripts/bench.md`. */
export interface BenchApp {
  open(path: string): Promise<void>;
  startStream(deviceId?: string): Promise<string>;
  stopStream(): Promise<void>;
}

export interface BenchDriverDeps {
  actions: AppActions;
  store: SessionStore;
  cacheManager: CacheManager;
  registry: DataSourceRegistry;
}

/** True when the app was launched with `?bench=1`. */
export function isBenchMode(search: string = location.search): boolean {
  return search.includes('bench=1');
}

/**
 * A live ADB stream has no `LoadResult` — `start_adb_stream` answers with a
 * status, not a load. The session store is keyed on `LoadResult`, so synthesize
 * the one the backend would have produced. Only the fields the store and the
 * shell read are meaningful; the rest carry the "not a file" values.
 */
function streamLoadResult(status: {
  sessionId: string;
  sourceName: string;
  sourceType: string;
  totalLines: number;
}): LoadResult {
  return {
    sessionId: status.sessionId,
    sourceId: status.sessionId,
    sourceName: status.sourceName,
    filePath: null,
    totalLines: status.totalLines,
    fileSize: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: status.sourceType,
    isStreaming: true,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
  };
}

/**
 * Publish `window.__benchApp`. Must be called from a reactive owner — the
 * stream session it builds registers its own `onCleanup`.
 */
export function installBenchApp(deps: BenchDriverDeps): BenchApp {
  const { actions, store, cacheManager, registry } = deps;
  const stream = createStreamSession({ cacheManager, registry });

  const benchApp: BenchApp = {
    open: async (path) => {
      await actions.openPath(path, { waitForIndex: true });
    },
    startStream: async (deviceId) => {
      await stream.start(deviceId);
      const status = stream.status();
      if (status.phase !== 'streaming') {
        throw new Error(`stream not started: ${JSON.stringify(status)}`);
      }
      store.add(streamLoadResult(status));
      store.setFocused(status.sessionId);
      return status.sessionId;
    },
    stopStream: () => stream.stop(),
  };

  (window as unknown as { __benchApp?: BenchApp }).__benchApp = benchApp;
  onCleanup(() => {
    void stream.stop();
    delete (window as unknown as { __benchApp?: BenchApp }).__benchApp;
  });

  return benchApp;
}
