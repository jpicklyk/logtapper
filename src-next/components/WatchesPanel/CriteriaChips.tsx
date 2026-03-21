import React from 'react';
import type { FilterCriteria } from '../../bridge/types';
import styles from './WatchesPanel.module.css';
import clsx from 'clsx';

interface CriteriaChipsProps {
  criteria: FilterCriteria;
}

const LEVEL_SHORT: Record<string, string> = {
  Verbose: 'V',
  Debug: 'D',
  Info: 'I',
  Warn: 'W',
  Error: 'E',
  Fatal: 'F',
};

const DANGER_LEVELS = new Set(['Error', 'Fatal']);
const WARNING_LEVELS = new Set(['Warn']);

export const CriteriaChips = React.memo(function CriteriaChips({ criteria }: CriteriaChipsProps) {
  const chips: React.ReactNode[] = [];

  if (criteria.textSearch) {
    chips.push(
      <span key="text" className={styles.chip}>
        <span className={styles.chipLabel}>text:</span> {criteria.textSearch}
      </span>,
    );
  }

  if (criteria.regex) {
    chips.push(
      <span key="regex" className={styles.chip}>
        /{criteria.regex}/
      </span>,
    );
  }

  if (criteria.logLevels && criteria.logLevels.length > 0) {
    chips.push(
      <span key="levels" className={styles.chip}>
        {criteria.logLevels.map((lvl) => (
          <span
            key={lvl}
            className={clsx(
              styles.levelChar,
              DANGER_LEVELS.has(lvl) && styles.chipDanger,
              WARNING_LEVELS.has(lvl) && styles.chipWarning,
            )}
          >
            {LEVEL_SHORT[lvl] ?? lvl}
          </span>
        ))}
      </span>,
    );
  }

  if (criteria.tags && criteria.tags.length > 0) {
    for (const tag of criteria.tags) {
      chips.push(
        <span key={`tag-${tag}`} className={styles.chip}>
          <span className={styles.chipLabel}>tag:</span> {tag}
        </span>,
      );
    }
  }

  if (criteria.pids && criteria.pids.length > 0) {
    chips.push(
      <span key="pids" className={styles.chip}>
        <span className={styles.chipLabel}>pid:</span> {criteria.pids.join(', ')}
      </span>,
    );
  }

  if (criteria.combine === 'or') {
    chips.push(
      <span key="combine" className={clsx(styles.chip, styles.chipAccent)}>OR</span>,
    );
  }

  if (chips.length === 0) {
    chips.push(
      <span key="empty" className={clsx(styles.chip, styles.chipDimmed)}>no criteria</span>,
    );
  }

  return <div className={styles.chips}>{chips}</div>;
});
