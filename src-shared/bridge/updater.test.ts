/**
 * `updater.ts` against a mocked command boundary. The module is deliberately
 * thin — check and install are Rust commands now (see the module header for
 * why) — so what this pins is the contract the store relies on: the progress
 * callback is forwarded unchanged, a failed install rejects with the backend's
 * message and does not resolve, and nothing here imports the updater plugin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateInfo, AppUpdatePolicy, AppUpdateProgress } from './types';

const checkAppUpdate = vi.fn<() => Promise<AppUpdateInfo | null>>();
const installAppUpdate = vi.fn<(cb: (p: AppUpdateProgress) => void) => Promise<void>>();
const getAppUpdatePolicy = vi.fn<() => Promise<AppUpdatePolicy>>(() => Promise.resolve({ managedBy: null }));
const getVersion = vi.fn(() => Promise.resolve('0.13.1'));
vi.mock('./commands', () => ({
  checkAppUpdate: () => checkAppUpdate(),
  installAppUpdate: (cb: (p: AppUpdateProgress) => void) => installAppUpdate(cb),
  getAppUpdatePolicy: () => getAppUpdatePolicy(),
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => getVersion() }));

import { appUpdatePolicy, appVersion, checkForAppUpdate, installAppUpdate as install } from './updater';

afterEach(() => {
  checkAppUpdate.mockReset();
  installAppUpdate.mockReset();
  getAppUpdatePolicy.mockReset();
  getAppUpdatePolicy.mockImplementation(() => Promise.resolve({ managedBy: null }));
  getVersion.mockClear();
});

describe('checkForAppUpdate', () => {
  it('passes the backend answer through: null when current, the info otherwise', async () => {
    checkAppUpdate.mockResolvedValueOnce(null);
    await expect(checkForAppUpdate()).resolves.toBeNull();
    const info: AppUpdateInfo = { version: '0.13.2', currentVersion: '0.13.1', notes: null, date: null };
    checkAppUpdate.mockResolvedValueOnce(info);
    await expect(checkForAppUpdate()).resolves.toEqual(info);
  });

  it('propagates an endpoint failure to the caller', async () => {
    checkAppUpdate.mockRejectedValueOnce('endpoint unreachable');
    await expect(checkForAppUpdate()).rejects.toBe('endpoint unreachable');
  });
});

describe('installAppUpdate', () => {
  it('forwards every progress event unchanged, in order', async () => {
    const events: AppUpdateProgress[] = [
      { phase: 'started', total: 100 },
      { phase: 'progress', received: 40, total: 100 },
      { phase: 'progress', received: 100, total: 100 },
      { phase: 'finished' },
    ];
    installAppUpdate.mockImplementationOnce(async (cb) => { for (const e of events) cb(e); });
    const seen: AppUpdateProgress[] = [];
    await install((p) => seen.push(p));
    expect(seen).toEqual(events);
  });

  it('rejects with the backend message on a failed install (the retry is the backend\'s job)', async () => {
    installAppUpdate.mockRejectedValueOnce('The signature verification failed');
    await expect(install(() => undefined)).rejects.toBe('The signature verification failed');
  });
});

describe('appVersion', () => {
  it('reads the running version from the Tauri app API', async () => {
    await expect(appVersion()).resolves.toBe('0.13.1');
    expect(getVersion).toHaveBeenCalledTimes(1);
  });
});

describe('appUpdatePolicy', () => {
  it('passes the backend answer through: null for a normal install, the manager name otherwise', async () => {
    getAppUpdatePolicy.mockResolvedValueOnce({ managedBy: null });
    await expect(appUpdatePolicy()).resolves.toEqual({ managedBy: null });
    getAppUpdatePolicy.mockResolvedValueOnce({ managedBy: 'scoop' });
    await expect(appUpdatePolicy()).resolves.toEqual({ managedBy: 'scoop' });
  });
});

describe('module boundary', () => {
  it('does not import the updater or process plugins anywhere in the frontend', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'generated') walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/@tauri-apps\/plugin-(updater|process)/.test(src)) offenders.push(path.relative(root, p));
      }
    };
    walk(path.join(root, 'src-shared'));
    walk(path.join(root, 'src-solid'));
    // The whole point of driving the update from Rust is that the app's exit
    // cleanup runs before the installer; a direct plugin call would bypass it.
    expect(offenders).toEqual([]);
  });
});
