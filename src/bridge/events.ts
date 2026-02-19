import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AdbBatchPayload, AdbProcessorUpdate, AdbStreamStopped } from './types';

// ---------------------------------------------------------------------------
// ADB streaming events
// ---------------------------------------------------------------------------

export function onAdbBatch(
  cb: (payload: AdbBatchPayload) => void,
): Promise<UnlistenFn> {
  return listen<AdbBatchPayload>('adb-batch', (e) => cb(e.payload));
}

export function onAdbProcessorUpdate(
  cb: (payload: AdbProcessorUpdate) => void,
): Promise<UnlistenFn> {
  return listen<AdbProcessorUpdate>('adb-processor-update', (e) => cb(e.payload));
}

export function onAdbStreamStopped(
  cb: (payload: AdbStreamStopped) => void,
): Promise<UnlistenFn> {
  return listen<AdbStreamStopped>('adb-stream-stopped', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Phase 1 — Progress
// ---------------------------------------------------------------------------

export interface ProgressPayload {
  sessionId: string;
  processed: number;
  total: number;
  phase: string;
}

export function onProgress(
  cb: (p: ProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<ProgressPayload>('pipeline-progress', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Phase 2 — Pipeline results
// ---------------------------------------------------------------------------

export interface PipelineResultPayload {
  processorId: string;
  matchLineNums: number[];
  batchIndex: number;
  done: boolean;
}

export function onPipelineResults(
  cb: (p: PipelineResultPayload) => void,
): Promise<UnlistenFn> {
  return listen<PipelineResultPayload>('pipeline-results', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Phase 3 — Chart updates
// ---------------------------------------------------------------------------

export function onChartUpdate(
  processorId: string,
  chartId: string,
  cb: (data: unknown) => void,
): Promise<UnlistenFn> {
  return listen(`chart-update-${processorId}-${chartId}`, (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Phase 4 — Claude streaming
// ---------------------------------------------------------------------------

export interface ClaudeStreamPayload {
  token: string;
  done: boolean;
}

export function onClaudeStream(
  cb: (p: ClaudeStreamPayload) => void,
): Promise<UnlistenFn> {
  return listen<ClaudeStreamPayload>('claude-stream', (e) => cb(e.payload));
}
