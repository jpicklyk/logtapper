/**
 * `updater.ts` against mocked plugin packages: the `Update` handle lifecycle
 * (kept between check and install, closed on re-check, cleared on install),
 * cumulative progress mapping, and the relaunch after a successful install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';

const check = vi.fn<() => Promise<FakeUpdate | null>>();
const relaunch = vi.fn(() => Promise.resolve());
const getVersion = vi.fn(() => Promise.resolve('0.12.0'));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => getVersion() }));

/** The slice of the plugin's `Update` class the wrapper touches. */
class FakeUpdate {
  closed = false;
  installed = false;
  /** Events replayed to the wrapper's `onEvent` during `downloadAndInstall`. */
  events: DownloadEvent[] = [];
  failInstall: unknown = null;
  constructor(
    public version = '0.13.0',
    public currentVersion = '0.12.0',
    public body: string | undefined = 'notes',
    public date: string | undefined = '2026-09-21T00:00:00Z',
  ) {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async downloadAndInstall(onEvent?: (e: DownloadEvent) => void): Promise<void> {
    for (const e of this.events) onEvent?.(e);
    if (this.failInstall !== null) throw this.failInstall;
    this.installed = true;
  }
}

// The module keeps the pending handle in module state; re-import per test so
// one test's handle never leaks into the next.
type Updater = typeof import('./updater');
let updater: Updater;
beforeEach(async () => {
  vi.resetModules();
  updater = await import('./updater');
});
afterEach(() => {
  check.mockReset();
  relaunch.mockClear();
  getVersion.mockClear();
});

describe('checkForAppUpdate', () => {
  it('resolves null when the running version is current', async () => {
    check.mockResolvedValue(null);
    await expect(updater.checkForAppUpdate()).resolves.toBeNull();
  });

  it('maps the plugin handle to plain info', async () => {
    check.mockResolvedValue(new FakeUpdate());
    await expect(updater.checkForAppUpdate()).resolves.toEqual({
      version: '0.13.0',
      currentVersion: '0.12.0',
      notes: 'notes',
      date: '2026-09-21T00:00:00Z',
    });
  });

  it('normalises absent or blank notes and date to null', async () => {
    const update = new FakeUpdate('0.13.0', '0.12.0', '   ');
    update.date = undefined; // a default parameter would fill it back in
    check.mockResolvedValue(update);
    await expect(updater.checkForAppUpdate()).resolves.toEqual({
      version: '0.13.0',
      currentVersion: '0.12.0',
      notes: null,
      date: null,
    });
  });

  it('closes the previous handle when checked again', async () => {
    const first = new FakeUpdate();
    check.mockResolvedValueOnce(first).mockResolvedValueOnce(null);
    await updater.checkForAppUpdate();
    await updater.checkForAppUpdate();
    expect(first.closed).toBe(true);
  });

  it('propagates an endpoint failure to the caller', async () => {
    check.mockRejectedValue(new Error('offline'));
    await expect(updater.checkForAppUpdate()).rejects.toThrow('offline');
  });
});

describe('installAppUpdate', () => {
  it('rejects when nothing was found first', async () => {
    await expect(updater.installAppUpdate(() => undefined)).rejects.toThrow(/check for updates first/);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('forwards cumulative progress, installs, then relaunches', async () => {
    const update = new FakeUpdate();
    update.events = [
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ];
    check.mockResolvedValue(update);
    await updater.checkForAppUpdate();
    const seen: unknown[] = [];
    await updater.installAppUpdate((p) => seen.push(p));
    expect(seen).toEqual([
      { phase: 'started', total: 100 },
      { phase: 'progress', received: 40, total: 100 },
      { phase: 'progress', received: 100, total: 100 },
      { phase: 'finished' },
    ]);
    expect(update.installed).toBe(true);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown total when the server sends no Content-Length', async () => {
    const update = new FakeUpdate();
    update.events = [{ event: 'Started', data: {} }, { event: 'Progress', data: { chunkLength: 5 } }];
    check.mockResolvedValue(update);
    await updater.checkForAppUpdate();
    const seen: unknown[] = [];
    await updater.installAppUpdate((p) => seen.push(p));
    expect(seen).toEqual([
      { phase: 'started', total: null },
      { phase: 'progress', received: 5, total: null },
    ]);
  });

  it('keeps the handle for a retry when the install fails, and does not relaunch', async () => {
    const update = new FakeUpdate();
    update.failInstall = new Error('signature mismatch');
    check.mockResolvedValue(update);
    await updater.checkForAppUpdate();
    await expect(updater.installAppUpdate(() => undefined)).rejects.toThrow('signature mismatch');
    expect(relaunch).not.toHaveBeenCalled();
    update.failInstall = null;
    await expect(updater.installAppUpdate(() => undefined)).resolves.toBeUndefined();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('drops the handle after a successful install', async () => {
    check.mockResolvedValue(new FakeUpdate());
    await updater.checkForAppUpdate();
    await updater.installAppUpdate(() => undefined);
    await expect(updater.installAppUpdate(() => undefined)).rejects.toThrow(/check for updates first/);
  });
});

describe('appVersion', () => {
  it('reads the running version from the Tauri app API', async () => {
    await expect(updater.appVersion()).resolves.toBe('0.12.0');
    expect(getVersion).toHaveBeenCalledTimes(1);
  });
});
