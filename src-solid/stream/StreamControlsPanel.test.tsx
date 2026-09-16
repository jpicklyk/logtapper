/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { AdbDevice } from '@bridge/types';
import { StreamControlsPanel } from './StreamControlsPanel';
import type { LiveStreamStore } from './streamStore';
import type { StreamSessionStatus, StreamStartOptions } from '../viewer';

const save = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => save(...args) }));

afterEach(cleanup);
beforeEach(() => save.mockReset());

/** A hand-built `LiveStreamStore` double — this panel is tested as a renderer
 *  over the store's public surface, not against the real store (that is
 *  `streamStore.test.ts`'s job). Mirrors `BookmarksPanel.test.tsx`'s pattern. */
function fakeStore(overrides: { devices?: AdbDevice[]; status?: StreamSessionStatus } = {}) {
  const [status, setStatus] = createSignal<StreamSessionStatus>(overrides.status ?? { phase: 'idle' });
  const [devices] = createSignal<AdbDevice[]>(overrides.devices ?? []);
  const store: LiveStreamStore & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    setAnonymize: ReturnType<typeof vi.fn>;
    saveCapture: ReturnType<typeof vi.fn>;
    refreshDevices: ReturnType<typeof vi.fn>;
  } = {
    status,
    active: () => status().phase === 'streaming',
    devices,
    devicesLoading: () => false,
    devicesError: () => null,
    refreshDevices: vi.fn(() => Promise.resolve()),
    start: vi.fn((_deviceId?: string, _opts?: StreamStartOptions) => {
      setStatus({
        phase: 'streaming',
        sessionId: 's1',
        sourceName: 'emulator-5554',
        sourceType: 'Logcat',
        totalLines: 0,
      });
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      setStatus({ phase: 'stopped', sessionId: 's1', reason: 'stopped' });
      return Promise.resolve();
    }),
    stopIfCurrent: vi.fn(() => Promise.resolve()),
    setAnonymize: vi.fn(() => Promise.resolve()),
    updateProcessors: vi.fn(() => Promise.resolve()),
    updateTrackers: vi.fn(() => Promise.resolve()),
    updateTransformers: vi.fn(() => Promise.resolve()),
    resolvePackagePids: vi.fn(() => Promise.resolve([])),
    saveCapture: vi.fn(() => Promise.resolve(10)),
    dispose: vi.fn(),
  };
  return store;
}

const DEVICE: AdbDevice = { serial: 'emulator-5554', model: 'sdk_gphone64_x86_64', state: 'device' };

describe('StreamControlsPanel', () => {
  it('refreshes devices on mount', () => {
    const store = fakeStore();
    render(() => <StreamControlsPanel store={store} />);
    expect(store.refreshDevices).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-state hint when no devices are found', () => {
    const store = fakeStore({ devices: [] });
    render(() => <StreamControlsPanel store={store} />);
    expect(screen.getByText(/no devices found/i)).toBeTruthy();
  });

  it('lists devices and defaults the selection to the first one', () => {
    const store = fakeStore({ devices: [DEVICE] });
    render(() => <StreamControlsPanel store={store} />);
    expect(screen.getByText('emulator-5554')).toBeTruthy();
    const radio = screen.getByRole('radio') as HTMLInputElement;
    expect(radio.checked).toBe(true);
  });

  it('starts a capture with the selected device and package filter', async () => {
    const store = fakeStore({ devices: [DEVICE] });
    render(() => <StreamControlsPanel store={store} />);

    fireEvent.input(screen.getByLabelText(/package \/ tag filter/i), { target: { value: 'com.example.app' } });
    fireEvent.click(screen.getByRole('button', { name: /start capture/i }));

    await vi.waitFor(() => expect(store.start).toHaveBeenCalledTimes(1));
    expect(store.start).toHaveBeenCalledWith('emulator-5554', { packageFilter: 'com.example.app' });
  });

  it('shows Stop instead of Start once streaming, and stops on click', async () => {
    const store = fakeStore({
      status: { phase: 'streaming', sessionId: 's1', sourceName: 'emulator-5554', sourceType: 'Logcat', totalLines: 5 },
    });
    render(() => <StreamControlsPanel store={store} />);

    expect(screen.queryByRole('button', { name: /start capture/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    await vi.waitFor(() => expect(store.stop).toHaveBeenCalledTimes(1));
  });

  it('disables Save capture until a session exists, then saves to the chosen path', async () => {
    const store = fakeStore({ devices: [DEVICE] });
    render(() => <StreamControlsPanel store={store} />);

    const saveButton = () => screen.getByRole('button', { name: /save capture/i }) as HTMLButtonElement;
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));

    save.mockResolvedValueOnce('C:/out/capture.log');
    fireEvent.click(saveButton());

    await vi.waitFor(() => expect(store.saveCapture).toHaveBeenCalledWith('s1', 'C:/out/capture.log'));
  });

  it('does not save when the save dialog is cancelled', async () => {
    const store = fakeStore({
      status: { phase: 'streaming', sessionId: 's1', sourceName: 'emulator-5554', sourceType: 'Logcat', totalLines: 5 },
    });
    render(() => <StreamControlsPanel store={store} />);

    save.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /save capture/i }));

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(store.saveCapture).not.toHaveBeenCalled();
  });

  it('toggling anonymize while streaming calls setAnonymize for the active session', async () => {
    const store = fakeStore({
      status: { phase: 'streaming', sessionId: 's1', sourceName: 'emulator-5554', sourceType: 'Logcat', totalLines: 5 },
    });
    render(() => <StreamControlsPanel store={store} />);

    fireEvent.click(screen.getByLabelText(/anonymize pii while streaming/i));

    await vi.waitFor(() => expect(store.setAnonymize).toHaveBeenCalledWith('s1', true));
  });

  // M1: ticking the box before Start set only the local signal —
  // `toggleAnonymize` returns early with no session, and neither
  // `StreamStartOptions` nor `start_adb_stream` carries the flag. The capture
  // then streamed raw PII while the checkbox read "on": the one place the UI
  // and the backend's redaction state disagreed.
  it('applies an anonymize tick made before Start once the session exists', async () => {
    const store = fakeStore({ devices: [DEVICE] });
    render(() => <StreamControlsPanel store={store} />);

    fireEvent.click(screen.getByLabelText(/anonymize pii while streaming/i));
    expect(store.setAnonymize).not.toHaveBeenCalled(); // nothing to apply to yet

    fireEvent.click(screen.getByRole('button', { name: /start capture/i }));

    await vi.waitFor(() => expect(store.setAnonymize).toHaveBeenCalledWith('s1', true));
    expect(store.setAnonymize).toHaveBeenCalledTimes(1);
  });

  it('does not touch anonymize on Start when the box was never ticked', async () => {
    const store = fakeStore({ devices: [DEVICE] });
    render(() => <StreamControlsPanel store={store} />);

    fireEvent.click(screen.getByRole('button', { name: /start capture/i }));

    await vi.waitFor(() => expect(store.start).toHaveBeenCalledTimes(1));
    expect(store.setAnonymize).not.toHaveBeenCalled();
  });

  it('surfaces a devicesError message', () => {
    const store = fakeStore();
    (store as { devicesError: () => string | null }).devicesError = () => 'adb not on PATH';
    render(() => <StreamControlsPanel store={store} />);
    expect(screen.getByRole('alert').textContent).toContain('adb not on PATH');
  });
});
