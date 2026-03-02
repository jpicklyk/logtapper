import React, { useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import type { AnalysisArtifact, AnalysisSeverity } from '../../bridge/types';
import { useSession, useViewerActions } from '../../context';
import { useAnalysis } from '../../hooks';
import { bus } from '../../events/bus';
import styles from './AnalysisList.module.css';

function severityColor(severity: AnalysisSeverity | null): string {
  switch (severity) {
    case 'Critical': return 'var(--danger)';
    case 'Error':    return 'var(--danger)';
    case 'Warning':  return 'var(--warning)';
    case 'Info':     return 'var(--accent)';
    default:         return 'var(--text-dimmed)';
  }
}

function highestSeverity(artifact: AnalysisArtifact): AnalysisSeverity | null {
  const order: AnalysisSeverity[] = ['Critical', 'Error', 'Warning', 'Info'];
  for (const level of order) {
    if (artifact.sections.some((s) => s.severity === level)) return level;
  }
  return null;
}

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface ItemProps {
  artifact: AnalysisArtifact;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

const AnalysisItem = React.memo(function AnalysisItem({ artifact, onOpen, onDelete }: ItemProps) {
  const severity = highestSeverity(artifact);
  const handleClick = useCallback(() => onOpen(artifact.id), [artifact.id, onOpen]);
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(artifact.id);
  }, [artifact.id, onDelete]);

  return (
    <button className={styles.item} onClick={handleClick} type="button">
      <span
        className={styles.severityDot}
        style={{ background: severityColor(severity) }}
      />
      <div className={styles.itemContent}>
        <span className={styles.itemTitle}>{artifact.title}</span>
        <span className={styles.itemMeta}>
          {artifact.sections.length} section{artifact.sections.length !== 1 ? 's' : ''}
          {' \u00b7 '}
          {relativeTime(artifact.createdAt)}
        </span>
      </div>
      <button
        className={styles.deleteBtn}
        onClick={handleDelete}
        type="button"
        title="Delete analysis"
      >
        <Trash2 size={13} />
      </button>
    </button>
  );
});

const AnalysisList = React.memo(function AnalysisList() {
  const session = useSession();
  const sessionId = session?.sessionId ?? null;
  const { artifacts, analysisLoading, deleteAnalysis } = useAnalysis(sessionId);
  const { openTab } = useViewerActions();

  const handleOpen = useCallback((artifactId: string) => {
    bus.emit('analysis:open', { artifactId });
    openTab('analysis');
  }, [openTab]);

  const handleDelete = useCallback((artifactId: string) => {
    deleteAnalysis(artifactId);
  }, [deleteAnalysis]);

  if (!sessionId) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>No session loaded.</div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Analyses</span>
        {artifacts.length > 0 && (
          <span className={styles.headerCount}>{artifacts.length}</span>
        )}
      </div>
      {analysisLoading && artifacts.length === 0 && (
        <div className={styles.empty}>Loading\u2026</div>
      )}
      {!analysisLoading && artifacts.length === 0 && (
        <div className={styles.empty}>
          No analyses yet.{'\n'}Claude can publish analyses via MCP.
        </div>
      )}
      <div className={styles.list}>
        {artifacts.map((a) => (
          <AnalysisItem
            key={a.id}
            artifact={a}
            onOpen={handleOpen}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
});

export default AnalysisList;
