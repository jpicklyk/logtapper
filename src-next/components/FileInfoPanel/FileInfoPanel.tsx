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
}

const SectionItem = memo<SectionItemProps>(function SectionItem({
  section,
  isActive,
  jumpSeq,
  startLine,
  onJump,
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const handleClick = useCallback(() => onJump?.(startLine), [onJump, startLine]);

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
      className={clsx(styles.sectionItem, isActive && styles.sectionItemActive)}
      onClick={handleClick}
      title={tooltip}
    >
      <span className={styles.sectionName}>{section.name}</span>
      <span className={styles.sectionLine}>{lineCount.toLocaleString()}</span>
    </button>
  );
});

// ── Section filter ────────────────────────────────────────────────────────────

function filterSections(sections: SectionEntry[], query: string): SectionEntry[] {
  if (!query) return sections;
  const q = query.toLowerCase();
  const matchIndices = new Set<number>();

  // Direct name matches — include parent of any matching child
  sections.forEach((s, i) => {
    if (s.name.toLowerCase().includes(q)) {
      matchIndices.add(i);
      if (s.parentIndex !== undefined) matchIndices.add(s.parentIndex);
    }
  });

  // Include children of matching parents
  sections.forEach((s, i) => {
    if (s.parentIndex !== undefined && matchIndices.has(s.parentIndex)) {
      matchIndices.add(i);
    }
  });

  return sections.filter((_, i) => matchIndices.has(i));
}

// ── Section grouping ─────────────────────────────────────────────────────────

/** A single section or a collapsed group of sections sharing a prefix. */
type SectionRow =
  | { kind: 'single'; section: SectionEntry; index: number }
  | { kind: 'group'; prefix: string; sections: SectionEntry[];
      firstIndex: number; lastIndex: number; totalLines: number };

const GROUP_THRESHOLD = 5;

/**
 * Detect runs of consecutive sections whose names share a common prefix and
 * collapse them into a single expandable group row. Only groups with
 * GROUP_THRESHOLD+ members are collapsed; smaller runs stay individual.
 * Precomputes totalLines per group to avoid redundant work in child components.
 */
function groupSections(sections: SectionEntry[]): SectionRow[] {
  if (sections.length === 0) return [];

  const rows: SectionRow[] = [];
  let i = 0;

  while (i < sections.length) {
    const prefix = extractGroupPrefix(sections[i].name);
    if (prefix) {
      let j = i + 1;
      while (j < sections.length && sections[j].name.startsWith(prefix)) j++;
      const runLen = j - i;
      if (runLen >= GROUP_THRESHOLD) {
        const groupSecs = sections.slice(i, j);
        let lines = 0;
        for (const s of groupSecs) lines += s.endLine - s.startLine + 1;
        rows.push({
          kind: 'group', prefix, sections: groupSecs,
          firstIndex: i, lastIndex: j - 1, totalLines: lines,
        });
        i = j;
        continue;
      }
    }
    rows.push({ kind: 'single', section: sections[i], index: i });
    i++;
  }
  return rows;
}

/**
 * Extract a groupable prefix from a section name. Returns the prefix string
 * (including trailing space) if the name looks like "PREFIX detail...", e.g.
 * "SHOW MAP 1690: ..." → "SHOW MAP", "ROUTE TABLE IPv4" → "ROUTE TABLE".
 * Returns null if no groupable prefix is found.
 */
function extractGroupPrefix(name: string): string | null {
  // Match patterns like "WORD WORD number/detail" — the prefix is the
  // uppercase words before the varying suffix.
  const m = name.match(/^([A-Z][A-Z0-9_]+(?: [A-Z][A-Z0-9_]+)*) /);
  if (!m) return null;
  return m[1] + ' ';
}

// ── Collapsed section group ──────────────────────────────────────────────────

const EXPAND_PAGE_SIZE = 50;

interface SectionGroupProps {
  prefix: string;
  sections: SectionEntry[];
  totalLines: number;
  activeStartLine: number;
  jumpSeq: number;
  onJump: ((line: number) => void) | undefined;
}

const SectionGroup = memo<SectionGroupProps>(function SectionGroup({
  prefix,
  sections,
  totalLines,
  activeStartLine,
  jumpSeq,
  onJump,
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(EXPAND_PAGE_SIZE);

  // Check if any section in this group is the active one
  const hasActive = sections.some((s) => s.startLine === activeStartLine);

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

  const visibleSections = expanded
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
          {visibleSections.map((s) => (
            <SectionItem
              key={s.startLine}
              section={s}
              isActive={s.startLine === activeStartLine}
              jumpSeq={jumpSeq}
              startLine={s.startLine}
              onJump={onJump}
            />
          ))}
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

    // ── Filtered and grouped sections ─────────────────────────────────────
    const filteredSections = useMemo(
      () => filterSections(sections, debouncedQuery),
      [sections, debouncedQuery],
    );
    const groupedSections = useMemo(() => groupSections(filteredSections), [filteredSections]);

    // ── Active section tracking (by startLine, works across filter) ────────
    // Convert the index (into the unfiltered array) to a startLine so active
    // highlighting works correctly even when the section list is filtered.
    const activeStartLine = activeSectionIndex >= 0 && activeSectionIndex < sections.length
      ? sections[activeSectionIndex].startLine
      : -1;

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
                  placeholder="Filter sections\u2026"
                  value={searchQuery}
                  onChange={handleSearchChange}
                  className={styles.searchInput}
                />
              </div>
              <div className={styles.sectionList}>
                {groupedSections.map((row) =>
                  row.kind === 'single' ? (
                    <SectionItem
                      key={row.section.startLine}
                      section={row.section}
                      isActive={row.section.startLine === activeStartLine}
                      jumpSeq={sectionJumpSeq}
                      startLine={row.section.startLine}
                      onJump={onJumpToLine}
                    />
                  ) : (
                    <SectionGroup
                      key={`group-${row.sections[0].startLine}`}
                      prefix={row.prefix}
                      sections={row.sections}
                      totalLines={row.totalLines}
                      activeStartLine={activeStartLine}
                      jumpSeq={sectionJumpSeq}
                      onJump={onJumpToLine}
                    />
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);
