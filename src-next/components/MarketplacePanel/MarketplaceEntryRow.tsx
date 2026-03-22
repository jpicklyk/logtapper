import React from 'react';
import type { MarketplaceEntry } from '../../bridge/types';
import css from './MarketplacePanel.module.css';
import badgeCss from '../../ui/processorBadge.module.css';
import { PROC_TYPE_LABELS, PROC_TYPE_CLASS_KEY } from '../../ui/processorBadgeTypes';

interface Props {
  entry: MarketplaceEntry;
  installed: boolean;
  installStatus?: 'idle' | 'installing' | 'installed' | 'error';
  uninstallStatus?: 'idle' | 'uninstalling' | 'error';
  installError?: string;
  onInstall: () => void;
  onUninstall?: () => void;
}

export const MarketplaceEntryRow = React.memo(function MarketplaceEntryRow({
  entry,
  installed,
  installStatus = 'idle',
  uninstallStatus = 'idle',
  installError,
  onInstall,
  onUninstall,
}: Props) {
  const typeClass = entry.processorType
    ? badgeCss[PROC_TYPE_CLASS_KEY[entry.processorType] as keyof typeof badgeCss] ?? ''
    : '';
  const typeLabel = entry.processorType
    ? PROC_TYPE_LABELS[entry.processorType] ?? entry.processorType
    : '';

  return (
    <div className={css.entryRow}>
      <div className={css.entryInfo}>
        <div className={css.entryHeader}>
          <span className={css.entryName}>{entry.name}</span>
          <span className={css.entryVersion}>v{entry.version}</span>
          {typeLabel && (
            <span className={`${badgeCss.typeBadge} ${typeClass}`}>{typeLabel}</span>
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
          onUninstall ? (
            <button
              className={css.actionBtnSecondary}
              onClick={onUninstall}
              disabled={uninstallStatus === 'uninstalling'}
              title="Uninstall this processor"
            >
              {uninstallStatus === 'uninstalling' ? (
                <><span className={css.spinner} /> Removing...</>
              ) : (
                'Uninstall'
              )}
            </button>
          ) : (
            <span className={css.installedLabel}>Installed</span>
          )
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
