import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { AnalysisArtifact, AnalysisSeverity, SourceReference } from '../../bridge/types';
import { severityColor } from '../../bridge/types';
import { useNavigationActions, useWorkspaceAnalyses, useSessionLabels } from '../../context';
import { attributeArtifact, SourceChips } from '../AnalysisPanel';
import { bus } from '../../events';
import { formatShortDateTime } from '../../utils';
import MarkdownSection from './MarkdownSection';
import type { ResolvedSection } from './MarkdownSection';
import { takePendingAnalysisSelection } from './pendingSelection';
import styles from './AnalysisReader.module.css';

interface Props {
  /** The pane this reader is mounted in — targets the `analysis:open` bus
   *  event so a selection made in one pane's list doesn't steal another
   *  pane's already-open analysis tab. */
  paneId: string;
}

const AnalysisReader = React.memo(function AnalysisReader({ paneId }: Props) {
  // Analyses are workspace-owned, not session-scoped — the reader shows
  // whichever artifact was selected regardless of what's open in this pane.
  const { artifacts } = useWorkspaceAnalyses();
  const labels = useSessionLabels();
  const { jumpToLine } = useNavigationActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Listen for analysis:open events targeted at this pane. `paneId` on the
  // event is the pane `layout:open-tab`'s handler resolved the analysis tab
  // into — with analysis tabs open in two panes, an event meant for the
  // other pane must be ignored here rather than stealing this pane's selection.
  useEffect(() => {
    const handler = ({ artifactId, paneId: targetPaneId }: { artifactId: string; paneId: string }) => {
      if (targetPaneId !== paneId) return;
      setSelectedId(artifactId);
    };
    bus.on('analysis:open', handler);
    return () => { bus.off('analysis:open', handler); };
  }, [paneId]);

  // Resolve the initial selection: prefer a pending selection seeded by
  // useWorkspaceLayout's onOpenTab (the new-tab / reuse-inactive-tab open
  // paths — this reader didn't exist yet when the click fired, so it missed
  // the live `analysis:open` bus event above and must self-serve on mount),
  // else fall back to auto-selecting the first artifact.
  //
  // `takePendingAnalysisSelection` deletes on read, so StrictMode's double
  // effect-invoke would see it return the value once then null — using a
  // functional update for the fallback branch makes this safe regardless:
  // React applies queued updates for `selectedId` in order, so a fallback
  // update queued after the direct `setSelectedId(pending)` still resolves
  // against the just-applied pending value (`prev !== null` short-circuits),
  // rather than clobbering it with `artifacts[0]`.
  useEffect(() => {
    const pending = takePendingAnalysisSelection(paneId);
    if (pending !== null) {
      setSelectedId(pending);
      return;
    }
    setSelectedId((prev) => (prev !== null ? prev : (artifacts.length > 0 ? artifacts[0].id : null)));
  }, [paneId, artifacts]);

  // Clear selection if the selected artifact was deleted — fall back to the
  // first remaining artifact (or null if none remain) so the panel doesn't
  // stick on the empty placeholder forever.
  useEffect(() => {
    if (selectedId !== null && !artifacts.some((a) => a.id === selectedId)) {
      setSelectedId(artifacts[0]?.id ?? null);
    }
  }, [selectedId, artifacts]);

  const artifact: AnalysisArtifact | undefined = artifacts.find((a) => a.id === selectedId);

  const attribution = useMemo(() => {
    if (!artifact) return null;
    return attributeArtifact(artifact, labels);
  }, [artifact, labels]);

  // Resolve each section's references against the current session labels
  // once here, rather than passing a resolver callback down — keeps
  // MarkdownSection's props stable data instead of a function reference.
  const resolvedSections: ResolvedSection[] = useMemo(() => {
    if (!artifact) return [];
    return artifact.sections.map((section) => ({
      ...section,
      references: section.references.map((ref) => ({
        ...ref,
        resolved: ref.sessionId !== null && labels.has(ref.sessionId),
        sourceLabel: ref.sessionId !== null ? labels.get(ref.sessionId) : undefined,
      })),
    }));
  }, [artifact, labels]);

  const handleJump = useCallback((reference: SourceReference) => {
    jumpToLine(reference.lineNumber, undefined, reference.sessionId ?? undefined);
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

  if (artifacts.length === 0) {
    return (
      <div className={styles.emptyState}>
        <FileSearch size={40} strokeWidth={1} />
        <p>No analyses in this workspace.</p>
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
            {attribution && <SourceChips attribution={attribution} />}
          </header>

          {resolvedSections.map((section, i) => (
            <MarkdownSection
              key={i}
              section={section}
              onJump={handleJump}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

export default AnalysisReader;
