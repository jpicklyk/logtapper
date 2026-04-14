import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  FileText, Smartphone, Clock, HardDrive, Layers, Hash, Search,
} from 'lucide-react';
import type { DumpstateMetadata } from '../../bridge/types';
import { isBugreportLike } from '../../bridge/types';
import type { IndexingProgress } from '../../context';
import { Input } from '../../ui';
import { formatFileSize } from '../../utils';
import styles from './FileInfoPanel.module.css';
import { filterSections, buildSectionTree } from './sectionTree';
import type { SectionEntry } from './sectionTree';
import { formatTimestamp, formatDuration } from './formatters';
import SectionsScanning from './SectionsScanning';
import SectionItem from './SectionItem';
import SectionGroup from './SectionGroup';
import ParentSection from './ParentSection';
import listStyles from './SectionList.module.css';

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
            <span className={styles.typeBadge} data-source-type={sourceType}>
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
              <div className={clsx(styles.sectionList, isSectionFilterActive && listStyles.sectionFilterActive)}>
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
