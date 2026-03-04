import React from 'react';
import type { MarketplaceEntry } from '../../bridge/types';
import css from './MarketplacePanel.module.css';

const PROC_TYPE_CLASS: Record<string, string> = {
  reporter: css.typeReporter,
  state_tracker: css.typeTracker,
  correlator: css.typeCorrelator,
  annotator: css.typeCorrelator,
  transformer: css.typeTransformer,
};

const PROC_TYPE_LABEL: Record<string, string> = {
  reporter: 'Reporter',
  state_tracker: 'StateTracker',
  correlator: 'Correlator',
  annotator: 'Annotator',
  transformer: 'Transformer',
};

interface Props {
  entry: MarketplaceEntry;
  installed: boolean;
  installStatus?: 'idle' | 'installing' | 'installed' | 'error';
  installError?: string;
  onInstall: () => void;
}

export const MarketplaceEntryRow = React.memo(function MarketplaceEntryRow({
  entry,
  installed,
  installStatus = 'idle',
  installError,
  onInstall,
}: Props) {
  const typeClass = entry.processorType ? PROC_TYPE_CLASS[entry.processorType] ?? '' : '';
  const typeLabel = entry.processorType
    ? PROC_TYPE_LABEL[entry.processorType] ?? entry.processorType
    : '';

  return (
    <div className={css.entryRow}>
      <div className={css.entryInfo}>
        <div className={css.entryHeader}>
          <span className={css.entryName}>{entry.name}</span>
          <span className={css.entryVersion}>v{entry.version}</span>
          {typeLabel && (
            <span className={`${css.typeBadge} ${typeClass}`}>{typeLabel}</span>
          )}
          {entry.deprecated && <span className={css.deprecatedBadge}>deprecated</span>}
        </div>
        {entry.description && (
          <div className={css.entryDesc}>{entry.description}</div>
        )}
        {entry.tags.length > 0 && (
          <div className={css.tags}>
            {entry.tags.map((t) => (
              <span key={t} className={css.tag}>{t}</span>
            ))}
          </div>
        )}
        {installError && (
          <div className={css.errorBar} style={{ marginTop: 4 }}>{installError}</div>
        )}
      </div>
      <div className={css.entryAction}>
        {installed || installStatus === 'installed' ? (
          <span className={css.installedLabel}>Installed</span>
        ) : (
          <button
            className={css.actionBtn}
            onClick={onInstall}
            disabled={installStatus === 'installing'}
          >
            {installStatus === 'installing' ? (
              <><span className={css.spinner} /> Installing...</>
            ) : (
              'Install'
            )}
          </button>
        )}
      </div>
    </div>
  );
});
