import { useCallback, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import type { PipelineState } from '../hooks/usePipeline';
import type { ProcessorSummary, RegistryEntry } from '../bridge/types';
import { fetchRegistry, installFromRegistry, loadProcessorFromFile } from '../bridge/commands';

type Tab = 'installed' | 'discover' | 'yaml';
type GroupBy = 'tag' | 'type';
type InstallStatus = 'idle' | 'installing' | 'installed' | 'error';

const PROC_TYPE_LABELS: Record<string, string> = {
  transformer:   'Transformer',
  reporter:      'Reporter',
  state_tracker: 'StateTracker',
  correlator:    'Correlator',
  annotator:     'Annotator',
};

const PROC_TYPE_BADGE_CLASS: Record<string, string> = {
  transformer:   'proc-type-transformer',
  reporter:      'proc-type-reporter',
  state_tracker: 'proc-type-tracker',
  correlator:    'proc-type-correlator',
  annotator:     'proc-type-annotator',
};

interface Props {
  pipeline: PipelineState;
  onClose: () => void;
}

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

export default function ProcessorLibrary({ pipeline, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('installed');
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('tag');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Discover tab state
  const [registryEntries, setRegistryEntries] = useState<RegistryEntry[]>([]);
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

  const chainSet = new Set(pipeline.pipelineChain);

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleAddSelected() {
    for (const id of selected) {
      pipeline.addToChain(id);
    }
    onClose();
  }

  // Clear selection when switching tabs
  function switchTab(t: Tab) {
    setTab(t);
    setSelected(new Set());
  }

  // ── Installed tab ──────────────────────────────────────────────────────────

  const q = query.toLowerCase();
  const filtered: ProcessorSummary[] = pipeline.processors.filter((p) => {
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const installedGroups: Map<string, ProcessorSummary[]> =
    groupBy === 'tag'
      ? groupByKey(filtered, (p) => p.tags[0] ?? 'Uncategorized')
      : groupByKey(filtered, (p) => PROC_TYPE_LABELS[p.processorType] ?? p.processorType);

  // Selectable = not already in chain
  const selectableFiltered = filtered.filter((p) => !chainSet.has(p.id));

  function handleSelectAll() {
    const allIds = selectableFiltered.map((p) => p.id);
    const allSelected = allIds.every((id) => selected.has(id));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  }

  // ── Discover tab ───────────────────────────────────────────────────────────

  const handleFetchRegistry = useCallback(async () => {
    setDiscoverLoading(true);
    setDiscoverError(null);
    try {
      const results = await fetchRegistry();
      setRegistryEntries(results);
    } catch (e) {
      setDiscoverError(String(e));
    } finally {
      setDiscoverLoading(false);
    }
  }, []);

  const handleInstallRegistry = useCallback(async (entry: RegistryEntry) => {
    setInstallStatus((s) => ({ ...s, [entry.id]: 'installing' }));
    setInstallError((e) => { const next = { ...e }; delete next[entry.id]; return next; });
    try {
      await installFromRegistry(entry);
      await pipeline.loadProcessors();
      setInstallStatus((s) => ({ ...s, [entry.id]: 'installed' }));
      pipeline.addToChain(entry.id);
    } catch (e) {
      setInstallStatus((s) => ({ ...s, [entry.id]: 'error' }));
      setInstallError((err) => ({ ...err, [entry.id]: String(e) }));
    }
  }, [pipeline]);

  const discoverFiltered = registryEntries.filter((e) => {
    if (!discoverFilter) return true;
    const dq = discoverFilter.toLowerCase();
    return (
      e.name.toLowerCase().includes(dq) ||
      (e.description ?? '').toLowerCase().includes(dq) ||
      e.tags.some((t) => t.toLowerCase().includes(dq))
    );
  });

  const installedRegistryIds = new Set(pipeline.processors.map((p) => p.id));

  // ── YAML tab ───────────────────────────────────────────────────────────────

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setYamlInput(text);
    e.target.value = '';
  }, []);

  const handleLoadFromFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Processor YAML', extensions: ['yaml', 'yml'] }],
    });
    if (typeof selected !== 'string') return;
    setYamlError(null);
    try {
      const summary = await loadProcessorFromFile(selected);
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
      className="modal-backdrop"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="proc-library-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hasSelection) { e.preventDefault(); handleAddSelected(); }
        }}
      >
        {/* ── Header ── */}
        <div className="proc-library-header">
          <div className="proc-library-header-left">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="proc-library-header-icon">
              <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
            <span className="proc-library-title">Add to Pipeline</span>
          </div>
          <button className="proc-library-close" onClick={onClose} title="Close (Esc)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* ── Tab bar ── */}
        <div className="proc-library-tabs">
          {(['installed', 'discover', 'yaml'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`proc-library-tab${tab === t ? ' proc-library-tab--active' : ''}`}
              onClick={() => switchTab(t)}
            >
              {t === 'installed' ? 'Installed' : t === 'discover' ? 'Discover' : 'Custom YAML'}
              {t === 'installed' && pipeline.processors.length > 0 && (
                <span className="proc-library-tab-count">{pipeline.processors.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div className="proc-library-body">

          {/* ─── Installed ─── */}
          {tab === 'installed' && (
            <>
              {/* Search + controls */}
              <div className="proc-library-toolbar">
                <div className="proc-library-search-wrap">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="proc-library-search-icon">
                    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                  <input
                    className="proc-library-search"
                    type="text"
                    placeholder="Search…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                  {query && (
                    <button className="proc-library-search-clear" onClick={() => setQuery('')}>×</button>
                  )}
                </div>
                <select
                  className="proc-library-groupby"
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                >
                  <option value="tag">By tag</option>
                  <option value="type">By type</option>
                </select>
                {selectableFiltered.length > 0 && (
                  <button
                    className="proc-library-select-all"
                    onClick={handleSelectAll}
                    title={allSelectableSelected ? 'Deselect all' : 'Select all'}
                  >
                    {allSelectableSelected ? 'None' : 'All'}
                  </button>
                )}
              </div>

              {/* List */}
              <div className="proc-library-scroll">
                {filtered.length === 0 ? (
                  <div className="proc-library-empty">
                    {pipeline.processors.length === 0
                      ? <>No processors installed.<br/>Use <strong>Discover</strong> or <strong>Custom YAML</strong> to add some.</>
                      : 'No processors match your search.'}
                  </div>
                ) : (
                  Array.from(installedGroups.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([group, procs]) => (
                      <div key={group} className="proc-library-group">
                        <div className="proc-library-group-header">
                          <span>{group}</span>
                          <span className="proc-library-group-count">{procs.length}</span>
                        </div>
                        {procs.map((p) => {
                          const inChain = chainSet.has(p.id);
                          const isSelected = selected.has(p.id);
                          return (
                            <button
                              key={p.id}
                              className={`proc-library-item${isSelected ? ' proc-library-item--selected' : ''}${inChain ? ' proc-library-item--in-chain' : ''}`}
                              onClick={() => !inChain && toggleSelect(p.id)}
                              disabled={inChain}
                            >
                              {/* Checkbox */}
                              <span className={`proc-lib-checkbox${isSelected ? ' proc-lib-checkbox--checked' : ''}${inChain ? ' proc-lib-checkbox--chain' : ''}`}>
                                {inChain
                                  ? <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  : isSelected
                                    ? <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                    : null
                                }
                              </span>

                              {/* Info */}
                              <span className="proc-lib-item-info">
                                <span className="proc-lib-item-name">{p.name}</span>
                                <span className="proc-lib-item-sub">
                                  <span className={`proc-type-badge ${PROC_TYPE_BADGE_CLASS[p.processorType] ?? ''}`}>
                                    {PROC_TYPE_LABELS[p.processorType] ?? p.processorType}
                                  </span>
                                  {p.description && (
                                    <span className="proc-lib-item-desc">{p.description}</span>
                                  )}
                                </span>
                              </span>

                              {/* Right status */}
                              <span className="proc-lib-item-status">
                                {inChain
                                  ? <span className="proc-lib-in-chain-label">in pipeline</span>
                                  : null
                                }
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

          {/* ─── Discover ─── */}
          {tab === 'discover' && (
            <>
              <div className="proc-library-toolbar">
                <div className="proc-library-search-wrap">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="proc-library-search-icon">
                    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                  <input
                    className="proc-library-search"
                    type="text"
                    placeholder="Filter…"
                    value={discoverFilter}
                    onChange={(e) => setDiscoverFilter(e.target.value)}
                    disabled={registryEntries.length === 0}
                  />
                </div>
                <button
                  className={`proc-library-fetch-btn${discoverLoading ? ' proc-library-fetch-btn--loading' : ''}`}
                  onClick={handleFetchRegistry}
                  disabled={discoverLoading}
                >
                  {discoverLoading
                    ? <><span className="proc-run-spinner" /> Fetching…</>
                    : registryEntries.length > 0 ? 'Refresh' : 'Fetch from GitHub'
                  }
                </button>
              </div>

              {discoverError && <div className="proc-library-error-bar">{discoverError}</div>}

              <div className="proc-library-scroll">
                {registryEntries.length === 0 && !discoverLoading && !discoverError && (
                  <div className="proc-library-empty">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3, marginBottom: 8 }}>
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="currentColor"/>
                      <path d="M11 7h2v6h-2zm0 8h2v2h-2z" fill="currentColor"/>
                    </svg>
                    Click <strong>Fetch from GitHub</strong> to browse the processor registry.
                  </div>
                )}
                {discoverFiltered.map((entry) => {
                  const status = installStatus[entry.id] ?? 'idle';
                  const alreadyInstalled = installedRegistryIds.has(entry.id);
                  const inChain = chainSet.has(entry.id);
                  return (
                    <div key={entry.id} className="proc-library-discover-item">
                      <div className="proc-lib-item-info" style={{ flex: 1 }}>
                        <span className="proc-lib-item-name">{entry.name}</span>
                        <span className="proc-lib-item-sub">
                          <span className="proc-library-item-version">v{entry.version}</span>
                          {entry.description && (
                            <span className="proc-lib-item-desc">{entry.description}</span>
                          )}
                        </span>
                        {entry.tags.length > 0 && (
                          <div className="proc-lib-tags">
                            {entry.tags.map((t) => <span key={t} className="proc-tag">{t}</span>)}
                          </div>
                        )}
                        {installError[entry.id] && (
                          <div className="proc-library-error-bar" style={{ marginTop: 4 }}>{installError[entry.id]}</div>
                        )}
                      </div>
                      <div className="proc-lib-discover-action">
                        {alreadyInstalled || status === 'installed' ? (
                          inChain ? (
                            <span className="proc-lib-in-chain-label">in pipeline</span>
                          ) : (
                            <button
                              className="btn-primary proc-lib-action-btn"
                              onClick={() => { pipeline.addToChain(entry.id); onClose(); }}
                            >
                              + Add
                            </button>
                          )
                        ) : (
                          <button
                            className="btn-primary proc-lib-action-btn"
                            onClick={() => handleInstallRegistry(entry)}
                            disabled={status === 'installing'}
                          >
                            {status === 'installing'
                              ? <><span className="proc-run-spinner" /> Installing…</>
                              : 'Install + Add'
                            }
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ─── Custom YAML ─── */}
          {tab === 'yaml' && (
            <div className="proc-library-yaml">
              <div className="proc-library-yaml-actions">
                <button className="btn-secondary proc-lib-action-btn" onClick={() => fileInputRef.current?.click()}>
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1v8M3.5 4.5L7 1l3.5 3.5M2 11h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Upload .yaml
                </button>
                <button className="btn-secondary proc-lib-action-btn" onClick={handleLoadFromFile}>
                  Load from disk…
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".yaml,.yml"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </div>
              <div className="proc-library-yaml-label">Paste YAML</div>
              <textarea
                className="proc-yaml-input"
                placeholder={'type: reporter\nid: my_processor\nname: My Processor\n…'}
                value={yamlInput}
                onChange={(e) => setYamlInput(e.target.value)}
                rows={11}
                spellCheck={false}
                autoFocus
              />
              {yamlError && <div className="proc-library-error-bar" style={{ marginTop: 6 }}>{yamlError}</div>}
              <div className="proc-library-yaml-footer">
                <button
                  className="btn-primary"
                  onClick={handleYamlInstall}
                  disabled={!yamlInput.trim() || yamlInstalling}
                >
                  {yamlInstalling ? <><span className="proc-run-spinner" /> Installing…</> : 'Install'}
                </button>
                <button className="btn-secondary" onClick={() => { setYamlInput(''); setYamlError(null); }}>
                  Clear
                </button>
                <span className="proc-library-yaml-hint">
                  After install, switch to the Installed tab to add to pipeline
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer (multi-select action bar) ── */}
        {tab === 'installed' && (
          <div className={`proc-library-footer${hasSelection ? ' proc-library-footer--active' : ''}`}>
            {hasSelection ? (
              <>
                <span className="proc-library-footer-count">
                  <span className="proc-library-footer-num">{selected.size}</span>
                  {' '}processor{selected.size !== 1 ? 's' : ''} selected
                </span>
                <div className="proc-library-footer-actions">
                  <button
                    className="btn-secondary proc-lib-action-btn"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </button>
                  <button
                    className="proc-library-add-btn"
                    onClick={handleAddSelected}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path d="M3 1.5l7 4.5-7 4.5V1.5z" fill="currentColor"/>
                    </svg>
                    Add {selected.size} to Pipeline
                  </button>
                </div>
              </>
            ) : (
              <span className="proc-library-footer-hint">
                Click processors to select · Enter to add
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return ReactDOM.createPortal(modal, document.body);
}
