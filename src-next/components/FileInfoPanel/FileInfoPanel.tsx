import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  FileText, Smartphone, Clock, HardDrive, Layers, Hash, ChevronRight, Search,
} from 'lucide-react';
import type { DumpstateMetadata, SourceType } from '../../bridge/types';
import { isBugreportLike } from '../../bridge/types';
import type { IndexingProgress } from '../../context';
import { Input } from '../../ui';
import styles from './FileInfoPanel.module.css';
import { getSectionDescription } from './sectionDescriptions';

export interface SectionEntry {
  name: string;
  startLine: number;
  endLine: number;
  parentIndex?: number;
}

interface FileInfoPanelProps {
  sourceName?: string;
  sourceType?: string;
  totalLines?: number;
  fileSize?: number;
  firstTimestamp?: number | null;
  lastTimestamp?: number | null;
  sections: SectionEntry[];
  onJumpToLine?: (lineNum: number) => void;
  dumpstateMetadata?: DumpstateMetadata | null;
  activeSectionIndex?: number;
  sectionJumpSeq?: number;
  indexingProgress?: IndexingProgress | null;
  selectedSectionIndices?: Set<number>;
  onToggleSection?: (index: number) => void;
  onToggleGroup?: (indices: number[]) => void;
  onClearSectionFilter?: () => void;
  isSectionFilterActive?: boolean;
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatTimestamp(ns: number | null | undefined): string {
  if (ns === null || ns === undefined || ns === 0) return '\u2014';
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toLocaleString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatDuration(startNs: number | null | undefined, endNs: number | null | undefined): string | null {
  if (!startNs || !endNs || startNs === 0 || endNs === 0) return null;
  const diffMs = Math.floor((endNs - startNs) / 1_000_000);
  if (diffMs < 0) return null;
  if (diffMs < 1000) return `${diffMs}ms`;
  if (diffMs < 60_000) return `${(diffMs / 1000).toFixed(1)}s`;
  if (diffMs < 3_600_000) {
    const m = Math.floor(diffMs / 60_000);
    const s = Math.floor((diffMs % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  if (diffMs < 86_400_000) {
    const h = Math.floor(diffMs / 3_600_000);
    const m = Math.floor((diffMs % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(diffMs / 86_400_000);
  const h = Math.floor((diffMs % 86_400_000) / 3_600_000);
  return `${d}d ${h}h`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sourceTypeColor(type: SourceType | undefined): string {
  switch (type) {
    case 'Bugreport':  return 'var(--warning)';
    case 'Logcat':     return 'var(--success)';
    case 'Kernel':     return 'var(--android)';
    default:           return 'var(--text-dimmed)';
  }
}

// ── Stat cell ────────────────────────────────────────────────────────────────

function StatCell({ icon, label, value, sub }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string | null;
}) {
  return (
    <div className={styles.statCell}>
      <div className={styles.statIcon}>{icon}</div>
      <div className={styles.statContent}>
        <span className={styles.statLabel}>{label}</span>
        <span className={styles.statValue}>{value}</span>
        {sub && <span className={styles.statSub}>{sub}</span>}
      </div>
    </div>
  );
}

// ── Device field ─────────────────────────────────────────────────────────────

const DeviceField = memo<{ label: string; value: string | null | undefined }>(
  function DeviceField({ label, value }) {
    if (!value) return null;
    return (
      <div className={styles.deviceField}>
        <span className={styles.deviceFieldLabel}>{label}</span>
        <span className={styles.deviceFieldValue} title={value}>{value}</span>
      </div>
    );
  },
);

// ── Tape reader (scanning animation) ─────────────────────────────────────────

const TAPE_LINES: Array<[string, number]> = [
  ['92%', 0.40], ['65%', 0.15], ['100%', 0.55], ['48%', 0.20], ['88%', 0.38],
  ['30%', 0.10], ['76%', 0.45], ['55%', 0.25], ['100%', 0.60], ['40%', 0.12],
  ['82%', 0.38], ['68%', 0.30], ['95%', 0.52], ['22%', 0.08], ['74%', 0.40],
  ['58%', 0.22], ['100%', 0.55], ['43%', 0.15], ['87%', 0.42], ['62%', 0.28],
  ['78%', 0.35], ['35%', 0.12], ['91%', 0.48], ['52%', 0.18], ['100%', 0.58],
  ['44%', 0.14], ['83%', 0.42], ['61%', 0.22], ['97%', 0.50], ['28%', 0.09],
  ['70%', 0.36], ['56%', 0.20], ['100%', 0.62], ['38%', 0.11], ['85%', 0.44],
  ['64%', 0.26], ['93%', 0.52], ['47%', 0.16], ['79%', 0.40], ['33%', 0.10],
];
const TAPE_DOUBLED = [...TAPE_LINES, ...TAPE_LINES];

const SectionsScanning = memo(function SectionsScanning({
  progress,
}: {
  progress: IndexingProgress | null;
}) {
  const pct = progress != null ? progress.percent : null;
  return (
    <div className={styles.scanning}>
      <span className={styles.scanTitle}>Scanning sections</span>
      <div className={styles.tapeReader}>
        <div className={styles.tapeTrack}>
          {TAPE_DOUBLED.map(([w, o], i) => (
            <div key={i} className={styles.tapeLine} style={{ width: w, opacity: o }} />
          ))}
        </div>
        <div className={styles.scanGlowAbove} />
        <div className={styles.scanHead} />
        <div className={styles.scanGlowBelow} />
      </div>
      <div className={styles.scanInfo}>
        <span className={styles.scanCounter}>
          {progress ? progress.linesIndexed.toLocaleString() : '\u2014'}
        </span>
        <span className={styles.scanSuffix}> lines</span>
      </div>
      {pct !== null && (
        <div className={styles.scanBar}>
          <div className={styles.scanBarFill} style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
      )}
    </div>
  );
});

// ── Section item ─────────────────────────────────────────────────────────────

interface SectionItemProps {
  section: SectionEntry;
  isActive: boolean;
  jumpSeq: number;
  startLine: number;
  onJump: ((line: number) => void) | undefined;
  maxLines: number;
  isChild?: boolean;
  originalIndex: number;
  isSelected?: boolean;
  onToggle?: (index: number) => void;
}

const SectionItem = memo<SectionItemProps>(function SectionItem({
  section,
  isActive,
  jumpSeq,
  startLine,
  onJump,
  maxLines,
  isChild = false,
  originalIndex,
  isSelected,
  onToggle,
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const handleClick = useCallback(() => onJump?.(startLine), [onJump, startLine]);
  const handleCheckboxChange = useCallback(() => onToggle?.(originalIndex), [onToggle, originalIndex]);
  const stopProp = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  useEffect(() => {
    if (!isActive || !btnRef.current) return;
    const el = btnRef.current;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.style.animation = 'none';
    void el.offsetHeight;
    el.style.animation = '';
  }, [isActive, jumpSeq]);

  const lineCount = section.endLine - section.startLine + 1;
  const barWidth = maxLines > 0 ? (lineCount / maxLines) * 100 : 0;
  const description = getSectionDescription(section.name);
  const tooltip = description
    ? `${description}\nLines ${section.startLine + 1}\u2013${section.endLine + 1} (${lineCount.toLocaleString()} lines)`
    : `Lines ${section.startLine + 1}\u2013${section.endLine + 1} (${lineCount.toLocaleString()} lines)`;

  return (
    <button
      ref={btnRef}
      className={clsx(
        styles.sectionItem,
        isActive && styles.sectionItemActive,
        isChild && styles.sectionItemChild,
      )}
      onClick={handleClick}
      title={tooltip}
    >
      {onToggle && (
        <input
          type="checkbox"
          className={styles.sectionCheckbox}
          checked={isSelected ?? false}
          onChange={handleCheckboxChange}
          onClick={stopProp}
        />
      )}
      <span className={styles.sectionName}>{section.name}</span>
      <span className={styles.sectionLine}>{lineCount.toLocaleString()}</span>
      <div className={styles.sizeBar} style={{ width: `${barWidth}%` }} />
    </button>
  );
});

// ── Section filter ────────────────────────────────────────────────────────────

function filterSections(sections: SectionEntry[], query: string): SectionEntry[] {
  if (!query) return sections;
  const q = query.toLowerCase();
  const matchIndices = new Set<number>();
  // Track which parents matched the query directly (not just via child promotion)
  const directParentMatches = new Set<number>();

  // Direct name matches — include parent of any matching child
  sections.forEach((s, i) => {
    if (s.name.toLowerCase().includes(q)) {
      matchIndices.add(i);
      if (s.parentIndex === undefined) {
        // This is a top-level section that directly matched
        directParentMatches.add(i);
      } else {
        // Child matched — promote its parent (but don't mark as direct match)
        matchIndices.add(s.parentIndex);
      }
    }
  });

  // Only include ALL children when the parent itself directly matched the query.
  // When a parent was only included because a child matched, keep only matching children.
  sections.forEach((s, i) => {
    if (s.parentIndex !== undefined && directParentMatches.has(s.parentIndex)) {
      matchIndices.add(i);
    }
  });

  return sections.filter((_, i) => matchIndices.has(i));
}

// ── Section tree building ─────────────────────────────────────────────────────

/** A single section, a collapsible prefix group, or a parent+children DUMPSYS block. */
type SectionRow =
  | { kind: 'single'; section: SectionEntry; index: number }
  | { kind: 'prefixGroup'; prefix: string; sections: { section: SectionEntry; index: number }[];
      totalLines: number }
  | { kind: 'parent'; section: SectionEntry; index: number;
      children: { section: SectionEntry; index: number }[]; totalLines: number };

const GROUP_THRESHOLD = 5;

/**
 * Extract a groupable prefix from a section name. Returns the prefix string
 * (including trailing space) if the name looks like "PREFIX detail...", e.g.
 * "SHOW MAP 1690: ..." → "SHOW MAP", "ROUTE TABLE IPv4" → "ROUTE TABLE".
 * Returns null if no groupable prefix is found.
 */
function extractGroupPrefix(name: string): string | null {
  const m = name.match(/^([A-Z][A-Z0-9_]+(?: [A-Z][A-Z0-9_]+)*) /);
  if (!m) return null;
  return m[1] + ' ';
}

/**
 * Apply prefix grouping to a flat list of indexed sections.
 * Runs of GROUP_THRESHOLD+ consecutive sections sharing a prefix become a prefixGroup.
 */
function applyPrefixGrouping(
  items: { section: SectionEntry; index: number }[],
): SectionRow[] {
  const rows: SectionRow[] = [];
  let i = 0;
  while (i < items.length) {
    const prefix = extractGroupPrefix(items[i].section.name);
    if (prefix) {
      let j = i + 1;
      while (j < items.length && items[j].section.name.startsWith(prefix)) j++;
      const runLen = j - i;
      if (runLen >= GROUP_THRESHOLD) {
        const groupItems = items.slice(i, j);
        let lines = 0;
        for (const item of groupItems) lines += item.section.endLine - item.section.startLine + 1;
        rows.push({
          kind: 'prefixGroup',
          prefix,
          sections: groupItems,
          totalLines: lines,
        });
        i = j;
        continue;
      }
    }
    rows.push({ kind: 'single', section: items[i].section, index: items[i].index });
    i++;
  }
  return rows;
}

/**
 * Build a tree of SectionRows from a flat (possibly filtered) sections array.
 *
 * Sections with parentIndex become children of their parent. Top-level sections
 * without children are subject to prefix grouping. Top-level sections that have
 * children become parent rows.
 *
 * `originalSections` is needed because `parentIndex` values reference positions
 * in the unfiltered backend array — when sections are filtered, array positions
 * shift but parentIndex values don't. We resolve parent identity via startLine.
 */
function buildSectionTree(sections: SectionEntry[], originalSections: SectionEntry[]): SectionRow[] {
  if (sections.length === 0) return [];

  // 1. Build parent-startLine → children map.
  // parentIndex references the *original* array, so resolve to startLine for stable matching.
  const childrenByParentStartLine = new Map<number, { section: SectionEntry; index: number }[]>();
  sections.forEach((s, i) => {
    if (s.parentIndex !== undefined && s.parentIndex < originalSections.length) {
      const parentStartLine = originalSections[s.parentIndex].startLine;
      let arr = childrenByParentStartLine.get(parentStartLine);
      if (!arr) { arr = []; childrenByParentStartLine.set(parentStartLine, arr); }
      arr.push({ section: s, index: i });
    }
  });

  // 2. Walk top-level sections (no parentIndex)
  const rows: SectionRow[] = [];
  // Accumulate consecutive childless top-level sections for prefix grouping
  let pendingChildless: { section: SectionEntry; index: number }[] = [];

  const flushPending = () => {
    if (pendingChildless.length === 0) return;
    const grouped = applyPrefixGrouping(pendingChildless);
    rows.push(...grouped);
    pendingChildless = [];
  };

  sections.forEach((s, i) => {
    if (s.parentIndex !== undefined) return; // skip children — handled via parent

    const children = childrenByParentStartLine.get(s.startLine);
    if (children && children.length > 0) {
      // Flush any pending childless sections first to preserve order
      flushPending();
      let totalLines = s.endLine - s.startLine + 1;
      for (const c of children) totalLines += c.section.endLine - c.section.startLine + 1;
      rows.push({ kind: 'parent', section: s, index: i, children, totalLines });
    } else {
      pendingChildless.push({ section: s, index: i });
    }
  });

  flushPending();
  return rows;
}

// ── Parent DUMPSYS section ────────────────────────────────────────────────────

const EXPAND_PAGE_SIZE = 50;

interface ParentSectionProps {
  section: SectionEntry;
  children: { section: SectionEntry; index: number }[];
  totalLines: number;
  activeStartLine: number;
  jumpSeq: number;
  onJump: ((line: number) => void) | undefined;
  maxLines: number;
  selectedSectionIndices?: Set<number>;
  onToggleSection?: (index: number) => void;
  onToggleGroup?: (indices: number[]) => void;
  startLineToOrigIdx: Map<number, number>;
}

const ParentSection = memo<ParentSectionProps>(function ParentSection({
  section,
  children,
  totalLines,
  activeStartLine,
  jumpSeq,
  onJump,
  maxLines,
  selectedSectionIndices,
  onToggleSection,
  onToggleGroup,
  startLineToOrigIdx,
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(EXPAND_PAGE_SIZE);

  const isParentActive = section.startLine === activeStartLine;
  const hasActiveChild = children.some(c => c.section.startLine === activeStartLine);

  // Compute group original indices for tri-state checkbox
  const parentOrigIdx = startLineToOrigIdx.get(section.startLine) ?? -1;
  const childOrigIndices = useMemo(
    () => children.map(c => startLineToOrigIdx.get(c.section.startLine) ?? -1).filter(i => i >= 0),
    [children, startLineToOrigIdx],
  );
  const allIndices = useMemo(
    () => (parentOrigIdx >= 0 ? [parentOrigIdx, ...childOrigIndices] : childOrigIndices),
    [parentOrigIdx, childOrigIndices],
  );
  const allChecked = onToggleGroup != null && allIndices.length > 0
    && allIndices.every(i => selectedSectionIndices?.has(i));
  const someChecked = !allChecked && allIndices.some(i => selectedSectionIndices?.has(i));

  const groupCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (groupCheckboxRef.current) groupCheckboxRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const handleGroupToggle = useCallback(() => onToggleGroup?.(allIndices), [onToggleGroup, allIndices]);
  const stopGroupProp = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  // Auto-expand when active child exists
  useEffect(() => {
    if (hasActiveChild) setExpanded(true);
  }, [hasActiveChild]);

  const toggle = useCallback(() => {
    setExpanded(v => !v);
    setVisibleCount(EXPAND_PAGE_SIZE);
  }, []);

  const showMore = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setVisibleCount(v => v + EXPAND_PAGE_SIZE);
  }, []);

  const visible = expanded ? children.slice(0, visibleCount) : [];
  const hasMore = expanded && visibleCount < children.length;

  return (
    <div className={styles.parentGroup}>
      <button
        className={clsx(
          styles.parentHeader,
          (isParentActive || hasActiveChild) && styles.parentHeaderActive,
        )}
        onClick={toggle}
        type="button"
        title={`${section.name} — ${children.length} services, ${totalLines.toLocaleString()} lines`}
      >
        {onToggleGroup && (
          <input
            ref={groupCheckboxRef}
            type="checkbox"
            className={styles.sectionCheckbox}
            checked={allChecked}
            onChange={handleGroupToggle}
            onClick={stopGroupProp}
          />
        )}
        <ChevronRight
          size={12}
          className={clsx(styles.sectionGroupChevron, expanded && styles.sectionGroupChevronOpen)}
        />
        <span className={styles.parentName}>{section.name}</span>
        <span className={styles.sectionGroupBadge}>{children.length}</span>
        <span className={styles.sectionLine}>{totalLines.toLocaleString()}</span>
      </button>
      {expanded && (
        <div className={styles.parentChildren}>
          {visible.map(c => {
            const origIdx = startLineToOrigIdx.get(c.section.startLine) ?? -1;
            return (
              <SectionItem
                key={c.section.startLine}
                section={c.section}
                isActive={c.section.startLine === activeStartLine}
                jumpSeq={jumpSeq}
                startLine={c.section.startLine}
                onJump={onJump}
                maxLines={maxLines}
                isChild={true}
                originalIndex={origIdx}
                isSelected={origIdx >= 0 ? selectedSectionIndices?.has(origIdx) : false}
                onToggle={onToggleSection}
              />
            );
          })}
          {hasMore && (
            <button className={styles.showMoreBtn} onClick={showMore} type="button">
              Show more ({children.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// ── Collapsed prefix section group ───────────────────────────────────────────

interface SectionGroupProps {
  prefix: string;
  sections: { section: SectionEntry; index: number }[];
  totalLines: number;
  activeStartLine: number;
  jumpSeq: number;
  onJump: ((line: number) => void) | undefined;
  maxLines: number;
  selectedSectionIndices?: Set<number>;
  onToggleSection?: (index: number) => void;
  onToggleGroup?: (indices: number[]) => void;
  startLineToOrigIdx: Map<number, number>;
}

const SectionGroup = memo<SectionGroupProps>(function SectionGroup({
  prefix,
  sections,
  totalLines,
  activeStartLine,
  jumpSeq,
  onJump,
  maxLines,
  selectedSectionIndices,
  onToggleSection,
  onToggleGroup,
  startLineToOrigIdx,
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(EXPAND_PAGE_SIZE);

  // Check if any section in this group is the active one
  const hasActive = sections.some((item) => item.section.startLine === activeStartLine);

  // Compute group original indices for tri-state checkbox
  const groupOrigIndices = useMemo(
    () => sections.map(item => startLineToOrigIdx.get(item.section.startLine) ?? -1).filter(i => i >= 0),
    [sections, startLineToOrigIdx],
  );
  const allChecked = onToggleGroup != null && groupOrigIndices.length > 0
    && groupOrigIndices.every(i => selectedSectionIndices?.has(i));
  const someChecked = !allChecked && groupOrigIndices.some(i => selectedSectionIndices?.has(i));

  const groupCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (groupCheckboxRef.current) groupCheckboxRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const handleGroupToggle = useCallback(() => onToggleGroup?.(groupOrigIndices), [onToggleGroup, groupOrigIndices]);
  const stopGroupProp = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  // Auto-expand when the active section is inside this group
  useEffect(() => {
    if (hasActive) setExpanded(true);
  }, [hasActive]);

  const toggle = useCallback(() => {
    setExpanded((v) => !v);
    setVisibleCount(EXPAND_PAGE_SIZE);
  }, []);

  const showMore = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setVisibleCount((v) => v + EXPAND_PAGE_SIZE);
  }, []);

  const visibleItems = expanded
    ? (visibleCount >= sections.length ? sections : sections.slice(0, visibleCount))
    : [];
  const hasMore = expanded && visibleCount < sections.length;

  return (
    <div className={styles.sectionGroup}>
      <button
        className={clsx(styles.sectionGroupHeader, hasActive && styles.sectionGroupActive)}
        onClick={toggle}
        type="button"
      >
        {onToggleGroup && (
          <input
            ref={groupCheckboxRef}
            type="checkbox"
            className={styles.sectionCheckbox}
            checked={allChecked}
            onChange={handleGroupToggle}
            onClick={stopGroupProp}
          />
        )}
        <ChevronRight
          size={12}
          className={clsx(styles.sectionGroupChevron, expanded && styles.sectionGroupChevronOpen)}
        />
        <span className={styles.sectionGroupPrefix}>{prefix.trim()}</span>
        <span className={styles.sectionGroupBadge}>{sections.length}</span>
        <span className={styles.sectionLine}>{totalLines.toLocaleString()}</span>
      </button>
      {expanded && (
        <div className={styles.sectionGroupItems}>
          {visibleItems.map((item) => {
            const origIdx = startLineToOrigIdx.get(item.section.startLine) ?? -1;
            return (
              <SectionItem
                key={item.section.startLine}
                section={item.section}
                isActive={item.section.startLine === activeStartLine}
                jumpSeq={jumpSeq}
                startLine={item.section.startLine}
                onJump={onJump}
                maxLines={maxLines}
                isChild={false}
                originalIndex={origIdx}
                isSelected={origIdx >= 0 ? selectedSectionIndices?.has(origIdx) : false}
                onToggle={onToggleSection}
              />
            );
          })}
          {hasMore && (
            <button
              className={styles.showMoreBtn}
              onClick={showMore}
              type="button"
            >
              Show more ({sections.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// ── Main panel ───────────────────────────────────────────────────────────────

export const FileInfoPanel = React.memo<FileInfoPanelProps>(
  function FileInfoPanel({
    sourceName,
    sourceType,
    totalLines,
    fileSize,
    firstTimestamp,
    lastTimestamp,
    sections,
    onJumpToLine,
    dumpstateMetadata,
    activeSectionIndex = -1,
    sectionJumpSeq = 0,
    indexingProgress = null,
    selectedSectionIndices,
    onToggleSection,
    onToggleGroup,
    onClearSectionFilter,
    isSectionFilterActive,
  }) {
    const isScanning = !!sourceType && isBugreportLike(sourceType) && indexingProgress !== null;
    const duration = formatDuration(firstTimestamp, lastTimestamp);
    const meta = dumpstateMetadata;
    const typeColor = sourceTypeColor(sourceType as SourceType | undefined);

    // ── Search state (local per principle #5) ──────────────────────────────
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');

    useEffect(() => {
      if (!searchQuery) {
        setDebouncedQuery('');
        return;
      }
      const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150);
      return () => clearTimeout(timer);
    }, [searchQuery]);

    const handleSearchChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value),
      [],
    );

    // ── Filtered and tree-structured sections ─────────────────────────────
    const filteredSections = useMemo(
      () => filterSections(sections, debouncedQuery),
      [sections, debouncedQuery],
    );
    const groupedSections = useMemo(() => buildSectionTree(filteredSections, sections), [filteredSections, sections]);

    // ── Max lines for proportional size bars ──────────────────────────────
    const maxLines = useMemo(() => {
      let max = 0;
      for (const s of filteredSections) {
        const count = s.endLine - s.startLine + 1;
        if (count > max) max = count;
      }
      return max;
    }, [filteredSections]);

    // ── Active section tracking (by startLine, works across filter) ────────
    const activeStartLine = activeSectionIndex >= 0 && activeSectionIndex < sections.length
      ? sections[activeSectionIndex].startLine
      : -1;

    // ── startLine → original index map (for checkbox selection) ───────────
    const startLineToOrigIdx = useMemo(() => {
      const map = new Map<number, number>();
      sections.forEach((s, i) => map.set(s.startLine, i));
      return map;
    }, [sections]);

    return (
      <div className={styles.panel}>
        {/* ── File identity ─────────────────────────────────────── */}
        <div className={styles.fileIdentity}>
          <div className={styles.fileNameRow}>
            <FileText size={14} className={styles.fileIcon} />
            <span className={styles.fileName} title={sourceName}>
              {sourceName ?? 'No file'}
            </span>
          </div>
          {sourceType && (
            <span
              className={styles.typeBadge}
              style={{ color: typeColor, borderColor: typeColor }}
            >
              {sourceType}
            </span>
          )}
        </div>

        <div className={styles.body}>
          {/* ── Stats grid ────────────────────────────────────────── */}
          <div className={styles.statsGrid}>
            <StatCell
              icon={<Hash size={12} />}
              label="Lines"
              value={totalLines?.toLocaleString() ?? '\u2014'}
            />
            <StatCell
              icon={<HardDrive size={12} />}
              label="Size"
              value={fileSize != null ? formatFileSize(fileSize) : '\u2014'}
            />
          </div>

          {/* ── Time range ────────────────────────────────────────── */}
          {(firstTimestamp || lastTimestamp) && (
            <div className={styles.timeRange}>
              <div className={styles.timeRangeHeader}>
                <Clock size={11} className={styles.timeIcon} />
                <span className={styles.timeLabel}>Time Range</span>
                {duration && (
                  <span className={styles.timeDuration}>{duration}</span>
                )}
              </div>
              <div className={styles.timeStamps}>
                <div className={styles.timeStamp}>
                  <span className={styles.timeEndpoint}>From</span>
                  <span className={styles.timeValue}>{formatTimestamp(firstTimestamp)}</span>
                </div>
                <div className={styles.timeStamp}>
                  <span className={styles.timeEndpoint}>To</span>
                  <span className={styles.timeValue}>{formatTimestamp(lastTimestamp)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Device card ───────────────────────────────────────── */}
          {meta && (
            <details open className={styles.deviceCard}>
              <summary className={styles.groupHeader}>
                <Smartphone size={11} />
                <span>Device</span>
              </summary>
              <div className={styles.deviceIdentity}>
                {(meta.manufacturer || meta.deviceModel) && (
                  <div className={styles.deviceModelRow}>
                    {meta.manufacturer && (
                      <span className={styles.deviceMaker}>{meta.manufacturer}</span>
                    )}
                    {meta.deviceModel && (
                      <span className={styles.deviceModel}>{meta.deviceModel}</span>
                    )}
                  </div>
                )}
                {(meta.osVersion || meta.sdkVersion) && (
                  <div className={styles.deviceOsRow}>
                    {meta.osVersion && (
                      <span className={styles.osVersion}>Android {meta.osVersion}</span>
                    )}
                    {meta.sdkVersion && (
                      <span className={styles.sdkBadge}>SDK {meta.sdkVersion}</span>
                    )}
                  </div>
                )}
              </div>
              <div className={styles.deviceFields}>
                <DeviceField label="Build" value={meta.buildType} />
                <DeviceField label="Serial" value={meta.serial} />
                <DeviceField label="Bootloader" value={meta.bootloader} />
                <DeviceField label="Kernel" value={meta.kernelVersion} />
                <DeviceField label="Uptime" value={meta.uptime} />
                <DeviceField label="Fingerprint" value={meta.buildFingerprint} />
                <DeviceField label="Build ID" value={meta.buildString} />
              </div>
            </details>
          )}

          {/* ── Sections scanning ─────────────────────────────────── */}
          {isScanning && <SectionsScanning progress={indexingProgress} />}

          {/* ── Sections list ─────────────────────────────────────── */}
          {!isScanning && sections.length > 0 && (
            <div className={styles.sectionsArea}>
              <div className={styles.groupHeader}>
                <Layers size={11} />
                <span>Sections</span>
                <span className={styles.groupCount}>
                  {debouncedQuery
                    ? `${filteredSections.length}/${sections.length}`
                    : sections.length}
                </span>
              </div>
              <div className={styles.searchBar}>
                <Input
                  prefixIcon={Search as React.ComponentType<{ size?: number }>}
                  placeholder="Filter sections..."
                  value={searchQuery}
                  onChange={handleSearchChange}
                  className={styles.searchInput}
                />
              </div>
              {isSectionFilterActive && selectedSectionIndices && (
                <div className={styles.sectionFilterBanner}>
                  <span>
                    {selectedSectionIndices.size} section{selectedSectionIndices.size !== 1 ? 's' : ''} filtered
                  </span>
                  <button
                    className={styles.sectionFilterClear}
                    onClick={onClearSectionFilter}
                    type="button"
                  >
                    Clear
                  </button>
                </div>
              )}
              <div className={styles.sectionList}>
                {groupedSections.map((row) => {
                  switch (row.kind) {
                    case 'single': {
                      const origIdx = startLineToOrigIdx.get(row.section.startLine) ?? -1;
                      return (
                        <SectionItem
                          key={row.section.startLine}
                          section={row.section}
                          isActive={row.section.startLine === activeStartLine}
                          jumpSeq={sectionJumpSeq}
                          startLine={row.section.startLine}
                          onJump={onJumpToLine}
                          maxLines={maxLines}
                          originalIndex={origIdx}
                          isSelected={origIdx >= 0 ? selectedSectionIndices?.has(origIdx) : false}
                          onToggle={onToggleSection}
                        />
                      );
                    }
                    case 'prefixGroup':
                      return (
                        <SectionGroup
                          key={`pfx-${row.sections[0].section.startLine}`}
                          prefix={row.prefix}
                          sections={row.sections}
                          totalLines={row.totalLines}
                          activeStartLine={activeStartLine}
                          jumpSeq={sectionJumpSeq}
                          onJump={onJumpToLine}
                          maxLines={maxLines}
                          selectedSectionIndices={selectedSectionIndices}
                          onToggleSection={onToggleSection}
                          onToggleGroup={onToggleGroup}
                          startLineToOrigIdx={startLineToOrigIdx}
                        />
                      );
                    case 'parent':
                      return (
                        <ParentSection
                          key={`parent-${row.section.startLine}`}
                          section={row.section}
                          children={row.children}
                          totalLines={row.totalLines}
                          activeStartLine={activeStartLine}
                          jumpSeq={sectionJumpSeq}
                          onJump={onJumpToLine}
                          maxLines={maxLines}
                          selectedSectionIndices={selectedSectionIndices}
                          onToggleSection={onToggleSection}
                          onToggleGroup={onToggleGroup}
                          startLineToOrigIdx={startLineToOrigIdx}
                        />
                      );
                  }
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);
