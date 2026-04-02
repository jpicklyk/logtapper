import { invoke, Channel } from '@tauri-apps/api/core';
import type {
  LineRequest,
  LineWindow,
  LoadResult,
  SearchQuery,
  SearchSummary,
  ProcessorSummary,
  PackSummary,
  PipelineRunSummary,
  MatchedLine,
  ChartData,
  RegistryEntry,
  DumpstateMetadata,
  AdbDevice,
  AdbStreamEvent,
  AnonymizerConfig,
  AnonymizerTestResult,
  StateSnapshot,
  StateTransition,
  McpStatus,
  CorrelatorResult,
  TimelineSeriesData,
  FilterCriteria,
  FilterCreateResult,
  FilteredLinesResult,
  FilterInfo,
  SessionMetadata,
  Bookmark,
  CreatedBy,
  AnalysisArtifact,
  AnalysisSection,
  WatchInfo,
  SectionInfo,
  Source,
  MarketplaceFetchResult,
  UpdateCheckResult,
  UpdateResult,
  UpdateAvailable,
  ExportSessionInfo,
  ExportOptions,
  FileAssocEntry,
} from './types';

// ---------------------------------------------------------------------------
// ADB streaming
// ---------------------------------------------------------------------------

export function listAdbDevices(): Promise<AdbDevice[]> {
  return invoke('list_adb_devices');
}

export function startAdbStream(
  deviceId?: string,
  packageFilter?: string,
  activeProcessorIds: string[] = [],
  maxRawLines?: number,
  onEvent?: (event: AdbStreamEvent) => void,
): Promise<LoadResult> {
  const channel = new Channel<AdbStreamEvent>();
  if (onEvent) {
    channel.onmessage = onEvent;
  }
  return invoke('start_adb_stream', {
    deviceId: deviceId ?? null,
    packageFilter: packageFilter ?? null,
    activeProcessorIds,
    maxRawLines: maxRawLines ?? null,
    onEvent: channel,
  });
}

export function stopAdbStream(sessionId: string): Promise<void> {
  return invoke('stop_adb_stream', { sessionId });
}

export function updateStreamProcessors(
  sessionId: string,
  processorIds: string[],
): Promise<void> {
  return invoke('update_stream_processors', { sessionId, processorIds });
}

export function updateStreamTrackers(
  sessionId: string,
  trackerIds: string[],
): Promise<void> {
  return invoke('update_stream_trackers', { sessionId, trackerIds });
}

export function updateStreamTransformers(
  sessionId: string,
  transformerIds: string[],
): Promise<void> {
  return invoke('update_stream_transformers', { sessionId, transformerIds });
}

export function setStreamAnonymize(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  return invoke('set_stream_anonymize', { sessionId, enabled });
}

export function getPackagePids(
  deviceSerial: string,
  packageName: string,
): Promise<number[]> {
  return invoke('get_package_pids', { deviceSerial, packageName });
}

// ---------------------------------------------------------------------------
// Phase 1 — File / Session
// ---------------------------------------------------------------------------

export function loadLogFile(path: string): Promise<LoadResult> {
  return invoke('load_log_file', { path });
}

export function closeSession(sessionId: string): Promise<void> {
  return invoke('close_session', { sessionId });
}

export function getLines(request: LineRequest): Promise<LineWindow> {
  return invoke('get_lines', { request });
}

export function searchLogs(
  sessionId: string,
  query: SearchQuery,
): Promise<SearchSummary> {
  return invoke('search_logs', { sessionId, query });
}

// ---------------------------------------------------------------------------
// Phase 2 — Pipeline / Processors
// ---------------------------------------------------------------------------

export function runPipeline(
  sessionId: string,
  processorIds: string[],
  anonymize = false,
): Promise<PipelineRunSummary[]> {
  return invoke('run_pipeline', { sessionId, processorIds, anonymize });
}

export function stopPipeline(): Promise<void> {
  return invoke('stop_pipeline');
}

export function setSessionPipelineMeta(
  sessionId: string,
  activeProcessorIds: string[],
  disabledProcessorIds: string[],
): Promise<void> {
  return invoke('set_session_pipeline_meta', { sessionId, activeProcessorIds, disabledProcessorIds });
}

export function listProcessors(): Promise<ProcessorSummary[]> {
  return invoke('list_processors');
}

export function loadProcessorYaml(yaml: string): Promise<ProcessorSummary> {
  return invoke('load_processor_yaml', { yaml });
}

export function loadProcessorFromFile(path: string): Promise<ProcessorSummary> {
  return invoke('load_processor_from_file', { path });
}

export function uninstallProcessor(processorId: string): Promise<void> {
  return invoke('uninstall_processor', { processorId });
}

export function getProcessorVars(
  sessionId: string,
  processorId: string,
): Promise<Record<string, unknown>> {
  return invoke('get_processor_vars', { sessionId, processorId });
}

export function getMatchedLines(
  sessionId: string,
  processorId: string,
): Promise<MatchedLine[]> {
  return invoke('get_matched_lines', { sessionId, processorId });
}

// ---------------------------------------------------------------------------
// Phase 3 — Charts
// ---------------------------------------------------------------------------

export function getChartData(
  sessionId: string,
  processorId: string,
): Promise<ChartData[]> {
  return invoke('get_chart_data', { sessionId, processorId });
}

export function getTimelineData(
  sessionId: string,
  processorIds: string[],
): Promise<TimelineSeriesData[]> {
  return invoke('get_timeline_data', { sessionId, processorIds });
}

// ---------------------------------------------------------------------------
// Phase 5 — Dumpstate metadata + section index
// ---------------------------------------------------------------------------

export function getDumpstateMetadata(sessionId: string): Promise<DumpstateMetadata> {
  return invoke('get_dumpstate_metadata', { sessionId });
}

export function getSections(sessionId: string): Promise<SectionInfo[]> {
  return invoke('get_sections', { sessionId });
}


// ---------------------------------------------------------------------------
// Phase 4 — Registry
// ---------------------------------------------------------------------------

export function fetchRegistry(registryUrl?: string): Promise<RegistryEntry[]> {
  return invoke('fetch_registry', { registryUrl: registryUrl ?? null });
}

export function installFromRegistry(entry: RegistryEntry): Promise<ProcessorSummary> {
  return invoke('install_from_registry', { entry });
}

// ---------------------------------------------------------------------------
// PII Anonymizer
// ---------------------------------------------------------------------------

export function getAnonymizerConfig(): Promise<AnonymizerConfig> {
  return invoke('get_anonymizer_config');
}

export function setAnonymizerConfig(config: AnonymizerConfig): Promise<void> {
  return invoke('set_anonymizer_config', { config });
}

export function testAnonymizer(text: string): Promise<AnonymizerTestResult> {
  return invoke('test_anonymizer', { text });
}

export function getPiiMappings(sessionId: string): Promise<Record<string, string>> {
  return invoke('get_pii_mappings', { sessionId });
}

// ---------------------------------------------------------------------------
// StateTracker query commands
// ---------------------------------------------------------------------------

export function getStateAtLine(
  sessionId: string,
  trackerId: string,
  lineNum: number,
): Promise<StateSnapshot> {
  return invoke('get_state_at_line', { sessionId, trackerId, lineNum });
}

export function getStateTransitions(
  sessionId: string,
  trackerId: string,
): Promise<StateTransition[]> {
  return invoke('get_state_transitions', { sessionId, trackerId });
}

export function getAllTransitionLines(
  sessionId: string,
): Promise<Record<string, number[]>> {
  return invoke('get_all_transition_lines', { sessionId });
}

export function getMcpStatus(): Promise<McpStatus> {
  return invoke('get_mcp_status');
}

// ---------------------------------------------------------------------------
// Correlator query commands
// ---------------------------------------------------------------------------

export function getCorrelatorEvents(
  sessionId: string,
  correlatorId: string,
): Promise<CorrelatorResult> {
  return invoke('get_correlator_events', { sessionId, correlatorId });
}

export function setMcpAnonymize(enabled: boolean): Promise<void> {
  return invoke('set_mcp_anonymize', { enabled });
}

// ---------------------------------------------------------------------------
// Filter commands (Phase 1)
// ---------------------------------------------------------------------------

export function createFilter(
  sessionId: string,
  criteria: FilterCriteria,
): Promise<FilterCreateResult> {
  return invoke('create_filter', { sessionId, criteria });
}

export function getFilteredLines(
  filterId: string,
  offset: number,
  count: number,
): Promise<FilteredLinesResult> {
  return invoke('get_filtered_lines', { filterId, offset, count });
}

export function cancelFilter(filterId: string): Promise<void> {
  return invoke('cancel_filter', { filterId });
}

export function getFilterInfo(filterId: string): Promise<FilterInfo> {
  return invoke('get_filter_info', { filterId });
}

export function closeFilter(filterId: string): Promise<void> {
  return invoke('close_filter', { filterId });
}

// ---------------------------------------------------------------------------
// Session metadata (Phase 1B)
// ---------------------------------------------------------------------------

export function getSessionMetadata(sessionId: string): Promise<SessionMetadata> {
  return invoke('get_session_metadata', { sessionId });
}

// ---------------------------------------------------------------------------
// Bookmark commands (Phase 2)
// ---------------------------------------------------------------------------

export async function createBookmark(
  sessionId: string,
  lineNumber: number,
  label: string,
  note: string,
  createdBy: CreatedBy,
  lineNumberEnd?: number,
  snippet?: string[],
  category?: string,
  tags?: string[],
): Promise<Bookmark> {
  return invoke('create_bookmark', {
    sessionId,
    lineNumber,
    label,
    note,
    createdBy,
    lineNumberEnd: lineNumberEnd ?? null,
    snippet: snippet ?? null,
    category: category ?? null,
    tags: tags ?? null,
  });
}

export function listBookmarks(sessionId: string): Promise<Bookmark[]> {
  return invoke('list_bookmarks', { sessionId });
}

export async function updateBookmark(
  sessionId: string,
  bookmarkId: string,
  label?: string,
  note?: string,
  category?: string,
  tags?: string[],
): Promise<Bookmark> {
  return invoke('update_bookmark', {
    sessionId,
    bookmarkId,
    label: label ?? null,
    note: note ?? null,
    category: category ?? null,
    tags: tags ?? null,
  });
}

export function deleteBookmark(sessionId: string, bookmarkId: string): Promise<void> {
  return invoke('delete_bookmark', { sessionId, bookmarkId });
}

// ---------------------------------------------------------------------------
// Analysis commands (Phase 2)
// ---------------------------------------------------------------------------

export function publishAnalysis(
  sessionId: string,
  title: string,
  sections: AnalysisSection[],
): Promise<AnalysisArtifact> {
  return invoke('publish_analysis', { sessionId, title, sections });
}

export function updateAnalysis(
  sessionId: string,
  artifactId: string,
  title?: string,
  sections?: AnalysisSection[],
): Promise<AnalysisArtifact> {
  return invoke('update_analysis', {
    sessionId,
    artifactId,
    title: title ?? null,
    sections: sections ?? null,
  });
}

export function listAnalyses(sessionId: string): Promise<AnalysisArtifact[]> {
  return invoke('list_analyses', { sessionId });
}

export function getAnalysis(sessionId: string, artifactId: string): Promise<AnalysisArtifact> {
  return invoke('get_analysis', { sessionId, artifactId });
}

export function deleteAnalysis(sessionId: string, artifactId: string): Promise<void> {
  return invoke('delete_analysis', { sessionId, artifactId });
}

// ---------------------------------------------------------------------------
// Watch commands (Phase 4)
// ---------------------------------------------------------------------------

export function createWatch(
  sessionId: string,
  criteria: FilterCriteria,
): Promise<WatchInfo> {
  return invoke('create_watch', { sessionId, criteria });
}

export function cancelWatch(sessionId: string, watchId: string): Promise<void> {
  return invoke('cancel_watch', { sessionId, watchId });
}

export function listWatches(sessionId: string): Promise<WatchInfo[]> {
  return invoke('list_watches', { sessionId });
}

// ---------------------------------------------------------------------------
// Source management (Phase 2 Marketplace)
// ---------------------------------------------------------------------------

export function listSources(): Promise<Source[]> {
  return invoke('list_sources');
}

export function addSource(source: Source): Promise<void> {
  return invoke('add_source', { source });
}

export function removeSource(sourceName: string): Promise<void> {
  return invoke('remove_source', { sourceName });
}

export function fetchMarketplace(sourceName: string): Promise<MarketplaceFetchResult> {
  return invoke('fetch_marketplace_for_source', { sourceName });
}

export function checkUpdates(): Promise<UpdateCheckResult> {
  return invoke('check_updates');
}

export function updateProcessor(
  processorId: string,
  entry: { name: string; path: string; version: string; sha256: string },
): Promise<UpdateResult> {
  return invoke('update_processor', {
    processorId,
    entryName: entry.name,
    entryPath: entry.path,
    entryVersion: entry.version,
    entrySha256: entry.sha256,
  });
}

export function updateAllFromSource(sourceName: string): Promise<UpdateResult[]> {
  return invoke('update_all_from_source', { sourceName });
}

export function getPendingUpdates(): Promise<UpdateAvailable[]> {
  return invoke('get_pending_updates');
}

export function saveSourcesToDisk(): Promise<void> {
  return invoke('save_sources_to_disk');
}

export function installFromMarketplace(
  sourceName: string,
  entry: { id: string; name: string; path: string; version: string; sha256: string },
): Promise<ProcessorSummary> {
  return invoke('install_from_marketplace', {
    sourceName,
    entryId: entry.id,
    entryName: entry.name,
    entryPath: entry.path,
    entryVersion: entry.version,
    entrySha256: entry.sha256,
  });
}

// ---------------------------------------------------------------------------
// Text file I/O
// ---------------------------------------------------------------------------

export function readTextFile(path: string): Promise<string> {
  return invoke('read_text_file', { path });
}

export function writeTextFile(path: string, content: string): Promise<void> {
  return invoke('write_text_file', { path, content });
}

// ---------------------------------------------------------------------------
// File associations
// ---------------------------------------------------------------------------

export function getFileAssociationStatus(): Promise<FileAssocEntry[]> {
  return invoke('get_file_association_status');
}

export function setFileAssociation(ext: string, enabled: boolean): Promise<void> {
  return invoke('set_file_association', { ext, enabled });
}

export function openDefaultAppsSettings(): Promise<void> {
  return invoke('open_default_apps_settings');
}

export function getStartupFile(): Promise<string | null> {
  return invoke('get_startup_file');
}

// ---------------------------------------------------------------------------
// Capture save (Phase 4)
// ---------------------------------------------------------------------------

export function saveLiveCapture(
  sessionId: string,
  outputPath: string,
): Promise<number> {
  return invoke('save_live_capture', { sessionId, outputPath });
}

// ---------------------------------------------------------------------------
// Export commands (T4 + T5)
// ---------------------------------------------------------------------------

export function getExportSessionInfo(sessionId: string): Promise<ExportSessionInfo> {
  return invoke('get_export_session_info', { sessionId });
}

export function exportSession(sessionId: string, options: ExportOptions): Promise<void> {
  return invoke('export_session', { sessionId, options });
}

// ---------------------------------------------------------------------------
// Pack commands
// ---------------------------------------------------------------------------

export function listPacks(): Promise<PackSummary[]> {
  return invoke('list_packs');
}

export function installPackFromMarketplace(
  sourceName: string,
  packEntry: {
    id: string;
    name: string;
    version: string;
    description?: string;
    path: string;
    tags: string[];
    sha256: string;
    category?: string;
    processor_ids: string[];
  },
): Promise<PackSummary> {
  return invoke('install_pack_from_marketplace', { sourceName, packEntry });
}

export function uninstallPackFromMarketplace(
  sourceName: string,
  packId: string,
): Promise<void> {
  return invoke('uninstall_pack_from_marketplace', { sourceName, packId });
}

export function uninstallPack(packId: string): Promise<void> {
  return invoke('uninstall_pack', { packId });
}

// ---------------------------------------------------------------------------
// MCP bridge control
// ---------------------------------------------------------------------------

export function startMcpBridge(): Promise<void> {
  return invoke('start_mcp_bridge');
}

export function stopMcpBridge(): Promise<void> {
  return invoke('stop_mcp_bridge');
}
