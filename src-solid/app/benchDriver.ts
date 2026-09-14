/**
 * The `?bench=1` driver.
 *
 * `scripts/bench.md` drives the app over CDP and has no access to the native
 * file dialog or the ADB device picker, so it calls `window.__benchApp`
 * instead. The shape is a contract with that document — `{ open, startStream,
 * stopStream }` — and must not change without updating it.
 *
 * Moved out of `App.tsx` in W0b so the component is composition only. As of
 * L1, `startStream`/`stopStream` delegate to the app's one `LiveStreamStore`
 * (`stream/streamStore.ts`) instead of building a second, bench-only
 * `createStreamSession` — `App.tsx` constructs a single instance and hands it
 * to both this driver and `stream/StreamControlsPanel.tsx`, so a bench-started
 * stream registers as a real session (tab, focus) exactly like one started
 * from the UI. The behaviour this file promises is unchanged: `open` waits
 * for the line index to settle, and `startStream` registers the live session
 * exactly as the UI would — that sentence used to be aspirational here and is
 * now literally true.
 */
import { onCleanup } from 'solid-js';
import type { LiveStreamStore } from '../stream';
import type { AppActions } from './actions';

/** The object published at `window.__benchApp`. Read by `scripts/bench.md`. */
export interface BenchApp {
  open(path: string): Promise<void>;
  startStream(deviceId?: string): Promise<string>;
  stopStream(): Promise<void>;
}

export interface BenchDriverDeps {
  actions: AppActions;
  stream: LiveStreamStore;
}

/** True when the app was launched with `?bench=1`. */
export function isBenchMode(search: string = location.search): boolean {
  return search.includes('bench=1');
}

/**
 * Publish `window.__benchApp`. Must be called from a reactive owner — the
 * `onCleanup` below runs when that owner tears down.
 */
export function installBenchApp(deps: BenchDriverDeps): BenchApp {
  const { actions, stream } = deps;

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
      return status.sessionId;
    },
    stopStream: () => stream.stop(),
  };

  (window as unknown as { __benchApp?: BenchApp }).__benchApp = benchApp;
  onCleanup(() => {
    delete (window as unknown as { __benchApp?: BenchApp }).__benchApp;
  });

  return benchApp;
}
