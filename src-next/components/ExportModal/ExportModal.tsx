import React, { useState, useEffect, useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { Modal } from '../../ui/Modal/Modal';
import { Spinner, Button } from '../../ui';
import { useSession } from '../../context';
import { getExportSessionInfo, exportSession } from '../../bridge/commands';
import type { ExportSessionInfo } from '../../bridge/types';
import { formatFileSize } from '../../utils';
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

  // Fetch session info when modal opens
  useEffect(() => {
    if (!open || !session?.sessionId) {
      setInfo(null);
      setError(null);
      setLoading(false);
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
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }, [session, info, includeBookmarks, includeAnalyses, onClose]);

  return (
    <Modal open={open} onClose={onClose} title="Export Session" width={420}>
      {loading ? (
        <div className={styles.loading}>
          <Spinner size={24} />
          <span>Loading session info...</span>
        </div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : info ? (
        <div className={styles.content}>
          <div className={styles.sourceInfo}>
            <span className={styles.sourceLabel}>Source:</span>
            <span className={styles.sourceValue}>
              {info.sourceFilename} ({formatFileSize(info.sourceSize)})
            </span>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}>Include:</div>
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
          </div>

          {info.processors.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                Processors (always included):
              </div>
              <ul className={styles.processorList}>
                {info.processors.map((p) => (
                  <li key={p.id} className={p.builtin ? styles.processorBuiltin : styles.processorCustom}>
                    {p.name}
                    {p.builtin && <span className={styles.builtinBadge}>built-in</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.actions}>
            <Button variant="ghost" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              className={styles.exportBtn}
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
