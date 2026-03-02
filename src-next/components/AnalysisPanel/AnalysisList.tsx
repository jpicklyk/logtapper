import React, { useCallback, useMemo } from 'react';
import { Trash2, ExternalLink, MapPin } from 'lucide-react';
import type { AnalysisArtifact, AnalysisSection, AnalysisSeverity } from '../../bridge/types';
import { useSession, useViewerActions } from '../../context';
import { useAnalysis } from '../../hooks';
import { bus } from '../../events/bus';
import styles from './AnalysisList.module.css';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: AnalysisSeverity[] = ['Critical', 'Error', 'Warning', 'Info'];

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
  for (const level of SEVERITY_ORDER) {
    if (artifact.sections.some((s) => s.severity === level)) return level;
  }
  return null;
}

function severityCounts(sections: AnalysisSection[]): { severity: AnalysisSeverity; count: number }[] {
  const map = new Map<AnalysisSeverity, number>();
  for (const s of sections) {
    if (s.severity) map.set(s.severity, (map.get(s.severity) ?? 0) + 1);
  }
  return SEVERITY_ORDER
    .filter((sev) => map.has(sev))
    .map((sev) => ({ severity: sev, count: map.get(sev)! }));
}

function totalRefs(artifact: AnalysisArtifact): number {
  let n = 0;
  for (const s of artifact.sections) n += s.references.length;
  return n;
}

function extractExcerpt(body: string, maxLen = 120): string {
  // Strip markdown formatting to get plain-ish text
  const plain = body
    .replace(/```[\s\S]*?```/g, '')       // code blocks
    .replace(/\|[^\n]+\|/g, '')           // table rows
    .replace(/[|─┌┐└┘├┤┬┴┼]+/g, '')      // box-drawing
    .replace(/#+\s+/g, '')                // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold
    .replace(/`([^`]+)`/g, '$1')          // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/\n{2,}/g, ' ')             // paragraph breaks → space
    .replace(/\n/g, ' ')                 // line breaks → space
    .replace(/\s{2,}/g, ' ')             // collapse whitespace
    .trim();
  if (plain.length <= maxLen) return plain;
  return plain.slice(0, maxLen).replace(/\s+\S*$/, '') + '\u2026';
}

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Section row ──────────────────────────────────────────────────────────────

const SectionRow = React.memo(function SectionRow({
  section,
  index,
}: {
  section: AnalysisSection;
  index: number;
}) {
  const color = severityColor(section.severity);
  return (
    <div className={styles.sectionRow}>
      <span className={styles.sectionIndicator} style={{ background: color }} />
      <span className={styles.sectionHeading}>{section.heading}</span>
      {section.references.length > 0 && (
        <span className={styles.sectionRefCount} title={`${section.references.length} line reference${section.references.length !== 1 ? 's' : ''}`}>
          {section.references.length}
        </span>
      )}
    </div>
  );
});

// ── Analysis card ────────────────────────────────────────────────────────────

interface ItemProps {
  artifact: AnalysisArtifact;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

const AnalysisItem = React.memo(function AnalysisItem({ artifact, onOpen, onDelete }: ItemProps) {
  const severity = highestSeverity(artifact);
  const sevCounts = useMemo(() => severityCounts(artifact.sections), [artifact.sections]);
  const refCount = useMemo(() => totalRefs(artifact), [artifact]);
  const excerpt = useMemo(() => {
    // Use the first section's body as the summary excerpt
    if (artifact.sections.length === 0) return '';
    return extractExcerpt(artifact.sections[0].body);
  }, [artifact.sections]);

  const handleClick = useCallback(() => onOpen(artifact.id), [artifact.id, onOpen]);
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(artifact.id);
  }, [artifact.id, onDelete]);

  return (
    <div className={styles.card} onClick={handleClick} role="button" tabIndex={0}>
      {/* Top severity bar */}
      <div
        className={styles.cardSeverityBar}
        style={{ background: severityColor(severity) }}
      />

      {/* Header row: title + actions */}
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{artifact.title}</h3>
        <button
          className={styles.deleteBtn}
          onClick={handleDelete}
          type="button"
          title="Delete analysis"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Meta row: time + stats */}
      <div className={styles.cardMeta}>
        <span>{relativeTime(artifact.createdAt)}</span>
        <span className={styles.metaDivider}>{'\u00b7'}</span>
        <span>{artifact.sections.length} section{artifact.sections.length !== 1 ? 's' : ''}</span>
        {refCount > 0 && (
          <>
            <span className={styles.metaDivider}>{'\u00b7'}</span>
            <MapPin size={10} className={styles.metaIcon} />
            <span>{refCount} ref{refCount !== 1 ? 's' : ''}</span>
          </>
        )}
      </div>

      {/* Severity breakdown pills */}
      {sevCounts.length > 0 && (
        <div className={styles.severityRow}>
          {sevCounts.map(({ severity: sev, count }) => (
            <span
              key={sev}
              className={styles.severityPill}
              style={{
                color: severityColor(sev),
                borderColor: severityColor(sev),
              }}
            >
              {count} {sev}
            </span>
          ))}
        </div>
      )}

      {/* Excerpt */}
      {excerpt && (
        <p className={styles.excerpt}>{excerpt}</p>
      )}

      {/* Section headings list */}
      {artifact.sections.length > 0 && (
        <div className={styles.sectionList}>
          {artifact.sections.map((s, i) => (
            <SectionRow key={i} section={s} index={i} />
          ))}
        </div>
      )}

      {/* Open action */}
      <div className={styles.openAction}>
        <ExternalLink size={11} />
        <span>Open full analysis</span>
      </div>
    </div>
  );
});

// ── List container ───────────────────────────────────────────────────────────

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
        <div className={styles.empty}>Loading{'\u2026'}</div>
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
