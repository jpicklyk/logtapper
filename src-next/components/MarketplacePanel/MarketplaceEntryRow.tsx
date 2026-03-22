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
  /** Called when user clicks the row (not the action buttons) to toggle details. */
  onRowClick?: () => void;
  /** Whether the detail card is currently expanded. */
  expanded?: boolean;
}

export const MarketplaceEntryRow = React.memo(function MarketplaceEntryRow({
  entry,
  installed,
  installStatus = 'idle',
  uninstallStatus = 'idle',
  installError,
  onInstall,
  onUninstall,
  onRowClick,
  expanded = false,
}: Props) {
  const typeClass = entry.processorType
    ? badgeCss[PROC_TYPE_CLASS_KEY[entry.processorType] as keyof typeof badgeCss] ?? ''
    : '';
  const typeLabel = entry.processorType
    ? PROC_TYPE_LABELS[entry.processorType] ?? entry.processorType
    : '';

  return (
    <div
      className={`${css.entryRow}${onRowClick ? ` ${css.entryRowClickable}` : ''}`}
      onClick={onRowClick}
      role={onRowClick ? 'button' : undefined}
      tabIndex={onRowClick ? 0 : undefined}
      onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(); } } : undefined}
    >
      <div className={css.entryInfo}>
        <div className={css.entryHeader}>
          <span className={css.entryName}>{entry.name}</span>
          <span className={css.entryVersion}>v{entry.version}</span>
          {typeLabel && (
            <span className={`${badgeCss.typeBadge} ${typeClass}`}>{typeLabel}</span>
          )}
          {entry.deprecated && <span className={css.deprecatedBadge}>deprecated</span>}
          {onRowClick && (
            <svg
              className={`${css.entryExpandChevron}${expanded ? ` ${css.entryExpandChevronOpen}` : ''}`}
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
            >
              <path d="M2.5 3.5L5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
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
      <div
        className={css.entryAction}
        onClick={(e) => e.stopPropagation()}
      >
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
