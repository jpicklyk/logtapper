/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

// One shared fake window so each test can assert on the calls the buttons make.
// `isMaximized` is a controllable promise source so the restore/maximize label
// can be tested from both states; `onResized` hands back the listener so a test
// can simulate the window being maximised by a route the buttons never see.
const fakeWindow = {
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  resizedListener: null as null | (() => void),
  onResized: vi.fn((cb: () => void) => {
    fakeWindow.resizedListener = cb;
    return Promise.resolve(() => {
      fakeWindow.resizedListener = null;
    });
  }),
};
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => fakeWindow }));

import { WindowControls } from './WindowControls';

afterEach(() => {
  cleanup();
  fakeWindow.minimize.mockClear();
  fakeWindow.toggleMaximize.mockClear();
  fakeWindow.close.mockClear();
  fakeWindow.isMaximized.mockReset();
  fakeWindow.isMaximized.mockResolvedValue(false);
});

describe('WindowControls', () => {
  it('drives the three window operations from the three buttons', () => {
    render(() => <WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(fakeWindow.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(fakeWindow.toggleMaximize).toHaveBeenCalledTimes(1);

    // Labelled "Close window", not "Close": the shell's drawer already has a
    // "Close" button, and an ambiguous name would be the wrong one to hit.
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(fakeWindow.close).toHaveBeenCalledTimes(1);
  });

  it('labels the middle control Restore when the window is already maximised', async () => {
    fakeWindow.isMaximized.mockResolvedValue(true);
    render(() => <WindowControls />);
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Maximize' })).toBeNull();
  });

  // The window can be maximised without this component's button — a double
  // click on the drag region, Win+Up, a snap gesture — so the label must
  // follow the window's actual state, not the last button pressed.
  it('re-reads the maximised state when the window is resized by another route', async () => {
    render(() => <WindowControls />);
    expect(await screen.findByRole('button', { name: 'Maximize' })).toBeTruthy();

    fakeWindow.isMaximized.mockResolvedValue(true);
    fakeWindow.resizedListener?.();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy());
  });
});
