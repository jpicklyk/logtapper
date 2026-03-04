import { memo, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import type { ProcessorSummary, Source, MarketplaceEntry } from '../../bridge/types';
import {
  listSources,
  fetchMarketplace,
  installFromMarketplace,
  loadProcessorFromFile,
} from '../../bridge/commands';
import { usePipeline } from '../../hooks';
import { useProcessors, usePipelineChain } from '../../context';
import { bus } from '../../events/bus';
import css from './ProcessorLibrary.module.css';

type Tab = 'installed' | 'discover' | 'yaml';
type GroupBy = 'tag' | 'type';
type InstallStatus = 'idle' | 'installing' | 'installed' | 'error';

const PROC_TYPE_LABELS: Record<string, string> = {
  reporter: 'Reporter',
  state_tracker: 'StateTracker',
  correlator: 'Correlator',
  annotator: 'Annotator',
  transformer: 'PII', // reserved for built-in PII anonymizer only
};

const PROC_TYPE_BADGE_CLASS: Record<string, string> = {
  reporter: css.typeReporter,
  state_tracker: css.typeTracker,
  correlator: css.typeCorrelator,
  annotator: css.typeCorrelator,
  transformer: css.typeTransformer, // reserved for built-in PII anonymizer only
};

function groupByKey<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

interface Props {
  onClose: () => void;
}

const ProcessorLibrary = memo(function ProcessorLibrary({ onClose }: Props) {
  const pipeline = usePipeline();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();

  const [tab, setTab] = useState<Tab>('installed');
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('tag');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Discover tab state (marketplace multi-source)
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [marketplaceEntries, setMarketplaceEntries] = useState<MarketplaceEntry[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<Record<string, InstallStatus>>({});
  const [installError, setInstallError] = useState<Record<string, string>>({});
  const [discoverFilter, setDiscoverFilter] = useState('');

  // YAML tab state
  const [yamlInput, setYamlInput] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [yamlInstalling, setYamlInstalling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chainSet = useMemo(() => new Set(pipelineChain), [pipelineChain]);

  // ── Selection ──────────────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAddSelected = useCallback(() => {
    for (const id of selected) {
      pipeline.addToChain(id);
    }
    onClose();
  }, [selected, pipeline, onClose]);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setSelected(new Set());
  }, []);

  // ── Installed tab ──────────────────────────────────────────────────────────

  const q = query.toLowerCase();
  const filtered: ProcessorSummary[] = useMemo(
    () =>
      processors.filter((p) => {
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q))
        );
      }),
    [processors, q],
  );

  const installedGroups = useMemo(
    () =>
      groupBy === 'tag'
        ? groupByKey(filtered, (p) => p.tags[0] ?? 'Uncategorized')
        : groupByKey(filtered, (p) => PROC_TYPE_LABELS[p.processorType] ?? p.processorType),
    [filtered, groupBy],
  );

  const selectableFiltered = useMemo(
    () => filtered.filter((p) => !chainSet.has(p.id)),
    [filtered, chainSet],
  );

  const handleSelectAll = useCallback(() => {
    const allIds = selectableFiltered.map((p) => p.id);
    const allSelected = allIds.every((id) => selected.has(id));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  }, [selectableFiltered, selected]);

  // ── Discover tab (marketplace multi-source) ────────────────────────────────

  // Load sources on first switch to Discover
  const sourcesLoadedRef = useRef(false);
  useEffect(() => {
    if (tab === 'discover' && !sourcesLoadedRef.current) {
      sourcesLoadedRef.current = true;
      listSources().then((srcs) => {
        setSources(srcs);
        const enabled = srcs.filter((s) => s.enabled);
        if (enabled.length > 0 && !selectedSource) {
          setSelectedSource(enabled[0].name);
          handleFetchMarketplace(enabled[0].name);
        }
      }).catch(() => {});
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFetchMarketplace = useCallback(async (sourceName?: string) => {
    const src = sourceName || selectedSource;
    if (!src) return;
    setDiscoverLoading(true);
    setDiscoverError(null);
    try {
      const results = await fetchMarketplace(src);
      setMarketplaceEntries(results);
    } catch (e) {
      setDiscoverError(String(e));
    } finally {
      setDiscoverLoading(false);
    }
  }, [selectedSource]);

  const handleSourceChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value;
    setSelectedSource(name);
    setDiscoverFilter('');
    handleFetchMarketplace(name);
  }, [handleFetchMarketplace]);

  const handleInstallFromMarketplace = useCallback(
    async (entry: MarketplaceEntry) => {
      if (!selectedSource) return;
      setInstallStatus((s) => ({ ...s, [entry.id]: 'installing' }));
      setInstallError((e) => {
        const next = { ...e };
        delete next[entry.id];
        return next;
      });
      try {
        const summary = await installFromMarketplace(selectedSource, entry.id);
        await pipeline.loadProcessors();
        setInstallStatus((s) => ({ ...s, [entry.id]: 'installed' }));
        pipeline.addToChain(summary.id);
        bus.emit('marketplace:processor-installed', { processorId: summary.id, sourceName: selectedSource });
      } catch (e) {
        setInstallStatus((s) => ({ ...s, [entry.id]: 'error' }));
        setInstallError((err) => ({ ...err, [entry.id]: String(e) }));
      }
    },
    [pipeline, selectedSource],
  );

  const discoverFiltered = useMemo(
    () =>
      marketplaceEntries.filter((e) => {
        if (!discoverFilter) return true;
        const dq = discoverFilter.toLowerCase();
        return (
          e.name.toLowerCase().includes(dq) ||
          (e.description ?? '').toLowerCase().includes(dq) ||
          e.tags.some((t) => t.toLowerCase().includes(dq))
        );
      }),
    [marketplaceEntries, discoverFilter],
  );

  const installedIds = useMemo(
    () => new Set(processors.map((p) => p.id)),
    [processors],
  );

  const enabledSources = useMemo(() => sources.filter((s) => s.enabled), [sources]);

  // ── YAML tab ───────────────────────────────────────────────────────────────

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setYamlInput(text);
    e.target.value = '';
  }, []);

  const handleLoadFromFile = useCallback(async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: 'Processor YAML', extensions: ['yaml', 'yml'] }],
    });
    if (typeof sel !== 'string') return;
    setYamlError(null);
    try {
      const summary = await loadProcessorFromFile(sel);
      await pipeline.loadProcessors();
      pipeline.addToChain(summary.id);
      onClose();
    } catch (e) {
      setYamlError(String(e));
    }
  }, [pipeline, onClose]);

  const handleYamlInstall = useCallback(async () => {
    if (!yamlInput.trim()) return;
    setYamlError(null);
    setYamlInstalling(true);
    try {
      await pipeline.installFromYaml(yamlInput);
      setYamlInput('');
    } catch (e) {
      setYamlError(String(e));
    } finally {
      setYamlInstalling(false);
    }
  }, [pipeline, yamlInput]);

  // ── Footer ─────────────────────────────────────────────────────────────────

  const hasSelection = selected.size > 0;
  const allSelectableSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((p) => selected.has(p.id));

  // ── Render ─────────────────────────────────────────────────────────────────

  const modal = (
    <div
      className={css.backdrop}
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className={css.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hasSelection) {
            e.preventDefault();
            handleAddSelected();
          }
        }}
      >
        {/* Header */}
        <div className={css.header}>
          <div className={css.headerLeft}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              className={css.headerIcon}
            >
              <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            <span className={css.title}>Add to Pipeline</span>
          </div>
          <button className={css.closeBtn} onClick={onClose} title="Close (Esc)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Tab bar */}
        <div className={css.tabs}>
          {(['installed', 'discover', 'yaml'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`${css.tab}${tab === t ? ` ${css.tabActive}` : ''}`}
              onClick={() => switchTab(t)}
            >
              {t === 'installed' ? 'Installed' : t === 'discover' ? 'Discover' : 'Custom YAML'}
              {t === 'installed' && processors.length > 0 && (
                <span className={css.tabCount}>{processors.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className={css.body}>
          {/* Installed */}
          {tab === 'installed' && (
            <>
              <div className={css.toolbar}>
                <div className={css.searchWrap}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 14 14"
                    fill="none"
                    className={css.searchIcon}
                  >
                    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  <input
                    className={css.search}
                    type="text"
                    placeholder="Search..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                  {query && (
                    <button className={css.searchClear} onClick={() => setQuery('')}>
                      x
                    </button>
                  )}
                </div>
                <select
                  className={css.groupBy}
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                >
                  <option value="tag">By tag</option>
                  <option value="type">By type</option>
                </select>
                {selectableFiltered.length > 0 && (
                  <button
                    className={css.selectAll}
                    onClick={handleSelectAll}
                    title={allSelectableSelected ? 'Deselect all' : 'Select all'}
                  >
                    {allSelectableSelected ? 'None' : 'All'}
                  </button>
                )}
              </div>

              <div className={css.scroll}>
                {filtered.length === 0 ? (
                  <div className={css.empty}>
                    {processors.length === 0 ? (
                      <>
                        No processors installed.
                        <br />
                        Use <strong>Discover</strong> or <strong>Custom YAML</strong> to add some.
                      </>
                    ) : (
                      'No processors match your search.'
                    )}
                  </div>
                ) : (
                  Array.from(installedGroups.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([group, procs]) => (
                      <div key={group} className={css.group}>
                        <div className={css.groupHeader}>
                          <span>{group}</span>
                          <span className={css.groupCount}>{procs.length}</span>
                        </div>
                        {procs.map((p) => {
                          const inChain = chainSet.has(p.id);
                          const isSelected = selected.has(p.id);
                          return (
                            <button
                              key={p.id}
                              className={`${css.item}${isSelected ? ` ${css.itemSelected}` : ''}${inChain ? ` ${css.itemInChain}` : ''}`}
                              onClick={() => !inChain && toggleSelect(p.id)}
                              disabled={inChain}
                            >
                              <span
                                className={`${css.checkbox}${isSelected ? ` ${css.checkboxChecked}` : ''}${inChain ? ` ${css.checkboxChain}` : ''}`}
                              >
                                {(inChain || isSelected) && (
                                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                                    <path
                                      d="M2 5l2.5 2.5L8 3"
                                      stroke="currentColor"
                                      strokeWidth="1.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                )}
                              </span>
                              <span className={css.itemInfo}>
                                <span className={css.itemName}>{p.name}</span>
                                <span className={css.itemSub}>
                                  <span
                                    className={`${css.typeBadge} ${PROC_TYPE_BADGE_CLASS[p.processorType] ?? ''}`}
                                  >
                                    {PROC_TYPE_LABELS[p.processorType] ?? p.processorType}
                                  </span>
                                  {p.description && (
                                    <span className={css.itemDesc}>{p.description}</span>
                                  )}
                                </span>
                              </span>
                              <span className={css.itemStatus}>
                                {inChain && (
                                  <span className={css.inChainLabel}>in pipeline</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))
                )}
              </div>
            </>
          )}

          {/* Discover (Marketplace) */}
          {tab === 'discover' && (
            <>
              <div className={css.toolbar}>
                {enabledSources.length > 1 && (
                  <select
                    className={css.groupBy}
                    value={selectedSource}
                    onChange={handleSourceChange}
                  >
                    {enabledSources.map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                )}
                <div className={css.searchWrap}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 14 14"
                    fill="none"
                    className={css.searchIcon}
                  >
                    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  <input
                    className={css.search}
                    type="text"
                    placeholder="Filter..."
                    value={discoverFilter}
                    onChange={(e) => setDiscoverFilter(e.target.value)}
                    disabled={marketplaceEntries.length === 0}
                  />
                </div>
                <button
                  className={`${css.fetchBtn}${discoverLoading ? ` ${css.fetchBtnLoading}` : ''}`}
                  onClick={() => handleFetchMarketplace()}
                  disabled={discoverLoading || !selectedSource}
                >
                  {discoverLoading ? (
                    <>
                      <span className={css.spinner} /> Fetching...
                    </>
                  ) : marketplaceEntries.length > 0 ? (
                    'Refresh'
                  ) : (
                    'Fetch'
                  )}
                </button>
              </div>

              {discoverError && <div className={css.errorBar}>{discoverError}</div>}

              <div className={css.scroll}>
                {marketplaceEntries.length === 0 && !discoverLoading && !discoverError && (
                  <div className={css.empty}>
                    {enabledSources.length === 0
                      ? 'No sources configured. Open the Marketplace panel to add sources.'
                      : <>Select a source and click <strong>Fetch</strong> to browse available processors.</>}
                  </div>
                )}
                {discoverFiltered.map((entry) => {
                  const status = installStatus[entry.id] ?? 'idle';
                  const qualifiedId = selectedSource ? `${entry.id}@${selectedSource}` : entry.id;
                  const alreadyInstalled = installedIds.has(entry.id) || installedIds.has(qualifiedId);
                  const inChain = chainSet.has(entry.id) || chainSet.has(qualifiedId);
                  return (
                    <div key={entry.id} className={css.discoverItem}>
                      <div className={css.itemInfo} style={{ flex: 1 }}>
                        <span className={css.itemName}>{entry.name}</span>
                        <span className={css.itemSub}>
                          <span className={css.itemVersion}>v{entry.version}</span>
                          {entry.processorType && (
                            <span className={`${css.typeBadge} ${PROC_TYPE_BADGE_CLASS[entry.processorType] ?? ''}`}>
                              {PROC_TYPE_LABELS[entry.processorType] ?? entry.processorType}
                            </span>
                          )}
                          {entry.description && (
                            <span className={css.itemDesc}>{entry.description}</span>
                          )}
                        </span>
                        {entry.tags.length > 0 && (
                          <div className={css.tags}>
                            {entry.tags.map((t) => (
                              <span key={t} className={css.tag}>
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        {installError[entry.id] && (
                          <div className={css.errorBar} style={{ marginTop: 4 }}>
                            {installError[entry.id]}
                          </div>
                        )}
                      </div>
                      <div className={css.discoverAction}>
                        {alreadyInstalled || status === 'installed' ? (
                          inChain ? (
                            <span className={css.inChainLabel}>in pipeline</span>
                          ) : (
                            <button
                              className={css.actionBtn}
                              onClick={() => {
                                pipeline.addToChain(qualifiedId);
                                onClose();
                              }}
                            >
                              + Add
                            </button>
                          )
                        ) : (
                          <button
                            className={css.actionBtn}
                            onClick={() => handleInstallFromMarketplace(entry)}
                            disabled={status === 'installing'}
                          >
                            {status === 'installing' ? (
                              <>
                                <span className={css.spinner} /> Installing...
                              </>
                            ) : (
                              'Install + Add'
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Custom YAML */}
          {tab === 'yaml' && (
            <div className={css.yaml}>
              <div className={css.yamlActions}>
                <button
                  className={`${css.actionBtn} ${css.actionBtnSecondary}`}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M7 1v8M3.5 4.5L7 1l3.5 3.5M2 11h10"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Upload .yaml
                </button>
                <button
                  className={`${css.actionBtn} ${css.actionBtnSecondary}`}
                  onClick={handleLoadFromFile}
                >
                  Load from disk...
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".yaml,.yml"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </div>
              <div className={css.yamlLabel}>Paste YAML</div>
              <textarea
                className={css.yamlInput}
                placeholder={'type: reporter\nid: my_processor\nname: My Processor\n...'}
                value={yamlInput}
                onChange={(e) => setYamlInput(e.target.value)}
                rows={11}
                spellCheck={false}
                autoFocus
              />
              {yamlError && <div className={css.errorBar} style={{ marginTop: 6 }}>{yamlError}</div>}
              <div className={css.yamlFooter}>
                <button
                  className={css.actionBtn}
                  onClick={handleYamlInstall}
                  disabled={!yamlInput.trim() || yamlInstalling}
                >
                  {yamlInstalling ? (
                    <>
                      <span className={css.spinner} /> Installing...
                    </>
                  ) : (
                    'Install'
                  )}
                </button>
                <button
                  className={`${css.actionBtn} ${css.actionBtnSecondary}`}
                  onClick={() => {
                    setYamlInput('');
                    setYamlError(null);
                  }}
                >
                  Clear
                </button>
                <span className={css.yamlHint}>
                  After install, switch to the Installed tab to add to pipeline
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer (multi-select action bar) */}
        {tab === 'installed' && (
          <div className={`${css.footer}${hasSelection ? ` ${css.footerActive}` : ''}`}>
            {hasSelection ? (
              <>
                <span className={css.footerCount}>
                  <span className={css.footerNum}>{selected.size}</span>{' '}
                  processor{selected.size !== 1 ? 's' : ''} selected
                </span>
                <div className={css.footerActions}>
                  <button
                    className={`${css.actionBtn} ${css.actionBtnSecondary}`}
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </button>
                  <button className={css.addBtn} onClick={handleAddSelected}>
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path d="M3 1.5l7 4.5-7 4.5V1.5z" fill="currentColor" />
                    </svg>
                    Add {selected.size} to Pipeline
                  </button>
                </div>
              </>
            ) : (
              <span className={css.footerHint}>
                Click processors to select -- Enter to add
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return ReactDOM.createPortal(modal, document.body);
});

export default ProcessorLibrary;
