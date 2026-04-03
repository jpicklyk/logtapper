import React, { useState, useEffect, useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { Modal } from '../../ui/Modal/Modal';
import { Spinner, Button } from '../../ui';
import { getExportAllSessionsInfo, exportAllSessions } from '../../bridge/commands';
import type { ExportAllSessionsInfo, LtsEditorTabPayload } from '../../bridge/types';
import { allPanes } from '../../hooks/workspace/splitTreeHelpers';
import type { SplitNode } from '../../hooks/workspace/workspaceTypes';
import { LS_CONTENT_PREFIX, LS_MODE_PREFIX, LS_WRAP_PREFIX, LS_FILEPATH_PREFIX } from '../EditorTab/EditorTab';
import styles from './ExportModal.module.css';

function collectEditorTabs(): LtsEditorTabPayload[] {
  const raw = localStorage.getItem('logtapper_workspace_v1');
  if (!raw) return [];

  let persisted: { centerTree?: SplitNode };
  try {
    persisted = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!persisted.centerTree) return [];

  const tabs: LtsEditorTabPayload[] = [];
  for (const pane of allPanes(persisted.centerTree)) {
    for (const tab of pane.tabs) {
      if (tab.type !== 'editor') continue;
      const content = localStorage.getItem(LS_CONTENT_PREFIX + tab.id) ?? '';
      const viewMode = localStorage.getItem(LS_MODE_PREFIX + tab.id) ?? 'editor';
      const wordWrap = localStorage.getItem(LS_WRAP_PREFIX + tab.id) === 'true';
      const filePath = localStorage.getItem(LS_FILEPATH_PREFIX + tab.id) ?? null;
      tabs.push({
        label: tab.label,
        content,
        viewMode,
        wordWrap,
        filePath,
      });
    }
  }
  return tabs;
}

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
}

export const ExportModal = React.memo<ExportModalProps>(function ExportModal({ open, onClose }) {
  const [info, setInfo] = useState<ExportAllSessionsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeBookmarks, setIncludeBookmarks] = useState(true);
  const [includeAnalyses, setIncludeAnalyses] = useState(true);
  const [includeProcessors, setIncludeProcessors] = useState(true);
  const [editorTabCount, setEditorTabCount] = useState(0);

  useEffect(() => {
    if (!open) {
      setInfo(null);
      setError(null);
      setLoading(false);
      setIncludeBookmarks(true);
      setIncludeAnalyses(true);
      setIncludeProcessors(true);
      setEditorTabCount(0);
      return;
    }
    setEditorTabCount(collectEditorTabs().length);
    let cancelled = false;
    setLoading(true);
    getExportAllSessionsInfo().then(data => {
      if (!cancelled) {
        setInfo(data);
        setLoading(false);
      }
    }).catch(e => {
      if (!cancelled) {
        setError(String(e));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  const handleExport = useCallback(async () => {
    if (!info || info.sessions.length === 0) return;
    try {
      const firstName = info.sessions[0].sourceFilename.replace(/\.[^.]+$/, '');
      const defaultName = info.sessions.length === 1
        ? `${firstName}.lts`
        : `${firstName}-and-${info.sessions.length - 1}-more.lts`;
      const destPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'LogTapper Session', extensions: ['lts'] }],
      });
      if (typeof destPath !== 'string') return;

      setExporting(true);
      setError(null);
      await exportAllSessions({
        destPath,
        includeBookmarks,
        includeAnalyses,
        includeProcessors,
        editorTabs: collectEditorTabs(),
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }, [info, includeBookmarks, includeAnalyses, includeProcessors, onClose]);

  const multiSession = info && info.sessions.length > 1;
  const title = multiSession ? 'Export Sessions' : 'Export Session';
  const totalBookmarks = info?.sessions.reduce((sum, s) => sum + s.bookmarkCount, 0) ?? 0;
  const totalAnalyses = info?.sessions.reduce((sum, s) => sum + s.analysisCount, 0) ?? 0;

  return (
    <Modal open={open} onClose={onClose} title={title} width={400}>
      {loading ? (
        <div className={styles.loading}>
          <Spinner size={24} />
          <span>Loading session info...</span>
        </div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : info && info.sessions.length > 0 ? (
        <div className={styles.content}>
          <div className={styles.sessionList}>
            {info.sessions.map((s) => (
              <div key={s.sessionId} className={styles.sessionEntry}>
                <span className={styles.sessionName}>{s.sourceFilename}</span>
              </div>
            ))}
          </div>

          <div className={styles.section}>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={includeBookmarks}
                onChange={(e) => setIncludeBookmarks(e.target.checked)}
              />
              Bookmarks ({totalBookmarks})
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={includeAnalyses}
                onChange={(e) => setIncludeAnalyses(e.target.checked)}
              />
              Analyses ({totalAnalyses})
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={includeProcessors}
                onChange={(e) => setIncludeProcessors(e.target.checked)}
              />
              Processors ({info.totalProcessorCount} of {info.totalPipelineProcessorCount} enabled)
            </label>
            {editorTabCount > 0 && (
              <div className={styles.infoLine}>
                Editor tabs ({editorTabCount})
              </div>
            )}
          </div>

          <div className={styles.actions}>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleExport}
              disabled={exporting}
              loading={exporting}
            >
              {exporting ? 'Exporting...' : 'Export...'}
            </Button>
          </div>
        </div>
      ) : info ? (
        <div className={styles.error}>No sessions to export.</div>
      ) : null}
    </Modal>
  );
});
