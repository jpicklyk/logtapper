import React, { useMemo, useCallback } from 'react';
import type { MarketplaceState } from '../../hooks';
import type { PackUpdateAvailable } from '../../bridge/types';
import css from './MarketplacePanel.module.css';

interface Props {
  marketplace: MarketplaceState;
}

export const UpdatesTab = React.memo(function UpdatesTab({ marketplace }: Props) {
  const { pendingUpdates, pendingPackUpdates, updatesLoading, updateResults, checkUpdates, updateOne, updateAllFromSource, updatePack } = marketplace;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof pendingUpdates>();
    for (const u of pendingUpdates) {
      const group = map.get(u.sourceName) ?? [];
      group.push(u);
      map.set(u.sourceName, group);
    }
    return map;
  }, [pendingUpdates]);

  const groupedPackUpdates = useMemo(() => {
    const map = new Map<string, typeof pendingPackUpdates>();
    for (const u of pendingPackUpdates) {
      const group = map.get(u.sourceName) ?? [];
      group.push(u);
      map.set(u.sourceName, group);
    }
    return map;
  }, [pendingPackUpdates]);

  const [updating, setUpdating] = React.useState<Set<string>>(new Set());
  const [updatingPacks, setUpdatingPacks] = React.useState<Set<string>>(new Set());

  const handleUpdateOne = useCallback(
    async (processorId: string) => {
      setUpdating((prev) => new Set(prev).add(processorId));
      try {
        await updateOne(processorId);
      } finally {
        setUpdating((prev) => {
          const next = new Set(prev);
          next.delete(processorId);
          return next;
        });
      }
    },
    [updateOne],
  );

  const handleUpdateAll = useCallback(
    async (sourceName: string) => {
      const ids = grouped.get(sourceName)?.map((u) => u.processorId) ?? [];
      setUpdating((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
      try {
        await updateAllFromSource(sourceName);
      } finally {
        setUpdating((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [grouped, updateAllFromSource],
  );

  const handleUpdatePack = useCallback(
    async (update: PackUpdateAvailable) => {
      setUpdatingPacks((prev) => new Set(prev).add(update.packId));
      try {
        await updatePack(update.sourceName, update.entry);
      } finally {
        setUpdatingPacks((prev) => {
          const next = new Set(prev);
          next.delete(update.packId);
          return next;
        });
      }
    },
    [updatePack],
  );

  return (
    <>
      <div className={css.toolbar}>
        <span className={css.updateSummary}>
          {(() => {
            const totalUpdates = pendingUpdates.length + pendingPackUpdates.length;
            return totalUpdates === 0
              ? 'All processors up to date'
              : `${totalUpdates} update${totalUpdates !== 1 ? 's' : ''} available`;
          })()}
        </span>
        <button
          className={`${css.fetchBtn}${updatesLoading ? ` ${css.fetchBtnLoading}` : ''}`}
          onClick={checkUpdates}
          disabled={updatesLoading}
        >
          {updatesLoading ? (
            <><span className={css.spinner} /> Checking...</>
          ) : (
            'Check for updates'
          )}
        </button>
      </div>

      <div className={css.scroll}>
        {pendingUpdates.length === 0 && pendingPackUpdates.length === 0 && !updatesLoading && (
          <div className={css.empty}>
            No pending updates. Click <strong>Check for updates</strong> to scan all sources.
          </div>
        )}

        {pendingPackUpdates.length > 0 && (
          Array.from(groupedPackUpdates.entries()).map(([sourceName, packs]) => (
            <div key={`packs-${sourceName}`} className={css.updateGroup}>
              <div className={css.updateGroupHeader}>
                <span>{sourceName} — Packs</span>
              </div>
              {packs.map((u) => {
                const isUpdating = updatingPacks.has(u.packId);
                return (
                  <div key={u.packId} className={css.updateRow}>
                    <div className={css.updateInfo}>
                      <span className={css.entryName}>{u.packName}</span>
                      <span className={css.versionDiff}>
                        <span className={css.oldVersion}>{u.installedVersion}</span>
                        <span className={css.arrow}>&rarr;</span>
                        <span className={css.newVersion}>{u.availableVersion}</span>
                      </span>
                      {u.newProcessorIds.length > 0 && (
                        <span className={css.entryDesc}>
                          {u.newProcessorIds.length} new processor{u.newProcessorIds.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className={css.updateAction}>
                      <button
                        className={css.actionBtnSmall}
                        onClick={() => handleUpdatePack(u)}
                        disabled={isUpdating}
                      >
                        {isUpdating ? <span className={css.spinner} /> : 'Update Pack'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}

        {Array.from(grouped.entries()).map(([sourceName, updates]) => (
          <div key={sourceName} className={css.updateGroup}>
            <div className={css.updateGroupHeader}>
              <span>{sourceName}</span>
              <button
                className={css.actionBtnSmall}
                onClick={() => handleUpdateAll(sourceName)}
                disabled={updates.every((u) => updating.has(u.processorId))}
              >
                Update all ({updates.length})
              </button>
            </div>
            {updates.map((u) => {
              const result = updateResults.get(u.processorId);
              const isUpdating = updating.has(u.processorId);
              return (
                <div key={u.processorId} className={css.updateRow}>
                  <div className={css.updateInfo}>
                    <span className={css.entryName}>{u.processorName}</span>
                    <span className={css.versionDiff}>
                      <span className={css.oldVersion}>{u.installedVersion}</span>
                      <span className={css.arrow}>&rarr;</span>
                      <span className={css.newVersion}>{u.availableVersion}</span>
                    </span>
                  </div>
                  <div className={css.updateAction}>
                    {result?.success ? (
                      <span className={css.successLabel}>Updated</span>
                    ) : result?.error ? (
                      <span className={css.errorText} title={result.error}>Failed</span>
                    ) : (
                      <button
                        className={css.actionBtnSmall}
                        onClick={() => handleUpdateOne(u.processorId)}
                        disabled={isUpdating}
                      >
                        {isUpdating ? <span className={css.spinner} /> : 'Update'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
});
