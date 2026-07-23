import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { AnalysisArtifact, AnalysisSeverity } from '../../bridge/types';
import { severityColor } from '../../bridge/types';
import { useSession, useNavigationActions } from '../../context';
import { useAnalysis } from '../../hooks';
import { bus } from '../../events/bus';
import { formatShortDateTime } from '../../utils';
import MarkdownSection from './MarkdownSection';
import styles from './AnalysisReader.module.css';

const AnalysisReader = React.memo(function AnalysisReader() {
  const session = useSession();
  const sessionId = session?.sessionId ?? null;
  const { artifacts } = useAnalysis(sessionId);
  const { jumpToLine } = useNavigationActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Listen for analysis:open events from the left pane list
  useEffect(() => {
    const handler = ({ artifactId }: { artifactId: string }) => {
      setSelectedId(artifactId);
    };
    bus.on('analysis:open', handler);
    return () => { bus.off('analysis:open', handler); };
  }, []);

  // Auto-select first artifact if none selected
  useEffect(() => {
    if (selectedId === null && artifacts.length > 0) {
      setSelectedId(artifacts[0].id);
    }
  }, [selectedId, artifacts]);

  // Clear selection if the selected artifact was deleted
  const artifact: AnalysisArtifact | undefined = artifacts.find((a) => a.id === selectedId);

  const handleJump = useCallback((lineNum: number) => {
    jumpToLine(lineNum);
  }, [jumpToLine]);

  const severityCounts = useMemo(() => {
    if (!artifact) return {} as Partial<Record<AnalysisSeverity, number>>;
    const counts: Partial<Record<AnalysisSeverity, number>> = {};
    for (const s of artifact.sections) {
      if (s.severity) counts[s.severity] = (counts[s.severity] ?? 0) + 1;
    }
    return counts;
  }, [artifact]);

  const SEVERITY_ORDER: AnalysisSeverity[] = ['Critical', 'Error', 'Warning', 'Info'];

  if (!sessionId) {
    return (
      <div className={styles.emptyState}>
        <FileSearch size={40} strokeWidth={1} />
        <p>Open a log file to view analyses.</p>
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className={styles.emptyState}>
        <FileSearch size={40} strokeWidth={1} />
        <p>No analyses for this session.</p>
        <span className={styles.emptyHint}>
          Claude can publish analyses via the MCP analysis tool.
        </span>
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className={styles.emptyState}>
        <p>Select an analysis from the left panel.</p>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.scrollArea}>
        <div className={styles.content}>
          <header className={styles.titleCard}>
            <h2 className={styles.title}>{artifact.title}</h2>
            <span className={styles.timestamp}>{formatShortDateTime(artifact.createdAt)}</span>
            <div className={styles.summaryBar}>
              <span className={styles.summaryCount}>
                {artifact.sections.length} section{artifact.sections.length !== 1 ? 's' : ''}
              </span>
              {SEVERITY_ORDER.map((sev) => {
                const count = severityCounts[sev];
                if (!count) return null;
                return (
                  <span
                    key={sev}
                    className={styles.summaryPill}
                    style={{ color: severityColor(sev) }}
                  >
                    {count} {sev}
                  </span>
                );
              })}
            </div>
          </header>

          {artifact.sections.map((section, i) => (
            <MarkdownSection
              key={i}
              section={section}
              onJumpToLine={handleJump}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

export default AnalysisReader;
