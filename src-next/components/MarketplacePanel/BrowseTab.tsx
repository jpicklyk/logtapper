import React, { useState, useMemo, useCallback, useEffect } from 'react';
import type { MarketplaceEntry } from '../../bridge/types';
import { makeQualifiedId, filterMarketplaceEntries } from '../../bridge/types';
import type { MarketplaceState } from '../../hooks/useMarketplace';
import { usePipeline } from '../../hooks';
import { useProcessors } from '../../context';
import { MarketplaceEntryRow } from './MarketplaceEntryRow';
import css from './MarketplacePanel.module.css';

type InstallStatus = 'idle' | 'installing' | 'installed' | 'error';

interface Props {
  marketplace: MarketplaceState;
}

export const BrowseTab = React.memo(function BrowseTab({ marketplace }: Props) {
  const {
    sources,
    selectedSource,
    selectSource,
    entries,
    entriesLoading,
    entriesError,
    fetchEntries,
    installEntry,
  } = marketplace;

  const pipeline = usePipeline();
  const processors = useProcessors();
  const [filter, setFilter] = useState('');
  const [installStatus, setInstallStatus] = useState<Record<string, InstallStatus>>({});
  const [installError, setInstallError] = useState<Record<string, string>>({});

  const enabledSources = useMemo(() => sources.filter((s) => s.enabled), [sources]);
  const installedIds = useMemo(() => new Set(processors.map((p) => p.id)), [processors]);

  // Auto-select first source and fetch
  useEffect(() => {
    if (!selectedSource && enabledSources.length > 0) {
      const first = enabledSources[0].name;
      selectSource(first);
      fetchEntries(first);
    }
  }, [enabledSources, selectedSource, selectSource, fetchEntries]);

  const handleSourceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const name = e.target.value;
      selectSource(name);
      fetchEntries(name);
      setFilter('');
    },
    [selectSource, fetchEntries],
  );

  const handleInstall = useCallback(
    async (entry: MarketplaceEntry) => {
      if (!selectedSource) return;
      setInstallStatus((s) => ({ ...s, [entry.id]: 'installing' }));
      setInstallError((e) => { const n = { ...e }; delete n[entry.id]; return n; });
      try {
        const summary = await installEntry(selectedSource, entry);
        await pipeline.loadProcessors();
        pipeline.addToChain(summary.id);
        setInstallStatus((s) => ({ ...s, [entry.id]: 'installed' }));
      } catch (e) {
        setInstallStatus((s) => ({ ...s, [entry.id]: 'error' }));
        setInstallError((err) => ({ ...err, [entry.id]: String(e) }));
      }
    },
    [selectedSource, installEntry, pipeline],
  );

  const filtered = useMemo(() => filterMarketplaceEntries(entries, filter), [entries, filter]);

  return (
    <>
      <div className={css.toolbar}>
        {enabledSources.length > 1 && (
          <select
            className={css.sourceSelect}
            value={selectedSource ?? ''}
            onChange={handleSourceChange}
          >
            {enabledSources.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
        )}
        <div className={css.searchWrap}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className={css.searchIcon}>
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            className={css.search}
            type="text"
            placeholder="Filter processors..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={entries.length === 0}
          />
          {filter && (
            <button className={css.searchClear} onClick={() => setFilter('')}>x</button>
          )}
        </div>
        <button
          className={`${css.fetchBtn}${entriesLoading ? ` ${css.fetchBtnLoading}` : ''}`}
          onClick={() => selectedSource && fetchEntries(selectedSource)}
          disabled={entriesLoading || !selectedSource}
        >
          {entriesLoading ? (
            <><span className={css.spinner} /> Loading...</>
          ) : entries.length > 0 ? (
            'Refresh'
          ) : (
            'Fetch'
          )}
        </button>
      </div>

      {entriesError && <div className={css.errorBar}>{entriesError}</div>}

      <div className={css.scroll}>
        {entries.length === 0 && !entriesLoading && !entriesError && (
          <div className={css.empty}>
            {enabledSources.length === 0
              ? 'No sources configured. Add a source in the Sources tab.'
              : 'Select a source and click Fetch to browse available processors.'}
          </div>
        )}
        {filtered.map((entry) => {
          // Check if any installed processor matches this entry (bare or qualified id)
          const qualifiedId = selectedSource ? makeQualifiedId(entry.id, selectedSource) : entry.id;
          const isInstalled = installedIds.has(entry.id) || installedIds.has(qualifiedId);
          return (
            <MarketplaceEntryRow
              key={entry.id}
              entry={entry}
              installed={isInstalled}
              installStatus={installStatus[entry.id]}
              installError={installError[entry.id]}
              onInstall={() => handleInstall(entry)}
            />
          );
        })}
      </div>
    </>
  );
});
