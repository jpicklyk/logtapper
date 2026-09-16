/** @jsxImportSource solid-js */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { save } from '@tauri-apps/plugin-dialog';
import type { ExportAllSessionsInfo } from '@bridge/types';
import { ExportDialog } from './ExportDialog';
import { createExportStore } from './exportStore';
import type { ExportCommands } from './exportStore';

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
afterEach(cleanup);

const saveDialog = vi.mocked(save);

const INFO: ExportAllSessionsInfo = {
  sessions: [{ sessionId: 's1', sourceFilename: 'dumpstate.log', bookmarkCount: 2, analysisCount: 1 }],
  totalProcessorCount: 3,
  totalPipelineProcessorCount: 5,
};

function mount(commands: Partial<ExportCommands>) {
  const store = createExportStore({ commands });
  const result = render(() => <ExportDialog store={store} />);
  return { store, result };
}

// NOTE: no `beforeEach` hook in this describe. Vitest 4.1 re-raises an error
// thrown by a module mock as an unhandled error whenever the describe has a
// beforeEach hook, even when the caller catches it — the failure it produced
// here was the harness, not the component. Each test sets its own
// implementation instead, and the spies it asserts on are created per test.
describe('ExportDialog (D1-L11)', () => {
  it('reports the destination after a successful export', async () => {
    saveDialog.mockResolvedValue('D:/out/dumpstate.lts');
    const exportAllSessions = vi.fn(() => Promise.resolve());
    const { store } = mount({ getExportAllSessionsInfo: () => Promise.resolve(INFO), exportAllSessions });

    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Export…' })).toBeTruthy());
    expect(screen.queryByTestId('export-success')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await vi.waitFor(() => expect(screen.getByTestId('export-success').textContent).toContain('D:/out/dumpstate.lts'));
    store.dispose();
  });

  it('shows the error, not a success, when the export is rejected', async () => {
    saveDialog.mockResolvedValue('D:/out/dumpstate.lts');
    const exportAllSessions = vi.fn(() => Promise.reject(new Error('NOT_ALLOWED')));
    const { store } = mount({ getExportAllSessionsInfo: () => Promise.resolve(INFO), exportAllSessions });

    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Export…' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));

    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('NOT_ALLOWED'));
    expect(screen.queryByTestId('export-success')).toBeNull();
    store.dispose();
  });

  it('survives a failing save dialog without exporting', async () => {
    // A throwing mock, not a rejecting one: Vitest's own mock result-tracking
    // re-raises a mocked *rejected promise* as an unhandled error no matter how
    // the caller handles it, which would mask what this test is about. The
    // component's try/catch covers both shapes identically.
    saveDialog.mockImplementation(() => { throw new Error('dialog backend unavailable'); });
    const exportAllSessions = vi.fn(() => Promise.resolve());
    const { store } = mount({ getExportAllSessionsInfo: () => Promise.resolve(INFO), exportAllSessions });

    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Export…' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));

    await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled());
    await Promise.resolve();
    expect(exportAllSessions).not.toHaveBeenCalled();
    expect(screen.queryByTestId('export-success')).toBeNull();
    store.dispose();
  });

  it('does not export when the dialog is cancelled', async () => {
    saveDialog.mockResolvedValue(null);
    const exportAllSessions = vi.fn(() => Promise.resolve());
    const { store } = mount({ getExportAllSessionsInfo: () => Promise.resolve(INFO), exportAllSessions });

    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Export…' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled());
    expect(exportAllSessions).not.toHaveBeenCalled();
    expect(screen.queryByTestId('export-success')).toBeNull();
    store.dispose();
  });
});
