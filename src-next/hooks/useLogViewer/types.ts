import type { MutableRefObject } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { LoadResult } from '../../bridge/types';
import type { FilterNode } from '../../filter';

/**
 * Refs that cross sub-hook boundaries. Created once in the orchestrator,
 * passed to every sub-hook so they share stable mutable state without
 * causing re-renders.
 */
export interface SharedLogViewerRefs {
  // Synced from context on every render (orchestrator writes, all sub-hooks read)
  sessionRef: MutableRefObject<LoadResult | null>;
  activeLogPaneIdRef: MutableRefObject<string | null>;
  paneSessionMapRef: MutableRefObject<Map<string, string>>;
  sessionsRef: MutableRefObject<Map<string, LoadResult>>;

  // Streaming state (useStreamSession writes; useFileSession + useFilterScan read)
  streamingPaneIdRef: MutableRefObject<string | null>;
  streamingSessionIdRef: MutableRefObject<string | null>;
  isStreamingRef: MutableRefObject<boolean>;
  streamDeviceSerialRef: MutableRefObject<string | null>;
  adbStoppedUnlistenRef: MutableRefObject<UnlistenFn | null>;

  // Filter AST (useFilterScan writes; useStreamSession reads in handleAdbBatch)
  filterAstRef: MutableRefObject<FilterNode | null>;
  // Session the current filter AST belongs to. handleAdbBatch must only apply
  // the AST to batches from this session — the focused session (sessionRef) can
  // be a different pane's session while a stream is running.
  filterAstSessionIdRef: MutableRefObject<string | null>;
  packagePidsRef: MutableRefObject<Map<string, number[]>>;

  // Incremental filter bridge: useFilterScan writes a stable callback here;
  // useStreamSession calls it from handleAdbBatch without a setState dep.
  appendFilterMatchesRef: MutableRefObject<((sessionId: string, lineNums: number[]) => void) | null>;

  // Orchestrator writes this after defining resetSessionState so useStreamSession
  // can call it from startStream without being in the hook signature.
  resetSessionStateRef: MutableRefObject<() => void>;
}
