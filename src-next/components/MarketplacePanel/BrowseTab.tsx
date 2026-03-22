import React, { useState, useMemo, useCallback, useEffect } from 'react';
import type { MarketplaceEntry, MarketplacePackEntry } from '../../bridge/types';
import { makeQualifiedId, filterMarketplaceEntries } from '../../bridge/types';
import type { MarketplaceState } from '../../hooks/useMarketplace';
import { listPacks } from '../../bridge/commands';
import type { PackSummary } from '../../bridge/types';
import { usePipeline } from '../../hooks';
import { useProcessors } from '../../context';
import { MarketplaceEntryRow } from './MarketplaceEntryRow';
import { ProcessorDetailCard } from '../ProcessorDetailCard';
import css from './MarketplacePanel.module.css';

type InstallStatus = 'idle' | 'installing' | 'installed' | 'error';
type UninstallStatus = 'idle' | 'uninstalling' | 'error';

interface Props {
  marketplace: MarketplaceState;
}

export const BrowseTab = React.memo(function BrowseTab({ marketplace }: Props) {
  const {
    sources,
    selectedSource,
    selectSource,
    entries,
    packEntries,
    entriesLoading,
    entriesError,
    fetchEntries,
    installEntry,
    uninstallEntry,
    installPack,
    uninstallPack,
  } = marketplace;

  const pipeline = usePipeline();
  const processors = useProcessors();
  const [filter, setFilter] = useState('');
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedPackProcessors, setExpandedPackProcessors] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<Record<string, InstallStatus>>({});
  const [installError, setInstallError] = useState<Record<string, string>>({});
  const [uninstallStatus, setUninstallStatus] = useState<Record<string, UninstallStatus>>({});
  const [installedPacks, setInstalledPacks] = useState<PackSummary[]>([]);

  const enabledSources = useMemo(() => sources.filter((s) => s.enabled), [sources]);
  const installedIds = useMemo(() => new Set(processors.map((p) => p.id)), [processors]);
  const installedPackIds = useMemo(() => new Set(installedPacks.map((p) => p.id)), [installedPacks]);

  // Fetch installed packs on mount and after install/uninstall
  useEffect(() => {
    listPacks().then(setInstalledPacks).catch(() => setInstalledPacks([]));
  }, [processors]); // re-check when processor list changes

  // All unique tags from current entries + packs for chip filters
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const entry of entries) {
      for (const t of entry.tags) tagSet.add(t);
    }
    for (const pack of packEntries) {
      for (const t of pack.tags) tagSet.add(t);
    }
    return Array.from(tagSet).sort();
  }, [entries, packEntries]);

  // Auto-select first source and fetch
  useEffect(() => {
    if (!selectedSource && enabledSources.length > 0) {
      const first = enabledSources[0].name;
      selectSource(first);
      fetchEntries(first);
    }
  }, [enabledSources, selectedSource, selectSource, fetchEntries]);

  // Reset tag filters when entries change (source switch)
  useEffect(() => {
    setActiveTagFilters(new Set());
  }, [entries]);

  const handleSourceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const name = e.target.value;
      selectSource(name);
      fetchEntries(name);
      setFilter('');
    },
    [selectSource, fetchEntries],
  );

  const toggleTagFilter = useCallback((tag: string) => {
    setActiveTagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const clearTagFilters = useCallback(() => {
    setActiveTagFilters(new Set());
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleInstall = useCallback(
    async (entry: MarketplaceEntry) => {
      if (!selectedSource) return;
      setInstallStatus((s) => ({ ...s, [entry.id]: 'installing' }));
      setInstallError((e) => { const n = { ...e }; delete n[entry.id]; return n; });
      try {
        await installEntry(selectedSource, entry);
        await pipeline.loadProcessors();
        setInstallStatus((s) => ({ ...s, [entry.id]: 'installed' }));
      } catch (e) {
        setInstallStatus((s) => ({ ...s, [entry.id]: 'error' }));
        setInstallError((err) => ({ ...err, [entry.id]: String(e) }));
      }
    },
    [selectedSource, installEntry, pipeline],
  );

  const handleUninstall = useCallback(
    async (entry: MarketplaceEntry, processorId: string) => {
      setUninstallStatus((s) => ({ ...s, [entry.id]: 'uninstalling' }));
      try {
        await uninstallEntry(processorId);
        await pipeline.loadProcessors();
        // Clear installed status so Install button reappears
        setInstallStatus((s) => { const n = { ...s }; delete n[entry.id]; return n; });
        setUninstallStatus((s) => ({ ...s, [entry.id]: 'idle' }));
      } catch {
        setUninstallStatus((s) => ({ ...s, [entry.id]: 'error' }));
      }
    },
    [uninstallEntry, pipeline],
  );

  const handleInstallPack = useCallback(
    async (packEntry: MarketplacePackEntry) => {
      if (!selectedSource) return;
      setInstallStatus((s) => ({ ...s, [packEntry.id]: 'installing' }));
      setInstallError((e) => { const n = { ...e }; delete n[packEntry.id]; return n; });
      try {
        await installPack(selectedSource, packEntry);
        await pipeline.loadProcessors();
        setInstallStatus((s) => ({ ...s, [packEntry.id]: 'installed' }));
      } catch (e) {
        setInstallStatus((s) => ({ ...s, [packEntry.id]: 'error' }));
        setInstallError((err) => ({ ...err, [packEntry.id]: String(e) }));
      }
    },
    [selectedSource, installPack, pipeline],
  );

  const handleUninstallPack = useCallback(
    async (packId: string) => {
      if (!selectedSource) return;
      setUninstallStatus((s) => ({ ...s, [packId]: 'uninstalling' }));
      try {
        await uninstallPack(selectedSource, packId);
        await pipeline.loadProcessors();
        setInstallStatus((s) => { const n = { ...s }; delete n[packId]; return n; });
        setUninstallStatus((s) => ({ ...s, [packId]: 'idle' }));
      } catch {
        setUninstallStatus((s) => ({ ...s, [packId]: 'error' }));
      }
    },
    [selectedSource, uninstallPack, pipeline],
  );

  const togglePackProcessors = useCallback((packId: string) => {
    setExpandedPackProcessors((prev) => (prev === packId ? null : packId));
  }, []);

  const textFiltered = useMemo(() => filterMarketplaceEntries(entries, filter), [entries, filter]);

  const filtered = useMemo(() => {
    if (activeTagFilters.size === 0) return textFiltered;
    return textFiltered.filter((e) => {
      for (const tag of activeTagFilters) {
        if (!e.tags.includes(tag)) return false;
      }
      return true;
    });
  }, [textFiltered, activeTagFilters]);

  // Filter packs by text search and tag filters
  const filteredPacks = useMemo(() => {
    let result = packEntries;
    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (activeTagFilters.size > 0) {
      result = result.filter((p) => {
        for (const tag of activeTagFilters) {
          if (!p.tags.includes(tag)) return false;
        }
        return true;
      });
    }
    return result;
  }, [packEntries, filter, activeTagFilters]);

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

      {allTags.length > 0 && (
        <div className={css.tagFilterBar}>
          {activeTagFilters.size > 0 && (
            <button className={css.tagFilterClear} onClick={clearTagFilters}>
              Clear
            </button>
          )}
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`${css.tagChip}${activeTagFilters.has(tag) ? ` ${css.tagChipActive}` : ''}`}
              onClick={() => toggleTagFilter(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {entriesError && <div className={css.errorBar}>{entriesError}</div>}

      <div className={css.scroll}>
        {entries.length === 0 && packEntries.length === 0 && !entriesLoading && !entriesError && (
          <div className={css.empty}>
            {enabledSources.length === 0
              ? 'No sources configured. Add a source in the Sources tab.'
              : 'Select a source and click Fetch to browse available processors.'}
          </div>
        )}

        {/* Pack entries */}
        {filteredPacks.map((pack) => {
          const isPackInstalled = installedPackIds.has(pack.id) || installStatus[pack.id] === 'installed';
          const showProcessors = expandedPackProcessors === pack.id;
          return (
            <div key={`pack-${pack.id}`} className={css.packEntry}>
              <div
                className={css.packHeader}
                onClick={() => togglePackProcessors(pack.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePackProcessors(pack.id); } }}
              >
                <svg
                  className={`${css.packChevron}${showProcessors ? ` ${css.packChevronOpen}` : ''}`}
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                >
                  <path d="M3.5 2L7 5l-3.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className={css.packBadge}>Pack</span>
                <span className={css.packName}>{pack.name}</span>
                <span className={css.packCount}>{pack.processorIds.length} processors</span>
                {pack.category && <span className={css.packCategory}>{pack.category}</span>}
              </div>
              {pack.description && (
                <div className={css.packDesc}>{pack.description}</div>
              )}
              {pack.tags.length > 0 && (
                <div className={css.tags}>
                  {pack.tags.map((t) => <span key={t} className={css.tag}>{t}</span>)}
                </div>
              )}
              {installError[pack.id] && (
                <div className={css.errorBar} style={{ marginTop: 4 }}>{installError[pack.id]}</div>
              )}
              <div className={css.packActions} onClick={(e) => e.stopPropagation()}>
                {isPackInstalled ? (
                  <button
                    className={css.actionBtnSecondary}
                    onClick={() => handleUninstallPack(pack.id)}
                    disabled={uninstallStatus[pack.id] === 'uninstalling'}
                  >
                    {uninstallStatus[pack.id] === 'uninstalling' ? (
                      <><span className={css.spinner} /> Removing...</>
                    ) : 'Uninstall Pack'}
                  </button>
                ) : (
                  <button
                    className={css.actionBtn}
                    onClick={() => handleInstallPack(pack)}
                    disabled={installStatus[pack.id] === 'installing'}
                  >
                    {installStatus[pack.id] === 'installing' ? (
                      <><span className={css.spinner} /> Installing...</>
                    ) : 'Install Pack'}
                  </button>
                )}
              </div>
              {showProcessors && (
                <div className={css.packProcessorList}>
                  {pack.processorIds.map((pid) => {
                    const matchingEntry = entries.find((e) => e.id === pid);
                    return (
                      <div key={pid} className={css.packProcessorItem}>
                        <span className={css.packProcessorName}>{matchingEntry?.name ?? pid}</span>
                        {matchingEntry?.processorType && (
                          <span className={css.packProcessorType}>{matchingEntry.processorType}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {filteredPacks.length > 0 && filtered.length > 0 && (
          <div className={css.sectionDivider}>Individual Processors</div>
        )}

        {filtered.map((entry) => {
          // Check if any installed processor matches this entry (bare or qualified id)
          const qualifiedId = selectedSource ? makeQualifiedId(entry.id, selectedSource) : entry.id;
          const isInstalled = installedIds.has(entry.id) || installedIds.has(qualifiedId)
            || installStatus[entry.id] === 'installed';
          // Resolve which processorId to uninstall (prefer qualified)
          const installedProcId = installedIds.has(qualifiedId) ? qualifiedId : entry.id;
          const isExpanded = expandedId === entry.id;
          // Build a partial ProcessorSummary-compatible shape for ProcessorDetailCard
          const detailProxy = {
            id: entry.id,
            name: entry.name,
            version: entry.version,
            description: entry.description ?? '',
            tags: entry.tags,
            builtin: false,
            processorType: (entry.processorType ?? 'reporter') as 'reporter' | 'state_tracker' | 'correlator' | 'transformer' | 'annotator',
            group: null,
            varsMeta: [],
            license: entry.license,
            category: entry.category,
            deprecated: entry.deprecated,
            hasSchema: false,
            source: selectedSource ?? undefined,
          };
          return (
            <React.Fragment key={entry.id}>
              <MarketplaceEntryRow
                entry={entry}
                installed={isInstalled}
                installStatus={installStatus[entry.id]}
                uninstallStatus={uninstallStatus[entry.id]}
                installError={installError[entry.id]}
                onInstall={() => handleInstall(entry)}
                onUninstall={isInstalled ? () => handleUninstall(entry, installedProcId) : undefined}
                onRowClick={() => toggleExpand(entry.id)}
                expanded={isExpanded}
              />
              {isExpanded && (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                <ProcessorDetailCard processor={detailProxy as any} />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
});
