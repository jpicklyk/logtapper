import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnalysisSection } from '../../bridge/types';
import { severityColor } from '../../bridge/types';
import LineReference from './LineReference';
import styles from './AnalysisReader.module.css';

interface Props {
  section: AnalysisSection;
  onJumpToLine: (lineNum: number) => void;
}

const MarkdownSection = React.memo(function MarkdownSection({ section, onJumpToLine }: Props) {
  const borderColor = section.severity
    ? severityColor(section.severity)
    : 'var(--border-subtle)';

  return (
    <div className={styles.section} style={{ borderLeftColor: borderColor }}>
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
      <div className={styles.sectionBody}>
        <Markdown remarkPlugins={[remarkGfm]}>{section.body}</Markdown>
      </div>
      {section.references.length > 0 && (
        <div className={styles.references}>
          {section.references.map((ref, i) => (
            <LineReference
              key={`${ref.lineNumber}-${i}`}
              reference={ref}
              onJump={onJumpToLine}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default MarkdownSection;
