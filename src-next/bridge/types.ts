// Types that mirror the Rust serde structs crossing the Tauri IPC boundary.
// Keep in sync with src-tauri/src/core/line.rs

export type LogLevel = 'Verbose' | 'Debug' | 'Info' | 'Warn' | 'Error' | 'Fatal';

export type SourceType = 'Bugreport' | 'Dumpstate' | 'Logcat' | 'Kernel' | 'Unknown';

/** Dumpstate is a superset of Bugreport (Samsung dumps). Both need identical UI treatment. */
export function isBugreportLike(t: SourceType | string): boolean {
  return t === 'Bugreport' || t === 'Dumpstate';
}

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
  /** Full filesystem path for file-backed sessions; null for ADB streams. */
  filePath: string | null;
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

/** Discriminated union received via Channel<AdbStreamEvent>. */
export type AdbStreamEvent =
  | { event: 'batch';           data: AdbBatchPayload }
  | { event: 'processorUpdate'; data: AdbProcessorUpdate }
  | { event: 'streamStopped';   data: AdbStreamStopped };

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
  // 'transformer' is reserved for built-in processors only (e.g. __pii_anonymizer)
  processorType: 'transformer' | 'reporter' | 'state_tracker' | 'correlator' | 'annotator';
  group: string | null;
  /** Var declarations from the YAML (reporters only; empty for other types). */
  varsMeta: VarMeta[];
  /** SPDX license identifier (e.g. "MIT"). */
  license?: string;
  /** Standardized category from taxonomy. */
  category?: string;
  /** Source repository URL. */
  repository?: string;
  /** Whether this processor is deprecated. */
  deprecated: boolean;
  /** Whether this processor has a schema contract defined. */
  hasSchema: boolean;
  /** Marketplace source name (e.g. "official"), if installed from a source. */
  source?: string;
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
  scriptErrors?: number;
  firstScriptError?: string;
}

export interface MatchedLine {
  lineNum: number;
  raw: string;
}

export interface PipelineProgress {
  sessionId: string;
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
// Timeline sparkline types
// ---------------------------------------------------------------------------

export interface TimelinePoint {
  lineNum: number;
  value: number;
}

export interface TimelineSeriesData {
  processorId: string;
  processorName: string;
  field: string;
  label: string;
  color: string | null;
  points: TimelinePoint[];
  minValue: number;
  maxValue: number;
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
// Marketplace source types (Phase 2 — Source Management)
// ---------------------------------------------------------------------------

/** Build a qualified processor ID matching the backend convention: `id@source` */
export function makeQualifiedId(id: string, source: string): string {
  return `${id}@${source}`;
}

export interface Source {
  name: string;
  type: 'github' | 'local';
  repo?: string;
  ref?: string;
  path?: string;
  enabled: boolean;
  autoUpdate: boolean;
  lastChecked?: string;
}

export interface MarketplaceEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  path: string;
  tags: string[];
  sha256: string;
  category?: string;
  license?: string;
  processorType?: string;
  sourceTypes?: string[];
  deprecated: boolean;
}

/** Filter marketplace entries by search query (matches name, description, tags) */
export function filterMarketplaceEntries(entries: MarketplaceEntry[], query: string): MarketplaceEntry[] {
  if (!query) return entries;
  const q = query.toLowerCase();
  return entries.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
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

// ---------------------------------------------------------------------------
// Filter types (Phase 1)
// ---------------------------------------------------------------------------

export type CombineMode = 'and' | 'or';

export interface FilterCriteria {
  textSearch?: string;
  regex?: string;
  logLevels?: LogLevel[];
  tags?: string[];
  timeStart?: number;
  timeEnd?: number;
  pids?: number[];
  combine?: CombineMode;
}

export interface FilterCreateResult {
  filterId: string;
  sessionId: string;
  totalLines: number;
}

export interface FilterProgress {
  filterId: string;
  matchedSoFar: number;
  linesScanned: number;
  totalLines: number;
  done: boolean;
}

export interface FilteredLinesResult {
  filterId: string;
  totalMatches: number;
  lines: ViewLine[];
  status: 'scanning' | 'complete' | 'cancelled';
}

export interface SectionInfo {
  name: string;
  startLine: number;
  endLine: number;
  parentIndex?: number;
}

export interface FilterInfo {
  filterId: string;
  sessionId: string;
  totalMatches: number;
  linesScanned: number;
  totalLines: number;
  status: 'scanning' | 'complete' | 'cancelled';
}

// ---------------------------------------------------------------------------
// Session metadata (Phase 1B)
// ---------------------------------------------------------------------------

export interface TagCount {
  tag: string;
  count: number;
}

export interface SessionMetadata {
  sessionId: string;
  sourceName: string;
  sourceType: string;
  totalLines: number;
  fileSize: number;
  isLive: boolean;
  isIndexing: boolean;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  logLevelDistribution: Record<string, number>;
  topTags: TagCount[];
}

// ---------------------------------------------------------------------------
// Bookmark types (Phase 2)
// ---------------------------------------------------------------------------

export type CreatedBy = 'User' | 'Agent';

export type BookmarkCategory = 'error' | 'warning' | 'state-change' | 'timing' | 'observation' | 'custom';

export interface Bookmark {
  id: string;
  sessionId: string;
  lineNumber: number;
  lineNumberEnd?: number;
  snippet?: string[];
  category?: string;
  tags?: string[];
  label: string;
  note: string;
  createdBy: CreatedBy;
  createdAt: number;
}

export interface BookmarkUpdateEvent {
  sessionId: string;
  action: 'created' | 'updated' | 'deleted';
  bookmark: Bookmark;
}

// ---------------------------------------------------------------------------
// Analysis types (Phase 2)
// ---------------------------------------------------------------------------

export type HighlightTypeAnnotation = 'Annotation' | 'Anchor';

export type AnalysisSeverity = 'Info' | 'Warning' | 'Error' | 'Critical';

export function severityColor(severity: AnalysisSeverity | null): string {
  switch (severity) {
    case 'Critical': return 'var(--danger)';
    case 'Error':    return 'var(--danger)';
    case 'Warning':  return 'var(--warning)';
    case 'Info':     return 'var(--accent)';
    default:         return 'var(--text-dimmed)';
  }
}

export interface SourceReference {
  lineNumber: number;
  endLine: number | null;
  label: string;
  highlightType: HighlightTypeAnnotation;
}

export interface AnalysisSection {
  heading: string;
  body: string;
  references: SourceReference[];
  severity: AnalysisSeverity | null;
}

export interface AnalysisArtifact {
  id: string;
  sessionId: string;
  title: string;
  createdAt: number;
  sections: AnalysisSection[];
}

export interface AnalysisUpdateEvent {
  sessionId: string;
  action: 'published' | 'updated' | 'deleted';
  artifactId: string;
}

export interface WorkspaceRestoredPayload {
  sessionId: string;
  bookmarkCount: number;
  analysisCount: number;
  activeProcessorIds?: string[];
  disabledProcessorIds?: string[];
}

// ---------------------------------------------------------------------------
// Watch types (Phase 4)
// ---------------------------------------------------------------------------

export interface WatchInfo {
  watchId: string;
  sessionId: string;
  totalMatches: number;
  active: boolean;
  criteria: FilterCriteria;
}

export interface WatchMatchEvent {
  watchId: string;
  sessionId: string;
  newMatches: number;
  totalMatches: number;
}

// ---------------------------------------------------------------------------
// Update engine types (Phase 4)
// ---------------------------------------------------------------------------

export interface UpdateAvailable {
  processorId: string;
  processorName: string;
  sourceName: string;
  installedVersion: string;
  availableVersion: string;
  entry: MarketplaceEntry;
}

export interface SourceError {
  sourceName: string;
  error: string;
}

export interface UpdateCheckResult {
  updates: UpdateAvailable[];
  errors: SourceError[];
}

export interface UpdateResult {
  processorId: string;
  oldVersion: string;
  newVersion: string;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Export types (T4 + T5)
// ---------------------------------------------------------------------------

export interface ExportProcessorEntry {
  id: string;
  name: string;
  builtin: boolean;
}

export interface ExportSessionInfo {
  sourceFilename: string;
  sourceSize: number;
  bookmarkCount: number;
  analysisCount: number;
  processors: ExportProcessorEntry[];
}

export interface ExportOptions {
  destPath: string;
  includeBookmarks: boolean;
  includeAnalyses: boolean;
}
