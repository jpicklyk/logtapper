import { invoke } from '@tauri-apps/api/core';
import type {
  LineRequest,
  LineWindow,
  LoadResult,
  SearchQuery,
  SearchSummary,
  ProcessorSummary,
  PipelineRunSummary,
  MatchedLine,
  ChartData,
  RegistryEntry,
  DumpstateMetadata,
  SectionInfo,
  AdbDevice,
  AnonymizerConfig,
  AnonymizerTestResult,
  StateSnapshot,
  StateTransition,
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
): Promise<LoadResult> {
  return invoke('start_adb_stream', {
    deviceId: deviceId ?? null,
    packageFilter: packageFilter ?? null,
    activeProcessorIds,
    maxRawLines: maxRawLines ?? null,
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

// ---------------------------------------------------------------------------
// Phase 4 — Claude
// ---------------------------------------------------------------------------

export function setClaudeApiKey(apiKey: string): Promise<void> {
  return invoke('set_claude_api_key', { apiKey });
}

export function claudeAnalyze(
  sessionId: string,
  processorId: string | null,
  userMessage: string,
): Promise<void> {
  return invoke('claude_analyze', { sessionId, processorId, userMessage });
}

export function claudeGenerateProcessor(
  description: string,
  sampleLines: string[],
): Promise<string> {
  return invoke('claude_generate_processor', { description, sampleLines });
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
