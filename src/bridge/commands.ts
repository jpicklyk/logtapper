import { invoke } from '@tauri-apps/api/core';
import type {
  LineRequest,
  LineWindow,
  LoadResult,
  SearchQuery,
  SearchSummary,
  ProcessorSummary,
  PipelineRunSummary,
  ChartData,
  RegistryEntry,
} from './types';

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

export function uninstallProcessor(processorId: string): Promise<void> {
  return invoke('uninstall_processor', { processorId });
}

export function getProcessorVars(
  sessionId: string,
  processorId: string,
): Promise<Record<string, unknown>> {
  return invoke('get_processor_vars', { sessionId, processorId });
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
// Phase 4 — Registry
// ---------------------------------------------------------------------------

export function fetchRegistry(registryUrl?: string): Promise<RegistryEntry[]> {
  return invoke('fetch_registry', { registryUrl: registryUrl ?? null });
}

export function installFromRegistry(entry: RegistryEntry): Promise<ProcessorSummary> {
  return invoke('install_from_registry', { entry });
}
