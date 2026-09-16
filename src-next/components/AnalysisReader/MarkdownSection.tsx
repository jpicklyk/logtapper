import React from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnalysisSection, SourceReference } from '../../bridge/types';
import { severityColor } from '../../bridge/types';
import { openExternalLinkFromEvent } from '../../bridge/externalLinks';
import LineReference from './LineReference';
import styles from './AnalysisReader.module.css';

/**
 * A section reference augmented with resolution info computed once by
 * AnalysisReader (from `useSessionLabels()`). Keeping the data precomputed —
 * rather than passing a resolver callback down — keeps this component's
 * props stable data, not a function reference that changes identity.
 */
export interface ResolvedReference extends SourceReference {
  resolved: boolean;
  sourceLabel?: string;
}

export interface ResolvedSection extends Omit<AnalysisSection, 'references'> {
  references: ResolvedReference[];
}

interface Props {
  section: ResolvedSection;
  onJump: (reference: SourceReference) => void;
}

const markdownComponents: Components = {
  table({ children }) {
    return (
      <div className={styles.tableWrapper}>
        <table>{children}</table>
      </div>
    );
  },
};

const MarkdownSection = React.memo(function MarkdownSection({ section, onJump }: Props) {
  const borderColor = section.severity
    ? severityColor(section.severity)
    : 'var(--border-subtle)';

  return (
    <div className={styles.section} style={{ '--section-accent': borderColor } as React.CSSProperties}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionHeading}>{section.heading}</h3>
        {section.severity && (
          <span
            className={styles.severityBadge}
            style={{ color: borderColor }}
          >
            {section.severity}
          </span>
        )}
      </div>
      {section.references.length > 0 && (
        <div className={styles.references}>
          {section.references.map((ref, i) => (
            <LineReference
              key={`${ref.lineNumber}-${i}`}
              reference={ref}
              onJump={onJump}
            />
          ))}
        </div>
      )}
      {/*
        One delegated click handler rather than a `components.a` override: the
        anchors are markdown output, not components, and the section body is
        their only container. An `http`/`https`/`mailto` link — this prose can
        come from an agent via `publish_analysis` — must never navigate the
        webview away from the app; `openExternalLinkFromEvent` cancels it and
        hands the URL to the OS. See `bridge/externalLinks.ts`.
      */}
      <div className={styles.sectionBody} onClick={openExternalLinkFromEvent}>
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{section.body}</Markdown>
      </div>
    </div>
  );
});

export default MarkdownSection;
