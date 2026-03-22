import { memo, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import type { ProcessorSummary, PackSummary } from '../../bridge/types';
import { matchesAllTags, getBareId } from '../../bridge/types';
import {
  loadProcessorFromFile,
  listPacks,
} from '../../bridge/commands';
import { usePipeline } from '../../hooks';
import { useProcessors, usePipelineChain } from '../../context';
import { ProcessorTypeIcon, PROC_TYPE_LABELS, PROC_TYPE_CLASS_KEY } from '../../ui';
import { ProcessorDetailCard } from '../ProcessorDetailCard';
import css from './ProcessorLibrary.module.css';
import badgeCss from '../../ui/processorBadge.module.css';

type Tab = 'installed' | 'yaml';

// transformer label is overridden to 'PII' here (built-in PII anonymizer only)
const LOCAL_LABEL_OVERRIDES: Record<string, string> = { transformer: 'PII' };

function getProcTypeLabel(type: string): string {
  return LOCAL_LABEL_OVERRIDES[type] ?? PROC_TYPE_LABELS[type] ?? type;
}

function getProcTypeBadgeClass(type: string): string {
  return badgeCss[PROC_TYPE_CLASS_KEY[type] as keyof typeof badgeCss] ?? '';
}

/** A selectable entry — either a pack or a standalone processor. */
type LibraryEntry =
  | { kind: 'pack'; pack: PackSummary; processors: ProcessorSummary[] }
  | { kind: 'standalone'; processor: ProcessorSummary };

interface Props {
  onClose: () => void;
}

const ProcessorLibrary = memo(function ProcessorLibrary({ onClose }: Props) {
  const pipeline = usePipeline();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();

  const [tab, setTab] = useState<Tab>('installed');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()); // pack IDs or standalone processor IDs
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [packs, setPacks] = useState<PackSummary[]>([]);

  // YAML tab state
  const [yamlInput, setYamlInput] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [yamlInstalling, setYamlInstalling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chainSet = useMemo(() => new Set(pipelineChain), [pipelineChain]);

  // Fetch packs on mount
  useEffect(() => {
    listPacks().then(setPacks).catch(() => setPacks([]));
  }, [processors]);

  // Build processor lookup by bare ID (packs reference bare IDs like "wifi-state",
  // but installed processors use qualified IDs like "wifi-state@official")
  const processorsByBareId = useMemo(() => {
    const map = new Map<string, ProcessorSummary>();
    for (const p of processors) {
      map.set(getBareId(p.id), p);
    }
    return map;
  }, [processors]);

  // Set of qualified IDs that belong to any pack (for filtering standalone processors)
  const packMemberQualifiedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pack of packs) {
      for (const bareId of pack.processorIds) {
        const proc = processorsByBareId.get(bareId);
        if (proc) ids.add(proc.id); // qualified ID
      }
    }
    return ids;
  }, [packs, processorsByBareId]);

  // ── Selection ──────────────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleAddSelected = useCallback(() => {
    for (const id of selected) {
      // Check if this is a pack ID
      const pack = packs.find((p) => p.id === id);
      if (pack) {
        // Resolve bare IDs to qualified IDs for the pipeline chain
        const qualifiedIds = pack.processorIds
          .map((bareId) => processorsByBareId.get(bareId)?.id)
          .filter(Boolean) as string[];
        pipeline.addPackToChain(qualifiedIds);
      } else {
        pipeline.addToChain(id);
      }
    }
    onClose();
  }, [selected, packs, processorsByBareId, pipeline, onClose]);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setSelected(new Set());
  }, []);

  // ── Installed tab ──────────────────────────────────────────────────────────

  const q = query.toLowerCase();

  // All unique tags across all processors + packs (for filter chips)
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const p of processors) {
      for (const t of p.tags) tagSet.add(t);
    }
    for (const pack of packs) {
      for (const t of pack.tags) tagSet.add(t);
    }
    return Array.from(tagSet).sort();
  }, [processors, packs]);

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

  // Build library entries: packs + standalone processors, filtered
  const libraryEntries: LibraryEntry[] = useMemo(() => {
    const entries: LibraryEntry[] = [];

    // Add packs (resolve bare processor IDs to installed processors)
    for (const pack of packs) {
      const packProcs = pack.processorIds
        .map((bareId) => processorsByBareId.get(bareId))
        .filter(Boolean) as ProcessorSummary[];

      // Text filter: match against pack name, description, tags, or any processor name
      if (q) {
        const matchesPack =
          pack.name.toLowerCase().includes(q) ||
          (pack.description ?? '').toLowerCase().includes(q) ||
          pack.tags.some((t) => t.toLowerCase().includes(q)) ||
          packProcs.some((p) => p.name.toLowerCase().includes(q));
        if (!matchesPack) continue;
      }
      // Tag filter
      if (activeTagFilters.size > 0 && !matchesAllTags(pack.tags, activeTagFilters)) continue;

      entries.push({ kind: 'pack', pack, processors: packProcs });
    }

    // Add standalone processors (not in any pack, not built-in PII)
    for (const p of processors) {
      if (packMemberQualifiedIds.has(p.id)) continue;
      if (p.id === '__pii_anonymizer') continue;

      if (q) {
        const matchesText =
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchesText) continue;
      }
      if (activeTagFilters.size > 0 && !matchesAllTags(p.tags, activeTagFilters)) continue;

      entries.push({ kind: 'standalone', processor: p });
    }

    return entries;
  }, [packs, processors, processorsByBareId, packMemberQualifiedIds, q, activeTagFilters]);

  // Check if a pack or standalone is already fully in the chain
  const isEntryInChain = useCallback((entry: LibraryEntry): boolean => {
    if (entry.kind === 'pack') {
      return entry.processors.length > 0 && entry.processors.every((p) => chainSet.has(p.id));
    }
    return chainSet.has(entry.processor.id);
  }, [chainSet]);

  const entryId = (entry: LibraryEntry) =>
    entry.kind === 'pack' ? entry.pack.id : entry.processor.id;

  const selectableEntries = useMemo(
    () => libraryEntries.filter((e) => !isEntryInChain(e)),
    [libraryEntries, isEntryInChain],
  );

  const handleSelectAll = useCallback(() => {
    const allIds = selectableEntries.map(entryId);
    const allSelected = allIds.every((id) => selected.has(id));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  }, [selectableEntries, selected]);

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
    selectableEntries.length > 0 &&
    selectableEntries.every((e) => selected.has(entryId(e)));

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
          {(['installed', 'yaml'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`${css.tab}${tab === t ? ` ${css.tabActive}` : ''}`}
              onClick={() => switchTab(t)}
            >
              {t === 'installed' ? 'Installed' : 'Custom YAML'}
              {t === 'installed' && libraryEntries.length > 0 && (
                <span className={css.tabCount}>{libraryEntries.length}</span>
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
                {selectableEntries.length > 0 && (
                  <button
                    className={css.selectAll}
                    onClick={handleSelectAll}
                    title={allSelectableSelected ? 'Deselect all' : 'Select all'}
                  >
                    {allSelectableSelected ? 'None' : 'All'}
                  </button>
                )}
              </div>

              {/* Tag filter chips */}
              {allTags.length > 0 && (
                <div className={css.filterChips}>
                  {activeTagFilters.size > 0 && (
                    <button className={css.filterChipClear} onClick={clearTagFilters}>
                      Clear
                    </button>
                  )}
                  {allTags.map((tag) => (
                    <button
                      key={tag}
                      className={`${css.filterChip}${activeTagFilters.has(tag) ? ` ${css.filterChipActive}` : ''}`}
                      onClick={() => toggleTagFilter(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}

              <div className={css.scroll}>
                {libraryEntries.length === 0 ? (
                  <div className={css.empty}>
                    {processors.length === 0 ? (
                      <>
                        No processors installed.
                        <br />
                        Install packs from the <strong>Marketplace</strong>, or use <strong>Custom YAML</strong>.
                      </>
                    ) : (
                      'No items match your search.'
                    )}
                  </div>
                ) : (
                  libraryEntries.map((entry) => {
                    const id = entryId(entry);
                    const inChain = isEntryInChain(entry);
                    const isSelected = selected.has(id);
                    const isExpanded = expandedId === id;

                    if (entry.kind === 'pack') {
                      const { pack, processors: packProcs } = entry;
                      const partialInChain = packProcs.some((p) => chainSet.has(p.id)) && !inChain;
                      return (
                        <div key={id} className={css.itemWrapper}>
                          <button
                            className={`${css.item}${isSelected ? ` ${css.itemSelected}` : ''}${inChain ? ` ${css.itemInChain}` : ''}`}
                            onClick={() => toggleExpand(id)}
                          >
                            <span
                              className={`${css.checkbox}${isSelected ? ` ${css.checkboxChecked}` : ''}${inChain ? ` ${css.checkboxChain}` : ''}`}
                              role="checkbox"
                              aria-checked={isSelected || inChain}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!inChain) toggleSelect(id);
                              }}
                            >
                              {(inChain || isSelected) && (
                                <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                                  <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </span>
                            <span className={css.itemInfo}>
                              <span className={css.itemSub}>
                                <span className={css.packBadge}>Pack</span>
                                <span className={css.itemName}>{pack.name}</span>
                                <span className={css.packCount}>{packProcs.length} processors</span>
                              </span>
                              {pack.description && (
                                <span className={css.itemDesc}>{pack.description}</span>
                              )}
                              {pack.tags.length > 0 && (
                                <span className={css.itemTags}>
                                  {pack.tags.map((t) => (
                                    <span key={t} className={css.itemTag}>{t}</span>
                                  ))}
                                </span>
                              )}
                            </span>
                            <span className={css.itemStatus}>
                              {inChain && <span className={css.inChainLabel}>in pipeline</span>}
                              {partialInChain && <span className={css.inChainLabel}>partial</span>}
                            </span>
                            <svg
                              className={`${css.expandChevron}${isExpanded ? ` ${css.expandChevronOpen}` : ''}`}
                              width="10" height="10" viewBox="0 0 10 10" fill="none"
                            >
                              <path d="M2.5 3.5L5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          {isExpanded && (
                            <div className={css.packProcessorList}>
                              {packProcs.map((p) => (
                                <div key={p.id} className={css.packProcessorItem}>
                                  <ProcessorTypeIcon type={p.processorType} size={12} />
                                  <span className={css.packProcessorName}>{p.name}</span>
                                  <span className={css.packProcessorType}>
                                    {getProcTypeLabel(p.processorType)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }

                    // Standalone processor
                    const p = entry.processor;
                    return (
                      <div key={id} className={css.itemWrapper}>
                        <button
                          className={`${css.item}${isSelected ? ` ${css.itemSelected}` : ''}${inChain ? ` ${css.itemInChain}` : ''}`}
                          onClick={() => toggleExpand(id)}
                        >
                          <span
                            className={`${css.checkbox}${isSelected ? ` ${css.checkboxChecked}` : ''}${inChain ? ` ${css.checkboxChain}` : ''}`}
                            role="checkbox"
                            aria-checked={isSelected || inChain}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!inChain) toggleSelect(id);
                            }}
                          >
                            {(inChain || isSelected) && (
                              <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                                <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </span>
                          <span className={css.typeIcon}>
                            <ProcessorTypeIcon type={p.processorType} size={14} />
                          </span>
                          <span className={css.itemInfo}>
                            <span className={css.itemSub}>
                              <span className={css.itemName}>{p.name}</span>
                              <span className={`${badgeCss.typeBadge} ${getProcTypeBadgeClass(p.processorType)}`}>
                                {getProcTypeLabel(p.processorType)}
                              </span>
                            </span>
                            {p.description && (
                              <span className={css.itemDesc}>{p.description}</span>
                            )}
                          </span>
                          <span className={css.itemStatus}>
                            {inChain && <span className={css.inChainLabel}>in pipeline</span>}
                          </span>
                          <svg
                            className={`${css.expandChevron}${isExpanded ? ` ${css.expandChevronOpen}` : ''}`}
                            width="10" height="10" viewBox="0 0 10 10" fill="none"
                          >
                            <path d="M2.5 3.5L5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        {isExpanded && <ProcessorDetailCard processor={p} />}
                      </div>
                    );
                  })
                )}
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

        {/* Footer (multi-select action bar) — only on installed tab */}
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
