import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  FileText, Smartphone, Clock, HardDrive, Layers, Hash, ChevronRight, Search,
} from 'lucide-react';
import type { DumpstateMetadata, SourceType } from '../../bridge/types';
import { isBugreportLike } from '../../bridge/types';
import type { IndexingProgress } from '../../context';
import { Input } from '../../ui';
import { formatFileSize } from '../../utils';
import styles from './FileInfoPanel.module.css';
import { getSectionDescription } from './sectionDescriptions';
import { filterSections, buildSectionTree } from './sectionTree';
import type { SectionEntry, SectionRow } from './sectionTree';
import { formatTimestamp, formatDuration } from './formatters';

export type { SectionEntry } from './sectionTree';

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
        isSelected && styles.sectionItemSelected,
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
    </button>
  );
});

// ── Parent DUMPSYS section ────────────────────────────────────────────────────

const EXPAND_PAGE_SIZE = 50;

interface ParentSectionProps {
  section: SectionEntry;
  children: { section: SectionEntry; index: number }[];
  totalLines: number;
  activeStartLine: number;
  jumpSeq: number;
  onJump: ((line: number) => void) | undefined;
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
        <span className={styles.sectionGroupAccent} />
        <span className={styles.parentName}>{section.name}</span>
        <span className={styles.sectionGroupBadge}>{children.length}</span>
        <span className={styles.sectionLine}>{totalLines.toLocaleString()}</span>
        <ChevronRight
          size={12}
          className={clsx(styles.sectionGroupChevron, expanded && styles.sectionGroupChevronOpen)}
        />
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
        <span className={styles.sectionGroupAccent} />
        <span className={styles.sectionGroupPrefix}>{prefix.trim()}</span>
        <span className={styles.sectionGroupBadge}>{sections.length}</span>
        <span className={styles.sectionLine}>{totalLines.toLocaleString()}</span>
        <ChevronRight
          size={12}
          className={clsx(styles.sectionGroupChevron, expanded && styles.sectionGroupChevronOpen)}
        />
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

          {/* ── Sections list (bugreport/dumpstate only) ──────────── */}
          {!isScanning && sections.length > 0 && isBugreportLike(sourceType ?? '') && (
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
              <div className={clsx(styles.sectionList, isSectionFilterActive && styles.sectionFilterActive)}>
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
