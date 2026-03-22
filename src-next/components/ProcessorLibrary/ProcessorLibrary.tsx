import { memo, useState, useCallback, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import type { ProcessorSummary } from '../../bridge/types';
import {
  loadProcessorFromFile,
} from '../../bridge/commands';
import { usePipeline } from '../../hooks';
import { useProcessors, usePipelineChain } from '../../context';
import { getCategoryLabel, CATEGORY_ORDER } from '../../ui/categoryMeta';
import { ProcessorTypeIcon } from '../../ui/processorTypeIcons';
import { ProcessorDetailCard } from '../ProcessorDetailCard';
import css from './ProcessorLibrary.module.css';
import badgeCss from '../../ui/processorBadge.module.css';
import { PROC_TYPE_LABELS, PROC_TYPE_CLASS_KEY } from '../../ui/processorBadgeTypes';

type Tab = 'installed' | 'yaml';

// transformer label is overridden to 'PII' here (built-in PII anonymizer only)
const LOCAL_LABEL_OVERRIDES: Record<string, string> = { transformer: 'PII' };

function getProcTypeLabel(type: string): string {
  return LOCAL_LABEL_OVERRIDES[type] ?? PROC_TYPE_LABELS[type] ?? type;
}

function getProcTypeBadgeClass(type: string): string {
  return badgeCss[PROC_TYPE_CLASS_KEY[type] as keyof typeof badgeCss] ?? '';
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
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

  // All unique tags across all processors (for filter chips)
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const p of processors) {
      for (const t of p.tags) {
        tagSet.add(t);
      }
    }
    return Array.from(tagSet).sort();
  }, [processors]);

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

  // Processors filtered by text search AND active tag filters
  const filtered: ProcessorSummary[] = useMemo(
    () =>
      processors.filter((p) => {
        // Text search filter
        if (q) {
          const matchesText =
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.tags.some((t) => t.toLowerCase().includes(q));
          if (!matchesText) return false;
        }
        // Tag chip filter (AND: processor must have ALL active tags)
        if (activeTagFilters.size > 0) {
          for (const activeTag of activeTagFilters) {
            if (!p.tags.includes(activeTag)) return false;
          }
        }
        return true;
      }),
    [processors, q, activeTagFilters],
  );

  // Group by category, sorted by CATEGORY_ORDER
  const categoryGroups = useMemo(() => {
    const groups = new Map<string, ProcessorSummary[]>();
    for (const p of filtered) {
      const cat = p.category ?? 'uncategorized';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    const sorted = Array.from(groups.entries()).sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a[0]);
      const bi = CATEGORY_ORDER.indexOf(b[0]);
      const aRank = ai === -1 ? 999 : ai;
      const bRank = bi === -1 ? 999 : bi;
      if (aRank !== bRank) return aRank - bRank;
      // Both are unknowns: sort alphabetically
      return a[0].localeCompare(b[0]);
    });
    return sorted;
  }, [filtered]);

  const toggleSection = useCallback((cat: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

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
          {(['installed', 'yaml'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`${css.tab}${tab === t ? ` ${css.tabActive}` : ''}`}
              onClick={() => switchTab(t)}
            >
              {t === 'installed' ? 'Installed' : 'Custom YAML'}
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
                {filtered.length === 0 ? (
                  <div className={css.empty}>
                    {processors.length === 0 ? (
                      <>
                        No processors installed.
                        <br />
                        Use <strong>Custom YAML</strong> to add some.
                      </>
                    ) : (
                      'No processors match your search.'
                    )}
                  </div>
                ) : (
                  categoryGroups.map(([cat, procs]) => {
                    const isCollapsed = collapsedSections.has(cat);
                    return (
                      <div key={cat} className={css.categorySection}>
                        <button
                          className={css.categoryHeader}
                          onClick={() => toggleSection(cat)}
                          aria-expanded={!isCollapsed}
                        >
                          <svg
                            className={`${css.chevron}${isCollapsed ? ` ${css.chevronCollapsed}` : ''}`}
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                          >
                            <path d="M2.5 3.5L5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className={css.categoryLabel}>{getCategoryLabel(cat)}</span>
                          <span className={css.groupCount}>{procs.length}</span>
                        </button>
                        {!isCollapsed && procs.map((p) => {
                          const inChain = chainSet.has(p.id);
                          const isSelected = selected.has(p.id);
                          const isExpanded = expandedId === p.id;
                          return (
                            <div key={p.id} className={css.itemWrapper}>
                              <button
                                className={`${css.item}${isSelected ? ` ${css.itemSelected}` : ''}${inChain ? ` ${css.itemInChain}` : ''}`}
                                onClick={(e) => {
                                  // Expand on click anywhere in the row
                                  toggleExpand(p.id);
                                  e.stopPropagation();
                                }}
                              >
                                {/* Checkbox zone: stops propagation so it only selects */}
                                <span
                                  className={`${css.checkbox}${isSelected ? ` ${css.checkboxChecked}` : ''}${inChain ? ` ${css.checkboxChain}` : ''}`}
                                  role="checkbox"
                                  aria-checked={isSelected || inChain}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!inChain) toggleSelect(p.id);
                                  }}
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
                                <span className={css.typeIcon}>
                                  <ProcessorTypeIcon type={p.processorType} size={14} />
                                </span>
                                <span className={css.itemInfo}>
                                  <span className={css.itemName}>{p.name}</span>
                                  <span className={css.itemSub}>
                                    <span
                                      className={`${badgeCss.typeBadge} ${getProcTypeBadgeClass(p.processorType)}`}
                                    >
                                      {getProcTypeLabel(p.processorType)}
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
                                <svg
                                  className={`${css.expandChevron}${isExpanded ? ` ${css.expandChevronOpen}` : ''}`}
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                >
                                  <path d="M2.5 3.5L5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                              {isExpanded && (
                                <ProcessorDetailCard processor={p} />
                              )}
                            </div>
                          );
                        })}
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
