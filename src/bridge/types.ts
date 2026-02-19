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

export interface ProcessorSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
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
// Claude types (Phase 4)
// ---------------------------------------------------------------------------

export interface ClaudeStreamEvent {
  /** "text" | "done" | "error" */
  kind: string;
  text?: string;
  error?: string;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** True while this assistant message is still streaming */
  streaming?: boolean;
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
