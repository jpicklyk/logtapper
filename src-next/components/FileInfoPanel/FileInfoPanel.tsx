import React, { memo, useEffect, useRef } from 'react';
import clsx from 'clsx';
import type { DumpstateMetadata } from '../../bridge/types';
import styles from './FileInfoPanel.module.css';

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

  return (
    <button
      ref={btnRef}
      className={clsx(styles.sectionItem, isActive && styles.sectionItemActive)}
      onClick={onClick}
      title={`Line ${section.startLine + 1}: ${section.name}`}
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
  }) {
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

          {sections.length > 0 && (
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
