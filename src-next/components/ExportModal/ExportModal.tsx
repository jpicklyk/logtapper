import React, { useState, useEffect, useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { Modal } from '../../ui/Modal/Modal';
import { Spinner, Button } from '../../ui';
import { useSession } from '../../context';
import { getExportSessionInfo, exportSession } from '../../bridge/commands';
import type { ExportSessionInfo } from '../../bridge/types';
import styles from './ExportModal.module.css';

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
}

export const ExportModal = React.memo<ExportModalProps>(function ExportModal({ open, onClose }) {
  const session = useSession();
  const [info, setInfo] = useState<ExportSessionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeBookmarks, setIncludeBookmarks] = useState(true);
  const [includeAnalyses, setIncludeAnalyses] = useState(true);
  const [includeProcessors, setIncludeProcessors] = useState(true);

  // Fetch session info when modal opens
  useEffect(() => {
    if (!open || !session?.sessionId) {
      setInfo(null);
      setError(null);
      setLoading(false);
      setIncludeBookmarks(true);
      setIncludeAnalyses(true);
      setIncludeProcessors(true);
      return;
    }
    let cancelled = false;
    const sid = session.sessionId;
    setLoading(true);
    getExportSessionInfo(sid).then(data => {
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
  }, [open, session?.sessionId]);

  const handleExport = useCallback(async () => {
    if (!session || !info) return;
    try {
      const destPath = await save({
        defaultPath: info.sourceFilename.replace(/\.[^.]+$/, '') + '.lts',
        filters: [{ name: 'LogTapper Session', extensions: ['lts'] }],
      });
      if (typeof destPath !== 'string') return; // user cancelled

      setExporting(true);
      setError(null);
      await exportSession(session.sessionId, {
        destPath,
        includeBookmarks,
        includeAnalyses,
        includeProcessors,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }, [session, info, includeBookmarks, includeAnalyses, includeProcessors, onClose]);

  return (
    <Modal open={open} onClose={onClose} title="Export Session" width={360}>
      {loading ? (
        <div className={styles.loading}>
          <Spinner size={24} />
          <span>Loading session info...</span>
        </div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : info ? (
        <div className={styles.content}>
          <div className={styles.sourceInfo}>{info.sourceFilename}</div>

          <div className={styles.section}>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={includeBookmarks}
                onChange={(e) => setIncludeBookmarks(e.target.checked)}
              />
              Bookmarks ({info.bookmarkCount})
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={includeAnalyses}
                onChange={(e) => setIncludeAnalyses(e.target.checked)}
              />
              Analyses ({info.analysisCount})
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={includeProcessors}
                onChange={(e) => setIncludeProcessors(e.target.checked)}
              />
              Processors ({info.processorCount})
            </label>
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
      ) : null}
    </Modal>
  );
});
