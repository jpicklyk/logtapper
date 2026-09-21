/**
 * `updateStore` against an injected fake `AppUpdateApi`: the status machine,
 * the silent-vs-surfaced failure split between the launch check and a manual
 * one, progress accumulation, and the retry path after a failed install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateApi, AppUpdateInfo, AppUpdatePolicy, AppUpdateProgress } from '@bridge/updater';
import { createUpdateStore } from './updateStore';
import type { UpdateStore } from './updateStore';

const INFO: AppUpdateInfo = { version: '0.13.0', currentVersion: '0.12.0', notes: 'fixes', date: null };
const UNMANAGED: AppUpdatePolicy = { managedBy: null };

/** A deferred so a test can hold a check open and resolve it when it chooses. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeApi(over: Partial<AppUpdateApi> = {}): AppUpdateApi & { check: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> } {
  const check = vi.fn(() => Promise.resolve<AppUpdateInfo | null>(null));
  const install = vi.fn((_: (p: AppUpdateProgress) => void) => Promise.resolve());
  return {
    check, install,
    checkForAppUpdate: () => check(),
    installAppUpdate: (cb) => install(cb),
    appVersion: () => Promise.resolve('0.12.0'),
    appUpdatePolicy: () => Promise.resolve(UNMANAGED),
    ...over,
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let stores: UpdateStore[] = [];
const make = (deps: Parameters<typeof createUpdateStore>[0]): UpdateStore => {
  const s = createUpdateStore(deps);
  stores.push(s);
  return s;
};
beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  for (const s of stores) s.dispose();
  stores = [];
  vi.useRealTimers();
});

describe('createUpdateStore', () => {
  it('starts idle, reads the running version, and never checks by default in tests', async () => {
    const api = fakeApi();
    const store = make({ api, startupCheck: false });
    expect(store.status()).toBe('idle');
    await flush();
    expect(store.currentVersion()).toBe('0.12.0');
    expect(api.check).not.toHaveBeenCalled();
  });

  it('a manual check that finds nothing lands on up-to-date', async () => {
    const api = fakeApi();
    const store = make({ api, startupCheck: false });
    await store.check();
    expect(store.status()).toBe('up-to-date');
    expect(store.available()).toBeNull();
    expect(store.error()).toBeNull();
  });

  it('a manual check that finds a version lands on available with the info', async () => {
    const api = fakeApi();
    api.check.mockResolvedValue(INFO);
    const store = make({ api, startupCheck: false });
    await store.check();
    expect(store.status()).toBe('available');
    expect(store.available()).toEqual(INFO);
  });

  it('a manual check failure is surfaced', async () => {
    const api = fakeApi();
    api.check.mockRejectedValue(new Error('endpoint unreachable'));
    const store = make({ api, startupCheck: false });
    await store.check();
    expect(store.status()).toBe('error');
    expect(store.error()).toBe('endpoint unreachable');
  });

  it('shows checking while the check is in flight and ignores a second press', async () => {
    const api = fakeApi();
    const d = deferred<AppUpdateInfo | null>();
    api.check.mockReturnValue(d.promise);
    const store = make({ api, startupCheck: false });
    const first = store.check();
    expect(store.status()).toBe('checking');
    void store.check();
    expect(api.check).toHaveBeenCalledTimes(1);
    d.resolve(INFO);
    await first;
    expect(store.status()).toBe('available');
  });

  it('the launch check runs after the delay and fails silently', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = fakeApi();
    api.check.mockRejectedValue(new Error('offline'));
    const store = make({ api, startupCheck: true, startupDelayMs: 500 });
    expect(api.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(api.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status()).toBe('idle');
    expect(store.error()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the launch check that finds a version lands on available', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    api.check.mockResolvedValue(INFO);
    const store = make({ api, startupCheck: true, startupDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.status()).toBe('available');
  });

  it('dispose cancels a pending launch check', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const store = make({ api, startupCheck: true, startupDelayMs: 10 });
    store.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(api.check).not.toHaveBeenCalled();
  });

  it('a check resolving after dispose writes nothing back', async () => {
    const api = fakeApi();
    const d = deferred<AppUpdateInfo | null>();
    api.check.mockReturnValue(d.promise);
    const store = make({ api, startupCheck: false });
    const p = store.check();
    store.dispose();
    d.resolve(INFO);
    await p;
    expect(store.status()).toBe('checking');
    expect(store.available()).toBeNull();
  });

  it('install is a no-op until something is available', async () => {
    const api = fakeApi();
    const store = make({ api, startupCheck: false });
    await store.install();
    expect(api.install).not.toHaveBeenCalled();
    expect(store.status()).toBe('idle');
  });

  it('install tracks cumulative progress then lands on restarting', async () => {
    const api = fakeApi();
    api.check.mockResolvedValue(INFO);
    const seen: Array<{ received: number; total: number | null } | null> = [];
    api.install.mockImplementation(async (cb: (p: AppUpdateProgress) => void) => {
      cb({ phase: 'started', total: 200 });
      seen.push(store.progress());
      cb({ phase: 'progress', received: 150, total: 200 });
      seen.push(store.progress());
      cb({ phase: 'finished' });
    });
    const store = make({ api, startupCheck: false });
    await store.check();
    const p = store.install();
    expect(store.status()).toBe('downloading');
    await p;
    expect(seen).toEqual([{ received: 0, total: 200 }, { received: 150, total: 200 }]);
    expect(store.status()).toBe('restarting');
    expect(store.error()).toBeNull();
  });

  it('a failed install keeps the update on offer so the button is a retry', async () => {
    const api = fakeApi();
    api.check.mockResolvedValue(INFO);
    api.install.mockRejectedValueOnce(new Error('signature mismatch'));
    const store = make({ api, startupCheck: false });
    await store.check();
    await store.install();
    expect(store.status()).toBe('error');
    expect(store.error()).toBe('signature mismatch');
    expect(store.progress()).toBeNull();
    expect(store.available()).toEqual(INFO);
    await store.install();
    expect(api.install).toHaveBeenCalledTimes(2);
    expect(store.status()).toBe('restarting');
  });

  it('a check is refused while downloading', async () => {
    const api = fakeApi();
    api.check.mockResolvedValue(INFO);
    const d = deferred<void>();
    api.install.mockReturnValue(d.promise);
    const store = make({ api, startupCheck: false });
    await store.check();
    const p = store.install();
    await store.check();
    expect(api.check).toHaveBeenCalledTimes(1);
    d.resolve();
    await p;
  });
});

describe('createUpdateStore — Scoop-managed installs', () => {
  it('reflects the backend policy in managedBy()', async () => {
    const api = fakeApi({ appUpdatePolicy: () => Promise.resolve({ managedBy: 'scoop' }) });
    const store = make({ api, startupCheck: false });
    expect(store.managedBy()).toBeNull();
    await flush();
    expect(store.managedBy()).toBe('scoop');
  });

  it('stays null when the policy fetch fails (no Tauri host, e.g. tests/browser preview)', async () => {
    const api = fakeApi({ appUpdatePolicy: () => Promise.reject(new Error('no host')) });
    const store = make({ api, startupCheck: false });
    await flush();
    expect(store.managedBy()).toBeNull();
  });

  it('never runs the silent launch check for a managed install', async () => {
    vi.useFakeTimers();
    const api = fakeApi({ appUpdatePolicy: () => Promise.resolve({ managedBy: 'scoop' }) });
    const store = make({ api, startupCheck: true, startupDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(api.check).not.toHaveBeenCalled();
    expect(store.status()).toBe('idle');
    expect(store.managedBy()).toBe('scoop');
  });

  it('still runs the silent launch check once the policy says unmanaged', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    make({ api, startupCheck: true, startupDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(api.check).toHaveBeenCalledTimes(1);
  });

  it('refuses a manual check once managed, without touching the bridge', async () => {
    const api = fakeApi({ appUpdatePolicy: () => Promise.resolve({ managedBy: 'scoop' }) });
    const store = make({ api });
    await flush();
    expect(store.managedBy()).toBe('scoop');
    await store.check();
    expect(api.check).not.toHaveBeenCalled();
    expect(store.status()).toBe('idle');
    expect(store.error()).toBeNull();
  });

  it('refuses an install once managed even with an update already on offer', async () => {
    // The policy answer is held back so a check can land `available` first;
    // otherwise install() would bail on the empty offer and prove nothing.
    const policy = deferred<AppUpdatePolicy>();
    const api = fakeApi({ appUpdatePolicy: () => policy.promise });
    api.check.mockResolvedValue(INFO);
    const store = make({ api, startupCheck: false });
    await store.check();
    expect(store.status()).toBe('available');
    policy.resolve({ managedBy: 'scoop' });
    await flush();
    expect(store.managedBy()).toBe('scoop');
    await store.install();
    expect(api.install).not.toHaveBeenCalled();
    expect(store.status()).toBe('available');
    expect(store.error()).toBeNull();
  });
});
