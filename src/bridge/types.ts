// Types that mirror the Rust serde structs crossing the Tauri IPC boundary.
// Keep in sync with src-tauri/src/core/line.rs

export type LogLevel = 'Verbose' | 'Debug' | 'Info' | 'Warn' | 'Error' | 'Fatal';

export type HighlightKind =
  | { type: 'Search' }
  | { type: 'SearchActive' }
  | { type: 'ProcessorMatch'; id: string }
  | { type: 'ExtractedField'; name: string }
  | { type: 'PiiReplaced' };

export interface HighlightSpan {
  start: number;
  end: number;
  kind: HighlightKind;
}

export interface ViewLine {
  lineNum: number;
  virtualIndex: number;  // sequential 0-based position in current view
  raw: string;
  level: LogLevel;
  tag: string;
  message: string;
  timestamp: number;
  pid: number;
  tid: number;
  sourceId: string;
  highlights: HighlightSpan[];
  matchedBy: string[];
  isContext: boolean;
}

export interface LineWindow {
  totalLines: number;
  lines: ViewLine[];
}

export type ViewMode =
  | { mode: 'Full' }
  | { mode: 'Processor' }
  | { mode: 'Focus'; center: number };

export interface SearchQuery {
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
  withinProcessor?: string;
  minLevel?: LogLevel;
  tags?: string[];
  /** Time-of-day lower bound, format "HH:MM" or "HH:MM:SS" */
  startTime?: string;
  /** Time-of-day upper bound, format "HH:MM" or "HH:MM:SS" */
  endTime?: string;
}

export interface LineRequest {
  sessionId: string;
  mode: ViewMode;
  offset: number;
  count: number;
  context: number;
  processorId?: string;
  search?: SearchQuery;
}

export interface SearchSummary {
  totalMatches: number;
  matchLineNums: number[];
  byLevel: Record<string, number>;
  byTag: Record<string, number>;
}

export interface SearchProgress {
  sessionId: string;
  matchedSoFar: number;
  linesScanned: number;
  totalLines: number;
  newMatches: number[];
  done: boolean;
}

export interface LoadResult {
  sessionId: string;
  sourceId: string;
  sourceName: string;
  totalLines: number;
  fileSize: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sourceType: string;
  /** True for live ADB streaming sessions. */
  isStreaming: boolean;
  /** True while background file indexing is still in progress. */
  isIndexing: boolean;
}

// ---------------------------------------------------------------------------
// Progressive file-indexing events
// ---------------------------------------------------------------------------

export interface FileIndexProgress {
  sessionId: string;
  indexedLines: number;
  bytesScanned: number;
  totalBytes: number;
}

export interface FileIndexComplete {
  sessionId: string;
  totalLines: number;
}

// ---------------------------------------------------------------------------
// MCP bridge status
// ---------------------------------------------------------------------------

export interface McpStatus {
  running: boolean;
  port: number;
  /** Seconds since last request from the MCP client. null = never connected. */
  idleSecs: number | null;
}

// ---------------------------------------------------------------------------
// ADB streaming types
// ---------------------------------------------------------------------------

export interface AdbDevice {
  serial: string;
  model: string;
  state: string;
}

export interface AdbBatchPayload {
  sessionId: string;
  lines: ViewLine[];
  totalLines: number;
  /** Cumulative bytes received from ADB (for Size display in file info panel). */
  byteCount: number;
  /** First non-zero timestamp in the stream (ns since 2000-01-01 UTC), or null. */
  firstTimestamp: number | null;
  /** Most recent non-zero timestamp (ns since 2000-01-01 UTC), or null. */
  lastTimestamp: number | null;
}

export interface AdbProcessorUpdate {
  sessionId: string;
  processorId: string;
  matchedLines: number;
  emissionCount: number;
}

export interface AdbStreamStopped {
  sessionId: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Dumpstate metadata (extracted from bugreport/dumpstate files)
// ---------------------------------------------------------------------------

export interface DumpstateMetadata {
  buildString: string | null;
  buildFingerprint: string | null;
  osVersion: string | null;
  buildType: string | null;
  bootloader: string | null;
  serial: string | null;
  uptime: string | null;
  kernelVersion: string | null;
  sdkVersion: string | null;
  deviceModel: string | null;
  manufacturer: string | null;
}

// ---------------------------------------------------------------------------
// Section index (Bugreport/Dumpstate files)
// ---------------------------------------------------------------------------

export interface SectionInfo {
  name: string;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Processor types (Phase 2)
// ---------------------------------------------------------------------------

export interface ProcessorMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
}

export type VarType = 'int' | 'bool' | 'string' | 'float' | 'map' | 'list';

export interface VarDecl {
  name: string;
  type: VarType;
  default: unknown;
  display: boolean;
  label: string;
  displayAs?: 'table' | 'value';
  columns?: string[];
  configurable?: boolean;
}

export interface VarMeta {
  name: string;
  /** Human-readable label (from YAML label:, or title-cased name as fallback). */
  label: string;
  display: boolean;
  /** 'table' | 'value', or undefined. */
  displayAs?: 'table' | 'value';
  columns: string[];
}

export interface ProcessorSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  builtin: boolean;  // true for built-in processors (id starts with __)
  processorType: 'transformer' | 'reporter' | 'state_tracker' | 'correlator' | 'annotator';
  group: string | null;
  /** Var declarations from the YAML (reporters only; empty for other types). */
  varsMeta: VarMeta[];
}

// ---------------------------------------------------------------------------
// PII Anonymizer types
// ---------------------------------------------------------------------------

export interface PatternEntry {
  label: string;
  regex: string;
  builtin: boolean;
  enabled: boolean;
}

export interface DetectorEntry {
  id: string;
  label: string;
  tier: 'tier1' | 'tier2' | 'tier3';
  fpHint: string;
  enabled: boolean;
  patterns: PatternEntry[];
}

export interface AnonymizerConfig {
  detectors: DetectorEntry[];
}

export interface PiiReplacement {
  token: string;
  original: string;
  category: string;
  start: number;
  end: number;
}

export interface AnonymizerTestResult {
  anonymized: string;
  replacements: PiiReplacement[];
}

export interface PipelineRunSummary {
  processorId: string;
  matchedLines: number;
  emissionCount: number;
}

export interface MatchedLine {
  lineNum: number;
  raw: string;
}

export interface PipelineProgress {
  processorId: string;
  linesProcessed: number;
  totalLines: number;
  percent: number;
}

// ---------------------------------------------------------------------------
// Chart types (Phase 3)
// ---------------------------------------------------------------------------

export interface DataPoint {
  x: number;
  y: number;
  label?: string;
  timelinePos?: number;
}

export interface DataSeries {
  label: string;
  color?: string;
  points: DataPoint[];
}

export interface ChartData {
  id: string;
  chartType: string;
  title: string;
  description?: string;
  series: DataSeries[];
  xAxis: { label: string; field: string | null };
  yAxis: { label: string; field: string | null };
  interactive: boolean;
}

// ---------------------------------------------------------------------------
// Registry types (Phase 4)
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  path: string;
  tags: string[];
  sha256: string;
}

// ---------------------------------------------------------------------------
// StateTracker IPC types
// ---------------------------------------------------------------------------

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface StateTransition {
  lineNum: number;
  timestamp: number;
  transitionName: string;
  changes: Record<string, FieldChange>;
}

export interface StateSnapshot {
  lineNum: number;
  timestamp: number;
  fields: Record<string, unknown>;
  /** Field names explicitly set by at least one transition before this line.
   *  Fields absent from this list are still at their declared default and
   *  have never been triggered — treat their value as Unknown. */
  initializedFields: string[];
}

export interface AdbTrackerUpdate {
  sessionId: string;
  trackerId: string;
  transitionCount: number;
}

// ---------------------------------------------------------------------------
// Correlator IPC types
// ---------------------------------------------------------------------------

export interface SourceMatch {
  lineNum: number;
  timestamp: number;
  fields: Record<string, unknown>;
  rawLine: string;
}

export interface CorrelationEvent {
  triggerLineNum: number;
  triggerTimestamp: number;
  triggerSourceId: string;
  triggerFields: Record<string, unknown>;
  triggerRawLine: string;
  /** Non-trigger source matches available at trigger time. */
  matchedSources: Record<string, SourceMatch[]>;
  /** Human-readable message from the emit template. */
  message: string;
}

export interface CorrelatorResult {
  /** Plain-English explanation from the YAML author. */
  guidance: string | null;
  events: CorrelationEvent[];
}
