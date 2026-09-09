// Types that mirror the Rust serde structs crossing the Tauri IPC boundary.
// Keep in sync with src-tauri/src/core/line.rs

export type LogLevel = 'Verbose' | 'Debug' | 'Info' | 'Warn' | 'Error' | 'Fatal';

/**
 * Mirrors the Rust `SourceType` enum in `src-tauri/src/core/session.rs` — that
 * enum is the source of truth. `Radio` is reachable from content detection;
 * `Events`, `Tombstone` and `ANRTrace` exist on the backend and can arrive over
 * IPC. `Custom { parser_id }` serializes as `Custom(<id>)` and is intentionally
 * not enumerated here.
 *
 * `'Unknown'` is NOT a backend variant — it is a frontend-only fallback used
 * when a session's type cannot be resolved locally (see `useSessionTabManager`).
 */
export type SourceType =
  | 'Bugreport'
  | 'Dumpstate'
  | 'Logcat'
  | 'Kernel'
  | 'Radio'
  | 'Events'
  | 'Tombstone'
  | 'ANRTrace'
  | 'Unknown';

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
  /** True if the file uses CRLF line endings. Always false for streams. */
  hasCrlf: boolean;
  /** Detected file encoding (e.g. "UTF-8", "UTF-16 LE", "UTF-16 BE"). */
  encoding: string;
  /**
   * Client-side only: cumulative count of live-stream lines permanently lost
   * because they could not be spilled to disk. Never sent by the backend at
   * load time (a fresh session has none); populated from `AdbBatchPayload`
   * via `updateSession` as the stream runs. Undefined for file sessions.
   */
  lostLineCount?: number;
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

/** Directories an MCP client is permitted to open files from via
 *  `logtapper_open_file`, plus the allow-all bypass. Mirrors
 *  `McpOpenAllowlist` in `src-tauri/src/commands/bridge_access.rs`. */
export interface McpOpenAllowlist {
  allowedDirs: string[];
  allowAll: boolean;
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
  /**
   * Cumulative count of evicted lines that could not be spilled to disk and are
   * therefore permanently lost. 0 in the normal case; non-zero surfaces
   * otherwise-silent data loss (spill-file create/write failure).
   */
  lostLineCount: number;
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
  processorType: 'transformer' | 'reporter' | 'state_tracker' | 'correlator';
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
  /** Pack this processor belongs to, if any. */
  packId?: string;
  /** State tracker mode. Only set for state_tracker type. */
  trackerMode?: 'snapshot' | 'time_series';
  /** Whether this state tracker outputs to the timeline. */
  trackerTimeline?: boolean;
  /** Section names this state tracker targets (bugreport/dumpstate only). */
  trackerSections?: string[];
  /** Log source types this processor supports (e.g. "logcat", "bugreport", "dumpstate"). */
  sourceTypes?: string[];
}

// ---------------------------------------------------------------------------
// Pack types
// ---------------------------------------------------------------------------

export interface PackSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  category?: string;
  license?: string;
  repository?: string;
  deprecated: boolean;
  processorIds: string[];
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
  /** Absolute line number of the first line scanned in this run. Omitted
   * (undefined) when 0 — i.e. for file sources and streams that haven't
   * evicted yet. When present, lines before this number were excluded from
   * the run because they'd already been evicted from the stream's in-memory
   * buffer (spilled to disk, not read back in for the pipeline scan). Not
   * currently rendered in the UI. */
  scannedFrom?: number;
  /** Present when the backend excluded this processor before running it, so
   * `matchedLines: 0` means "never ran" rather than "ran and matched nothing".
   *
   * The backend owns this decision — do NOT re-derive it here by comparing the
   * session's source type against the processor's declared `sourceTypes`. A
   * second implementation of that rule is exactly how the frontend and backend
   * drift (the `Dumpstate`/`Bugreport` superset asymmetry is easy to invert).
   * Render what arrives. */
  skipped?: SkipReason;
}

/** Why the backend excluded a processor from a run before executing it. */
export interface SkipReason {
  /** Machine-readable discriminant, currently only `source_type_mismatch`. */
  reason: string;
  /** The processor's declared `source_types`. */
  declared: string[];
  /** The session's actual source type. */
  actual: string;
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

/** Extract bare ID from a potentially qualified ID (strip `@source` suffix). */
export function getBareId(qualifiedId: string): string {
  const at = qualifiedId.lastIndexOf('@');
  return at > 0 ? qualifiedId.substring(0, at) : qualifiedId;
}

/**
 * Resolve pipeline chain IDs to their ProcessorSummary objects via a Map
 * lookup, preserving chain order. IDs that don't resolve (e.g. a processor
 * referenced by a persisted chain but no longer installed) are dropped.
 */
export function resolveChainProcessors(
  chainIds: string[],
  processors: ProcessorSummary[],
): ProcessorSummary[] {
  const byId = new Map(processors.map((p) => [p.id, p]));
  const resolved: ProcessorSummary[] = [];
  for (const id of chainIds) {
    const p = byId.get(id);
    if (p) resolved.push(p);
  }
  return resolved;
}

export interface ProcessorPackGroup {
  pack: PackSummary;
  processors: ProcessorSummary[];
}

/**
 * Group a list of processors (already resolved/ordered, e.g. via
 * `resolveChainProcessors`) into their owning packs, plus a standalone
 * bucket for processors that don't belong to any installed pack.
 *
 * Pack manifests reference bare IDs ("wifi-state") while processors carry
 * qualified IDs ("wifi-state@official"), so matching goes through
 * `getBareId`. Within each pack, processors are emitted in `chainProcessors`
 * order (not `pack.processorIds` order) — this preserves whatever order the
 * caller resolved the chain in, which matters when the chain is user-
 * reorderable (e.g. ProcessorPanel's drag-and-drop).
 */
export function groupProcessorsByPack(
  chainProcessors: ProcessorSummary[],
  packs: PackSummary[],
): { packGroups: ProcessorPackGroup[]; standaloneProcessors: ProcessorSummary[] } {
  const groups: ProcessorPackGroup[] = [];
  const assigned = new Set<string>();

  for (const pack of packs) {
    const packBareIds = new Set(pack.processorIds);
    const packProcs = chainProcessors.filter((p) => packBareIds.has(getBareId(p.id)));
    if (packProcs.length > 0) {
      groups.push({ pack, processors: packProcs });
      for (const p of packProcs) assigned.add(p.id);
    }
  }

  const standalone = chainProcessors.filter((p) => !assigned.has(p.id));
  return { packGroups: groups, standaloneProcessors: standalone };
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

export interface MarketplacePackEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  path: string;
  tags: string[];
  sha256: string;
  category?: string;
  processorIds: string[];
}

export interface MarketplaceFetchResult {
  processors: MarketplaceEntry[];
  packs: MarketplacePackEntry[];
}

/** Check if all active filter tags are present in the item's tags. */
export function matchesAllTags(tags: string[], activeFilters: Set<string>): boolean {
  for (const tag of activeFilters) {
    if (!tags.includes(tag)) return false;
  }
  return true;
}

/**
 * Case-insensitive match against an item's name, description, and tags.
 * `q` must already be lowercased — callers typically compute it once per
 * query rather than re-lowercasing per item.
 */
export function matchesQuery(
  item: { name: string; description?: string; tags: string[] },
  q: string,
): boolean {
  return (
    item.name.toLowerCase().includes(q) ||
    (item.description ?? '').toLowerCase().includes(q) ||
    item.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/** Filter marketplace entries by search query (matches name, description, tags) */
export function filterMarketplaceEntries(entries: MarketplaceEntry[], query: string): MarketplaceEntry[] {
  if (!query) return entries;
  const q = query.toLowerCase();
  return entries.filter((e) => matchesQuery(e, q));
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
  /** Section names this tracker's data was sourced from (bugreport/dumpstate only). */
  sourceSections: string[];
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

/** Short single-letter labels for LogLevel, used in compact chip/text displays. */
export const LEVEL_SHORT: Record<string, string> = {
  Verbose: 'V',
  Debug: 'D',
  Info: 'I',
  Warn: 'W',
  Error: 'E',
  Fatal: 'F',
};

/**
 * Ordered list of human-readable parts describing a FilterCriteria (text
 * search, regex, levels, tags, pids). Consumers decide how to turn the array
 * into UI — e.g. join into a single string for a toast message. Doesn't cover
 * `combine` — callers that need to call out OR-mode (e.g. CriteriaChips'
 * accent chip) render that separately.
 */
export function describeCriteriaParts(criteria: FilterCriteria): string[] {
  const parts: string[] = [];
  if (criteria.textSearch) parts.push(`text:${criteria.textSearch}`);
  if (criteria.regex) parts.push(`/${criteria.regex}/`);
  if (criteria.logLevels?.length) {
    parts.push(criteria.logLevels.map((l) => LEVEL_SHORT[l] ?? l).join(','));
  }
  if (criteria.tags?.length) parts.push(`tag:${criteria.tags.join(',')}`);
  if (criteria.pids?.length) parts.push(`pid:${criteria.pids.join(',')}`);
  return parts;
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
  /** Which session this reference's line numbers resolve against. `null`
   *  means unattributed/unresolved. */
  sessionId: string | null;
}

export interface AnalysisSection {
  heading: string;
  body: string;
  references: SourceReference[];
  severity: AnalysisSeverity | null;
}

export interface AnalysisArtifact {
  id: string;
  title: string;
  createdAt: number;
  sections: AnalysisSection[];
}

export interface AnalysisUpdateEvent {
  artifactId: string;
  action: 'published' | 'updated' | 'deleted' | 'restored';
  sessionIds: string[];
  sessionId: string | null;
}

export interface WorkspaceRestoredPayload {
  sessionId: string;
  bookmarkCount: number;
  analysisCount: number;
  activeProcessorIds?: string[];
  disabledProcessorIds?: string[];
  /** Which backend emitted this: `"lts"` (recreated from a `.lts` archive mid
   *  `load_log_file` — `useWorkspaceRestore` owns its auto-run) or `"workspace"`
   *  (from `restore_workspace_session` on the `.ltw` path — the restore core owns
   *  it). Optional so payloads from older backends still parse. */
  source?: 'lts' | 'workspace';
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

export interface PackUpdateAvailable {
  packId: string;
  packName: string;
  sourceName: string;
  installedVersion: string;
  availableVersion: string;
  newProcessorIds: string[];
  entry: MarketplacePackEntry;
}

export interface UpdateCheckResult {
  updates: UpdateAvailable[];
  packUpdates: PackUpdateAvailable[];
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

export interface ExportSessionEntry {
  sessionId: string;
  sourceFilename: string;
  bookmarkCount: number;
  analysisCount: number;
}

export interface ExportAllSessionsInfo {
  sessions: ExportSessionEntry[];
  totalProcessorCount: number;
  totalPipelineProcessorCount: number;
}

export interface LtsEditorTabPayload {
  label: string;
  content: string;
  viewMode: 'editor' | 'split' | 'preview';
  wordWrap: boolean;
  filePath: string | null;
}

export interface ExportAllOptions {
  destPath: string;
  includeBookmarks: boolean;
  includeAnalyses: boolean;
  includeProcessors: boolean;
  editorTabs: LtsEditorTabPayload[];
}

// ---------------------------------------------------------------------------
// Workspace v4 (.ltw)
// ---------------------------------------------------------------------------

export interface LtwManifestSession {
  filePath: string;
  sourceName: string;
  sourceType: string;
  /** The label explicitly supplied at open to replace content detection, absent
   *  when `sourceType` was detected. Only this is replayed on restore —
   *  replaying `sourceType` would freeze detection, so a later fix to the
   *  detector could never reach an already-saved workspace. */
  sourceTypeOverride?: string;
  /** The session id this entry's file resolved to when the workspace was
   *  saved (T8). Restore re-derives the id for the same file and compares it
   *  against this value — a mismatch means the file's content changed since
   *  the save, so any analysis reference keyed to the old id is now
   *  unresolved. Absent on a manifest written before this field existed. */
  expectedSessionId?: string;
}

export interface LtwPipelineChain {
  chain: string[];
  disabledIds: string[];
}

export interface LtwEditorTab {
  label: string;
  content: string;
  viewMode: string;
  wordWrap: boolean;
  filePath: string | null;
}

export interface SaveWorkspaceV4Options {
  /** Stable workspace id — cached into the backend envelope so a background
   *  flush can update this workspace's app-state.json entry. */
  workspaceId: string;
  destPath: string;
  workspaceName: string;
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
  pipelineChain: string[];
  disabledChainIds: string[];
}

/** Options for `sync_workspace_envelope` — a lightweight backend cache refresh
 *  (no file write). Mirrors the save options but carries the workspace's
 *  explicit `.ltw` path (if any) rather than a save destination. */
export interface SyncWorkspaceEnvelopeOptions {
  workspaceId: string;
  workspaceName: string;
  ltwPath: string | null;
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
  pipelineChain: string[];
  disabledChainIds: string[];
}

export interface LoadWorkspaceSessionData {
  bookmarks: Bookmark[];
  /** Legacy per-session analyses payload — populated only when the source
   *  `.ltw` predates the analyses migration. Current files always carry `[]`
   *  here; the workspace's real analyses are on `LoadWorkspaceV4Result.analyses`. */
  analyses: AnalysisArtifact[];
  activeProcessorIds: string[];
  disabledProcessorIds: string[];
}

export interface LoadWorkspaceV4Result {
  workspaceName: string;
  /** Stable workspace id from the manifest, or null for legacy files. Fed to
   *  Q3's `assessRestoreCandidate` as the candidate's `workspaceId`. */
  workspaceId: string | null;
  /** Manifest savedAt epoch-ms — Q3's timestamp check against `lastAutoSaveAt`. */
  savedAt: number;
  sessions: LtwManifestSession[];
  pipelineChain: LtwPipelineChain;
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
  /** Workspace-level analyses (top-level `analyses.json`). Empty for a
   *  pre-migration file — see `LoadWorkspaceSessionData.analyses` for where
   *  that data surfaces instead. */
  analyses: AnalysisArtifact[];
  /** Per-session artifacts ordered to match `sessions` by index. */
  sessionData: LoadWorkspaceSessionData[];
}

export interface RestoreSessionOptions {
  sessionId: string;
  bookmarks: Bookmark[];
  analyses: AnalysisArtifact[];
  activeProcessorIds: string[];
  disabledProcessorIds: string[];
}

// ---------------------------------------------------------------------------
// App state persistence
// ---------------------------------------------------------------------------

export interface WorkspaceEntry {
  id: string;
  name: string;
  ltwPath: string | null;
  dirty: boolean;
  /** Path to the app-data-dir auto-save `.ltw` (`workspaces/{id}.ltw`), or null
   *  if never auto-saved. Distinct from `ltwPath` (explicit user save). Optional
   *  because app-state.json files written before this field parse without it. */
  autoSavePath?: string | null;
  /** Epoch-millis timestamp of the last completed auto-save, or null. Paired
   *  with `autoSavePath`. Optional for the same backward-compat reason. */
  lastAutoSaveAt?: number | null;
}

export interface AppStateFile {
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string | null;
}

// ---------------------------------------------------------------------------
// File associations
// ---------------------------------------------------------------------------

export interface FileAssocEntry {
  ext: string;
  label: string;
  registered: boolean;
  isDefault: boolean;
}

/** The bundled `.mcpb` MCP Bundle and whether the OS can open it. */
export interface McpBundleInfo {
  path: string;
  installable: boolean;
}
