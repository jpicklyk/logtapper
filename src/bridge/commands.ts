import { invoke } from '@tauri-apps/api/core';
import type {
  LineRequest,
  LineWindow,
  LoadResult,
  SearchQuery,
  SearchSummary,
  RunPipelineResult,
  ChartData,
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
): Promise<RunPipelineResult[]> {
  return invoke('run_pipeline', { sessionId, processorIds });
}

export function stopPipeline(sessionId: string): Promise<void> {
  return invoke('stop_pipeline', { sessionId });
}

export function listProcessors(): Promise<import('./types').ProcessorInfo[]> {
  return invoke('list_processors');
}

export function installProcessor(id: string): Promise<void> {
  return invoke('install_processor', { id });
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
  chartId: string,
): Promise<ChartData> {
  return invoke('get_chart_data', { sessionId, processorId, chartId });
}

// ---------------------------------------------------------------------------
// Phase 4 — Claude
// ---------------------------------------------------------------------------

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
