/**
 * In-app updates: the face `settings/updateStore.ts` drives.
 *
 * Check, download, verify and install all run in Rust (`commands/app_update.rs`),
 * not through the updater plugin's JS API — the app has to run its own exit
 * cleanup (killing the MCP sidecar whose exe the installer overwrites) before
 * the installer takes over, and only the Rust side can put itself in front of
 * that exit. The frontend's whole role is "is there one?" and "install it";
 * this module exists so the store has one injectable surface (`AppUpdateApi`)
 * and so the plugin never becomes a direct import anywhere in the UI.
 *
 * Trust model: the backend fetches `latest.json` from the endpoint in
 * `tauri.conf.json` (`plugins.updater.endpoints`) and refuses any bundle whose
 * minisign signature does not verify against the public key compiled into the
 * binary (`plugins.updater.pubkey`). Nothing here can weaken that.
 *
 * Named `appUpdate*` throughout so it never reads as the processor-marketplace
 * "updates available" flow (`events.ts`'s `onUpdatesAvailable`).
 */

import { getVersion } from '@tauri-apps/api/app';
import { checkAppUpdate, installAppUpdate as installAppUpdateCommand } from './commands';
import type { AppUpdateInfo, AppUpdateProgress } from './types';

export type { AppUpdateInfo, AppUpdateProgress };

/** The functions a consumer injects in tests — `updateStore.ts` takes a `Partial` of this. */
export interface AppUpdateApi {
  checkForAppUpdate(): Promise<AppUpdateInfo | null>;
  installAppUpdate(onProgress: (p: AppUpdateProgress) => void): Promise<void>;
  appVersion(): Promise<string>;
}

/**
 * Ask the endpoint whether a newer version exists. Resolves `null` when the
 * running version is current. Rejects when the endpoint is unreachable, the
 * manifest is malformed, or the config's public key is invalid — the caller
 * decides whether that is worth showing (a manual check) or not (the silent
 * launch check). The found update is held backend-side for `installAppUpdate`.
 */
export function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  return checkAppUpdate();
}

/**
 * Download, verify and install the update the last check found, then hand
 * off to the new build. On success this process exits (Windows: the installer
 * relaunches it; macOS/Linux: the backend relaunches after its cleanup), so the
 * promise only ever settles on failure. A signature mismatch rejects before
 * anything is written; the backend keeps the update on hand so a second call
 * is a retry after a transient network failure.
 */
export function installAppUpdate(onProgress: (p: AppUpdateProgress) => void): Promise<void> {
  return installAppUpdateCommand(onProgress);
}

/** The running app's version, as `tauri.conf.json` declares it. */
export function appVersion(): Promise<string> {
  return getVersion();
}
