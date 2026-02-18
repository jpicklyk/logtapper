import type { LoadResult, DumpstateMetadata } from '../bridge/types';

export interface SectionEntry {
  lineNum: number;
  title: string;
}

interface Props {
  session: LoadResult;
  sections: SectionEntry[];
  onJumpToSection: (lineNum: number) => void;
  metadata?: DumpstateMetadata | null;
}

// Offset from 2000-01-01 UTC to Unix epoch in milliseconds.
const YEAR2000_MS = 946_684_800_000;

function formatTimestamp(ns: number | null): string {
  if (ns === null || ns === 0) return '—';
  const ms = Math.floor(ns / 1_000_000) + YEAR2000_MS;
  return new Date(ms).toLocaleString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="file-info-row">
      <span className="file-info-label">{label}</span>
      <span className="file-info-value" title={value}>{value}</span>
    </div>
  );
}

export default function FileInfoPanel({ session, sections, onJumpToSection, metadata }: Props) {
  return (
    <div className="file-info-panel">
      <div className="file-info-header">
        <span className="file-info-title">File Info</span>
      </div>

      <div className="file-info-body">
        <details open>
          <summary className="file-info-section-header">File</summary>
          <div className="file-info-rows">
            <Row label="Name" value={session.sourceName} />
            <Row label="Type" value={session.sourceType} />
            <Row label="Lines" value={session.totalLines.toLocaleString()} />
            <Row label="Size" value={formatFileSize(session.fileSize)} />
            <Row label="From" value={formatTimestamp(session.firstTimestamp)} />
            <Row label="To" value={formatTimestamp(session.lastTimestamp)} />
          </div>
        </details>

        {metadata && (
          <details open>
            <summary className="file-info-section-header">Device</summary>
            <div className="file-info-rows">
              <Row label="Model" value={metadata.deviceModel} />
              <Row label="Maker" value={metadata.manufacturer} />
              <Row label="Android" value={metadata.osVersion} />
              <Row label="SDK" value={metadata.sdkVersion} />
              <Row label="Type" value={metadata.buildType} />
              <Row label="Build" value={metadata.buildString} />
              <Row label="Serial" value={metadata.serial} />
              <Row label="Bootloader" value={metadata.bootloader} />
              <Row label="Kernel" value={metadata.kernelVersion} />
              <Row label="Uptime" value={metadata.uptime} />
              <Row label="Fingerprint" value={metadata.buildFingerprint} />
            </div>
          </details>
        )}

        {sections.length > 0 && (
          <details open>
            <summary className="file-info-section-header">Sections</summary>
            <div className="file-info-section-list">
              {sections.map((s) => (
                <button
                  key={s.lineNum}
                  className="file-info-section-item"
                  onClick={() => onJumpToSection(s.lineNum)}
                  title={`Line ${s.lineNum + 1}: ${s.title}`}
                >
                  <span className="file-info-section-name">{s.title}</span>
                  <span className="file-info-section-line">{s.lineNum + 1}</span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
