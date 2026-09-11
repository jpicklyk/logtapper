// @vitest-environment jsdom
/**
 * Item 0ea8aad3 — explicit "Anonymize PII" export option.
 *
 * Covers the ExportModal.tsx checkbox: it renders unchecked by default, its
 * choice persists via `useSettings` (key `exportAnonymize`) across remounts,
 * and the resolved value is threaded through to `exportAllSessions` as
 * `options.anonymize` on Export.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../context', () => ({
  useFileActions: vi.fn(),
}));
vi.mock('../../bridge/commands', () => ({
  getExportAllSessionsInfo: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));
// ExportModal pulls in collectEditorTabs/allPanes from '../../hooks/workspace',
// whose module graph reaches EditorTab -> TextEditor -> ThemeContext's
// module-load `window.matchMedia` call — unavailable in jsdom. Mock the
// constants directly, same pattern as useCenterTree.test.ts / useWorkspace.test.ts.
vi.mock('../../components/EditorTab', () => ({
  LS_CONTENT_PREFIX: 'logtapper_scratchpad_',
  LS_MODE_PREFIX: 'logtapper_editor_mode_',
  LS_WRAP_PREFIX: 'logtapper_editor_wrap_',
  LS_FILEPATH_PREFIX: 'logtapper_editor_filepath_',
}));

import { useFileActions } from '../../context';
import { getExportAllSessionsInfo } from '../../bridge/commands';
import { save } from '@tauri-apps/plugin-dialog';
import { resetSettings, getSettingsSnapshot } from '../../hooks/useSettings';
import { ExportModal } from './ExportModal';

const mockedUseFileActions = useFileActions as unknown as MockInstance;
const mockedGetInfo = getExportAllSessionsInfo as unknown as MockInstance;
const mockedSave = save as unknown as MockInstance;

const FIXTURE_INFO = {
  sessions: [
    { sessionId: 's1', sourceFilename: 'device.log', bookmarkCount: 0, analysisCount: 0 },
  ],
  totalProcessorCount: 0,
  totalPipelineProcessorCount: 0,
};

describe('[0ea8aad3] ExportModal — Anonymize PII checkbox', () => {
  let exportAllSessions: MockInstance;

  beforeEach(() => {
    localStorage.clear();
    resetSettings();
    exportAllSessions = vi.fn().mockResolvedValue(undefined);
    mockedUseFileActions.mockReturnValue({ exportAllSessions });
    mockedGetInfo.mockResolvedValue(FIXTURE_INFO);
    mockedSave.mockResolvedValue('C:\\out\\device.lts');
  });

  afterEach(() => {
    cleanup();
  });

  async function renderOpenModal() {
    render(<ExportModal open onClose={() => {}} />);
    return screen.findByLabelText('Anonymize PII in exported log lines');
  }

  it('renders the checkbox unchecked by default', async () => {
    const checkbox = await renderOpenModal();
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(getSettingsSnapshot().exportAnonymize).toBe(false);
  });

  it('persists the choice in AppSettings when toggled', async () => {
    const checkbox = await renderOpenModal();
    fireEvent.click(checkbox);

    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(getSettingsSnapshot().exportAnonymize).toBe(true);

    // A fresh mount picks up the persisted choice as its default.
    cleanup();
    const remounted = await renderOpenModal();
    expect((remounted as HTMLInputElement).checked).toBe(true);
  });

  it('passes anonymize: true to exportAllSessions once ticked', async () => {
    const checkbox = await renderOpenModal();
    fireEvent.click(checkbox);

    const exportButton = await screen.findByRole('button', { name: /Export/ });
    fireEvent.click(exportButton);

    await waitFor(() => expect(exportAllSessions).toHaveBeenCalledTimes(1));
    expect(exportAllSessions).toHaveBeenCalledWith(
      expect.objectContaining({ anonymize: true }),
    );
  });

  it('passes anonymize: false to exportAllSessions when left unticked', async () => {
    await renderOpenModal();

    const exportButton = await screen.findByRole('button', { name: /Export/ });
    fireEvent.click(exportButton);

    await waitFor(() => expect(exportAllSessions).toHaveBeenCalledTimes(1));
    expect(exportAllSessions).toHaveBeenCalledWith(
      expect.objectContaining({ anonymize: false }),
    );
  });
});
