/**
 * App-update store: the state behind the Updates section of Settings > General.
 *
 * One silent check shortly after launch (production builds only — a dev server
 * must never hit GitHub), a manual "Check for updates", and "Install and
 * restart". The bridge (`@bridge/updater`) owns the plugin handle; this store
 * owns only what the section renders. Not a shell surface and not an event
 * source: v1 is Settings-only by decision, so nothing outside the panel reads
 * it.
 *
 * Named `appUpdate*` so it never reads as the processor-marketplace "updates
 * available" flow in `packs/`.
 */
import { createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import * as bridge from '@bridge/updater';
import type { AppUpdateApi, AppUpdateInfo, AppUpdateProgress } from '@bridge/updater';
import { createGenerationGuard } from '../reactive/index';

/**
 * - `idle` — nothing asked yet (or the silent launch check failed quietly).
 * - `checking` — a check is in flight.
 * - `up-to-date` / `available` — the last check's answer.
 * - `downloading` — install in progress; `progress()` is live.
 * - `restarting` — download and install done, relaunch requested. On Windows
 *   the process is already exiting by the time this is set.
 * - `error` — a *manual* check or an install failed; `error()` says why.
 */
export type AppUpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'restarting' | 'error';

export interface AppUpdateProgressState {
  readonly received: number;
  readonly total: number | null;
}

export interface UpdateStoreDeps {
  /** Injected for tests; defaults to the real bridge wrapper. */
  api?: Partial<AppUpdateApi>;
  /**
   * Whether to run the silent check after launch. Defaults to
   * `import.meta.env.PROD` so `npx tauri dev` and tests never reach the
   * endpoint; tests that exercise the launch check pass `true` explicitly.
   */
  startupCheck?: boolean;
  /** Delay before the launch check, so it never competes with session restore. */
  startupDelayMs?: number;
}

export interface UpdateStore {
  status: Accessor<AppUpdateStatus>;
  /** The running version; `null` until the app API answers. */
  currentVersion: Accessor<string | null>;
  /**
   * The package manager that owns this install (currently only `"scoop"`),
   * or `null` for a normal install / before the backend has answered. When
   * set, the launch check never runs and the panel shows a managed-by
   * message instead of check/install controls.
   */
  managedBy: Accessor<string | null>;
  /** The update on offer while `status()` is `available`, `downloading`, `restarting` or a failed install. */
  available: Accessor<AppUpdateInfo | null>;
  progress: Accessor<AppUpdateProgressState | null>;
  /** Why the last manual check or install failed; cleared by the next attempt. */
  error: Accessor<string | null>;
  /** Manual check: failures are surfaced through `error()`. No-op while one is in flight. */
  check(): Promise<void>;
  /** Download, verify, install and relaunch the update in `available()`. */
  install(): Promise<void>;
  dispose(): void;
}

const DEFAULT_STARTUP_DELAY_MS = 10_000;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createUpdateStore(deps: UpdateStoreDeps = {}): UpdateStore {
  const api: AppUpdateApi = { ...bridge, ...deps.api };
  const startupCheck = deps.startupCheck ?? import.meta.env.PROD;
  const startupDelayMs = deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  return createRoot((disposeRoot) => {
    const [status, setStatus] = createSignal<AppUpdateStatus>('idle');
    const [currentVersion, setCurrentVersion] = createSignal<string | null>(null);
    const [managedBy, setManagedBy] = createSignal<string | null>(null);
    const [available, setAvailable] = createSignal<AppUpdateInfo | null>(null);
    const [progress, setProgress] = createSignal<AppUpdateProgressState | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    let disposed = false;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;
    // A check superseded by a later one (or by dispose) must not write back.
    const checks = createGenerationGuard();

    void api.appVersion().then(
      (v) => { if (!disposed) setCurrentVersion(v); },
      () => { /* no Tauri host (tests, browser preview): the version row stays blank */ },
    );

    /**
     * Shared by the launch check and the manual one; only the manual one
     * reports failure. An offline laptop must not see an error on launch, but
     * a person who pressed the button deserves to know why nothing happened.
     */
    const runCheck = async (surfaceErrors: boolean): Promise<void> => {
      // A managed install has no in-app path at all: the view hides the
      // controls and the backend refuses, but the store must not depend on
      // either to hold the rule.
      if (disposed || managedBy() !== null) return;
      if (status() === 'checking' || status() === 'downloading' || status() === 'restarting') return;
      const token = checks.bump();
      setError(null);
      setStatus('checking');
      try {
        const info = await api.checkForAppUpdate();
        if (disposed || !checks.isCurrent(token)) return;
        setAvailable(info);
        setStatus(info === null ? 'up-to-date' : 'available');
      } catch (e) {
        if (disposed || !checks.isCurrent(token)) return;
        if (surfaceErrors) {
          setError(messageOf(e));
          setStatus('error');
        } else {
          console.warn('[appUpdate] launch check failed', e);
          setStatus('idle');
        }
      }
    };

    const install = async (): Promise<void> => {
      if (disposed || managedBy() !== null || available() === null) return;
      if (status() === 'downloading' || status() === 'restarting') return;
      setError(null);
      setProgress({ received: 0, total: null });
      setStatus('downloading');
      const onProgress = (p: AppUpdateProgress): void => {
        if (disposed) return;
        if (p.phase === 'started') setProgress({ received: 0, total: p.total });
        else if (p.phase === 'progress') setProgress({ received: p.received, total: p.total });
      };
      try {
        await api.installAppUpdate(onProgress);
        if (!disposed) setStatus('restarting');
      } catch (e) {
        if (disposed) return;
        // `available()` is kept: the bridge keeps its handle too, so the
        // button is a retry rather than a dead end after a network blip.
        setProgress(null);
        setError(messageOf(e));
        setStatus('error');
      }
    };

    /**
     * Read once at construction: a managed install never becomes unmanaged
     * (or vice versa) while the app is running, so there is nothing to
     * re-poll. The launch check is scheduled only after this resolves and
     * says the install is unmanaged — a package-manager install must never
     * hit the update endpoint on its own, even before the frontend gets a
     * chance to hide the controls.
     */
    void api.appUpdatePolicy().then(
      (p) => {
        if (disposed) return;
        setManagedBy(p.managedBy);
        if (startupCheck && p.managedBy === null) {
          startupTimer = setTimeout(() => { void runCheck(false); }, startupDelayMs);
        }
      },
      () => {
        // No Tauri host (tests, browser preview): treat as unmanaged so
        // existing behavior (and existing tests) is unaffected.
        if (disposed) return;
        if (startupCheck) startupTimer = setTimeout(() => { void runCheck(false); }, startupDelayMs);
      },
    );

    return {
      status, currentVersion, managedBy, available, progress, error,
      check: () => runCheck(true),
      install,
      dispose: () => {
        disposed = true;
        checks.bump();
        if (startupTimer !== null) clearTimeout(startupTimer);
        disposeRoot();
      },
    };
  });
}
