import { describe, expect, it, vi } from 'vitest';
import { createExportStore } from './exportStore';
import type { ExportAllOptions, ExportAllSessionsInfo, LtwEditorTab } from '@bridge/types';
const INFO: ExportAllSessionsInfo = {
  sessions: [
    { sessionId: 's1', sourceFilename: 'a.log', bookmarkCount: 2, analysisCount: 1 },
    { sessionId: 's2', sourceFilename: 'b.log', bookmarkCount: 0, analysisCount: 0 },
  ],
  totalProcessorCount: 3,
  totalPipelineProcessorCount: 5,
};
describe('exportStore', () => {
  it('refresh loads session info', async () => {
    const getExportAllSessionsInfo = vi.fn(() => Promise.resolve(INFO));
    const store = createExportStore({ commands: { getExportAllSessionsInfo } });
    store.refresh();
    await vi.waitFor(() => expect(store.info()).toEqual(INFO));
    expect(store.loading()).toBe(false);
    store.dispose();
  });
  it('runExport sends the exact ExportAllOptions payload (no anonymize flag — the mode decides)', async () => {
    const exportAllSessions = vi.fn(() => Promise.resolve());
    const store = createExportStore({ commands: { exportAllSessions } });
    store.setOption('includeBookmarks', false);
    await store.runExport('D:/out/session.lts');
    const expected: ExportAllOptions = {
      destPath: 'D:/out/session.lts',
      includeBookmarks: false,
      includeAnalyses: true,
      includeProcessors: true,
      editorTabs: [],
    };
    expect(exportAllSessions).toHaveBeenCalledWith(expected);
    expect(Object.keys((exportAllSessions.mock.calls as unknown[][])[0]?.[0] as object)).not.toContain('anonymize');
    expect(store.exporting()).toBe(false);
    store.dispose();
  });
  it('runExport bundles the live editor tabs from getEditorTabs, read at export time', async () => {
    const exportAllSessions = vi.fn(() => Promise.resolve());
    const tabs: LtwEditorTab[] = [];
    const getEditorTabs = vi.fn(() => tabs);
    const store = createExportStore({ commands: { exportAllSessions }, getEditorTabs });
    // A tab opened after the store was built must still be exported — the
    // provider is consulted per run, not snapshotted at construction.
    tabs.push({ label: 'notes.md', content: '# scratch', viewMode: 'split', wordWrap: true, filePath: null });
    await store.runExport('D:/out/session.lts');
    expect(getEditorTabs).toHaveBeenCalledTimes(1);
    const sent = (exportAllSessions.mock.calls[0] as unknown as [ExportAllOptions])[0];
    expect(sent.editorTabs).toEqual(tabs);
    store.dispose();
  });

  it('shows a refused-destination error verbatim (B3 policy gate)', async () => {
    const gateError = 'NOT_ALLOWED: destination is outside the configured allowlist';
    const exportAllSessions = vi.fn(() => Promise.reject(new Error(gateError)));
    const store = createExportStore({ commands: { exportAllSessions } });
    await expect(store.runExport('C:/blocked/out.lts')).rejects.toThrow();
    expect(store.error()).toContain(gateError);
    expect(store.exporting()).toBe(false);
    store.dispose();
  });
  it('surfaces a failed refresh as an error rather than throwing', async () => {
    const getExportAllSessionsInfo = vi.fn(() => Promise.reject(new Error('boom')));
    const store = createExportStore({ commands: { getExportAllSessionsInfo } });
    store.refresh();
    await vi.waitFor(() => expect(store.error()).toContain('boom'));
    store.dispose();
  });
});
