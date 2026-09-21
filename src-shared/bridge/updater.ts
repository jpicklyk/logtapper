/**
 * In-app updates.
 *
 * The thin, framework-free face of `@tauri-apps/plugin-updater` +
 * `@tauri-apps/plugin-process` that the Settings surface drives. It exists for
 * the same reason `externalLinks.ts` wraps the opener: the plugin's own types
 * (`Update` is a backend `Resource` with an `rid`) should not leak into a
 * store, and tests want one module to mock rather than three packages.
 *
 * Trust model: the backend fetches `latest.json` from the endpoint in
 * `tauri.conf.json` (`plugins.updater.endpoints`) and refuses any bundle whose
 * minisign signature does not verify against the public key compiled into the
 * binary (`plugins.updater.pubkey`). Nothing here can weaken that — the
 * frontend only asks "is there one?" and "install it".
 *
 * Named `appUpdate*` throughout so it never reads as the processor-marketplace
 * "updates available" flow (`events.ts`'s `onUpdatesAvailable`).
 */

import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';

/** What the release manifest says about a newer version than the running one. */
export interface AppUpdateInfo {
  /** The version on offer, e.g. `0.13.0`. */
  readonly version: string;
  /** The version this process is running. */
  readonly currentVersion: string;
  /** Release notes from the manifest, or `null` when it carries none. */
  readonly notes: string | null;
  /** ISO publication date from the manifest, or `null`. */
  readonly date: string | null;
}

/**
 * Download progress, already cumulative: `received` is the total bytes so far,
 * not the plugin's per-chunk delta. `total` is `null` when the server sent no
 * `Content-Length`.
 */
export type AppUpdateProgress =
  | { readonly phase: 'started'; readonly total: number | null }
  | { readonly phase: 'progress'; readonly received: number; readonly total: number | null }
  | { readonly phase: 'finished' };

/** The functions a consumer injects in tests — `updateStore.ts` takes a `Partial` of this. */
export interface AppUpdateApi {
  checkForAppUpdate(): Promise<AppUpdateInfo | null>;
  installAppUpdate(onProgress: (p: AppUpdateProgress) => void): Promise<void>;
  appVersion(): Promise<string>;
}

/**
 * The plugin's handle for the update `checkForAppUpdate` last found. It owns
 * the download, so it has to survive between the check and the install; it is
 * kept here rather than in the store so the store sees only `AppUpdateInfo`.
 */
let pending: Update | null = null;

/** Release the previous handle (a backend resource) before replacing it. */
async function dropPending(): Promise<void> {
  const previous = pending;
  pending = null;
  if (previous !== null) await previous.close().catch(() => undefined);
}

/**
 * Ask the endpoint whether a newer version exists. Resolves `null` when the
 * running version is current. Rejects when the endpoint is unreachable, the
 * manifest is malformed, or the config's public key is invalid — the caller
 * decides whether that is worth showing (a manual check) or not (the silent
 * launch check).
 */
export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  await dropPending();
  const update = await check();
  if (update === null) return null;
  pending = update;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body?.trim() ? update.body : null,
    date: update.date ?? null,
  };
}

/**
 * Download, verify and install the update `checkForAppUpdate` found, then
 * relaunch. On Windows the installer exits this process itself, so the
 * relaunch never runs; on macOS/Linux it is what brings the new build up. A
 * signature mismatch rejects here, before anything is written — the handle is
 * kept so the user can retry after a transient network failure.
 */
export async function installAppUpdate(onProgress: (p: AppUpdateProgress) => void): Promise<void> {
  const update = pending;
  if (update === null) throw new Error('No update has been found to install; check for updates first.');
  let received = 0;
  let total: number | null = null;
  const forward = (event: DownloadEvent): void => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null;
        onProgress({ phase: 'started', total });
        break;
      case 'Progress':
        received += event.data.chunkLength;
        onProgress({ phase: 'progress', received, total });
        break;
      case 'Finished':
        onProgress({ phase: 'finished' });
        break;
    }
  };
  await update.downloadAndInstall(forward);
  pending = null;
  await relaunch();
}

/** The running app's version, as `tauri.conf.json` declares it. */
export function appVersion(): Promise<string> {
  return getVersion();
}
