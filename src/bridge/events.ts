import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AdbBatchPayload, AdbProcessorUpdate, AdbStreamStopped, FileIndexProgress, FileIndexComplete, SearchProgress, FilterProgress, BookmarkUpdateEvent, AnalysisUpdateEvent } from './types';

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
// Progressive file-indexing events
// ---------------------------------------------------------------------------

export function onFileIndexProgress(
  cb: (payload: FileIndexProgress) => void,
): Promise<UnlistenFn> {
  return listen<FileIndexProgress>('file-index-progress', (e) => cb(e.payload));
}

export function onFileIndexComplete(
  cb: (payload: FileIndexComplete) => void,
): Promise<UnlistenFn> {
  return listen<FileIndexComplete>('file-index-complete', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Search progress events (chunked streaming results)
// ---------------------------------------------------------------------------

export function onSearchProgress(
  cb: (payload: SearchProgress) => void,
): Promise<UnlistenFn> {
  return listen<SearchProgress>('search-progress', (e) => cb(e.payload));
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
// Filter progress events (Phase 1)
// ---------------------------------------------------------------------------

export function onFilterProgress(
  cb: (payload: FilterProgress) => void,
): Promise<UnlistenFn> {
  return listen<FilterProgress>('filter-progress', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Bookmark update events (Phase 2)
// ---------------------------------------------------------------------------

export function onBookmarkUpdate(
  cb: (payload: BookmarkUpdateEvent) => void,
): Promise<UnlistenFn> {
  return listen<BookmarkUpdateEvent>('bookmark-update', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Analysis update events (Phase 2)
// ---------------------------------------------------------------------------

export function onAnalysisUpdate(
  cb: (payload: AnalysisUpdateEvent) => void,
): Promise<UnlistenFn> {
  return listen<AnalysisUpdateEvent>('analysis-update', (e) => cb(e.payload));
}

