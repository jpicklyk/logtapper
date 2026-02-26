import React, { memo, useEffect, useRef } from 'react';
import clsx from 'clsx';
import type { DumpstateMetadata } from '../../bridge/types';
import type { IndexingProgress } from '../../context';
import styles from './FileInfoPanel.module.css';
import { getSectionDescription } from './sectionDescriptions';

export interface SectionEntry {
  name: string;
  startLine: number;
  endLine: number;
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

function formatTimestamp(ns: number | null | undefined): string {
  if (ns === null || ns === undefined || ns === 0) return '\u2014';
  // Timestamps are nanoseconds since Unix epoch (1970-01-01 UTC).
  // BASE_NS in the Rust parsers is the Unix nanosecond value of 2000-01-01,
  // so the stored value is already Unix-compatible — just divide to get ms.
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toLocaleString(undefined, { timeZone: 'UTC' });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const Row = memo<{ label: string; value: string | null | undefined }>(
  function Row({ label, value }) {
    if (!value) return null;
    return (
      <div className={styles.row}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value} title={value}>{value}</span>
      </div>
    );
  },
);

// Tape-reader data: each entry is [width%, opacity] representing a log line's visual weight.
// The pattern mimics realistic log density — most lines are short+dim, occasional lines are full.
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
// Duplicate for seamless loop
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
          {progress ? progress.linesIndexed.toLocaleString() : '—'}
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

interface SectionItemProps {
  section: SectionEntry;
  isActive: boolean;
  jumpSeq: number;
  onClick: () => void;
}

const SectionItem = memo<SectionItemProps>(function SectionItem({
  section,
  isActive,
  jumpSeq,
  onClick,
}) {
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isActive || !btnRef.current) return;
    const el = btnRef.current;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.style.animation = 'none';
    void el.offsetHeight; // force reflow to restart keyframe
    el.style.animation = '';
  }, [isActive, jumpSeq]);

  const description = getSectionDescription(section.name);
  const tooltip = description
    ? `${description}\nLines ${section.startLine + 1}–${section.endLine + 1}`
    : `Lines ${section.startLine + 1}–${section.endLine + 1}`;

  return (
    <button
      ref={btnRef}
      className={clsx(styles.sectionItem, isActive && styles.sectionItemActive)}
      onClick={onClick}
      title={tooltip}
    >
      <span className={styles.sectionName}>{section.name}</span>
      <span className={styles.sectionLine}>{section.startLine + 1}</span>
    </button>
  );
});

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
    const isScanning = sourceType === 'Bugreport' && indexingProgress !== null;
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>File Info</span>
        </div>

        <div className={styles.body}>
          <details open className={styles.metaSection}>
            <summary className={styles.sectionHeader}>File</summary>
            <div className={styles.rows}>
              <Row label="Name" value={sourceName} />
              <Row label="Type" value={sourceType} />
              <Row label="Lines" value={totalLines?.toLocaleString()} />
              <Row label="Size" value={fileSize != null ? formatFileSize(fileSize) : undefined} />
              <Row label="From" value={formatTimestamp(firstTimestamp)} />
              <Row label="To" value={formatTimestamp(lastTimestamp)} />
            </div>
          </details>

          {dumpstateMetadata && (
            <details open className={styles.metaSection}>
              <summary className={styles.sectionHeader}>Device</summary>
              <div className={styles.rows}>
                <Row label="Model" value={dumpstateMetadata.deviceModel} />
                <Row label="Maker" value={dumpstateMetadata.manufacturer} />
                <Row label="Android" value={dumpstateMetadata.osVersion} />
                <Row label="SDK" value={dumpstateMetadata.sdkVersion} />
                <Row label="Type" value={dumpstateMetadata.buildType} />
                <Row label="Build" value={dumpstateMetadata.buildString} />
                <Row label="Serial" value={dumpstateMetadata.serial} />
                <Row label="Bootloader" value={dumpstateMetadata.bootloader} />
                <Row label="Kernel" value={dumpstateMetadata.kernelVersion} />
                <Row label="Uptime" value={dumpstateMetadata.uptime} />
                <Row label="Fingerprint" value={dumpstateMetadata.buildFingerprint} />
              </div>
            </details>
          )}

          {isScanning && <SectionsScanning progress={indexingProgress} />}

          {!isScanning && sections.length > 0 && (
            <div className={styles.sectionsArea}>
              <div className={styles.sectionHeader}>Sections ({sections.length})</div>
              <div className={styles.sectionList}>
                {sections.map((s, i) => (
                  <SectionItem
                    key={s.startLine}
                    section={s}
                    isActive={i === activeSectionIndex}
                    jumpSeq={sectionJumpSeq}
                    onClick={() => onJumpToLine?.(s.startLine)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);
