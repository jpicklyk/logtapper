import { useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PipelineProgress, AdbProcessorUpdate } from '../bridge/types';
import { useSessionContext } from '../context/SessionContext';
import {
  listProcessors,
  loadProcessorYaml,
  uninstallProcessor,
  runPipeline,
  stopPipeline,
  getProcessorVars,
  setMcpAnonymize,
  setSessionPipelineMeta,
} from '../bridge/commands';
import { usePipelineContext } from '../context/PipelineContext';
import { storageGetJSON, storageSetJSON } from '../utils';
import { bus } from '../events/bus';
import { useWorkspaceRestore } from './useWorkspaceRestore';

const LS_KEY = 'logtapper_pipeline_chain';
const LS_DISABLED_KEY = 'logtapper_pipeline_disabled';

function loadChainFromStorage(validIds: Set<string>): string[] {
  const parsed = storageGetJSON<unknown>(LS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return (parsed as unknown[]).filter((id): id is string => typeof id === 'string' && validIds.has(id));
}

function loadDisabledFromStorage(chainIds: Set<string>): string[] {
  const parsed = storageGetJSON<unknown>(LS_DISABLED_KEY, []);
  if (!Array.isArray(parsed)) return [];
  // Only keep IDs that are actually in the chain
  return (parsed as unknown[]).filter((id): id is string => typeof id === 'string' && chainIds.has(id));
}

export interface PipelineActions {
  loadProcessors: () => Promise<void>;
  installFromYaml: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => Promise<void>;
  addToChain: (id: string) => void;
  addPackToChain: (processorIds: string[]) => void;
  removeFromChain: (id: string) => void;
  reorderChain: (fromIndex: number, toIndex: number) => void;
  toggleChainEnabled: (id: string) => void;
  /** @deprecated Use addToChain / removeFromChain instead */
  toggleProcessor: (id: string) => void;
  run: (sessionId: string, anonymize?: boolean) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  getVars: (sessionId: string, processorId: string) => Promise<Record<string, unknown>>;
  clearResults: (sessionId: string) => void;
}

export function usePipeline(): PipelineActions {
  const { processors, pipelineChain, disabledChainIds, resultsBySession, dispatch } = usePipelineContext();

  // Track the focused pane so session:pre-load can resolve the outgoing sessionId.
  const { activeLogPaneId, paneSessionMap, sessions } = useSessionContext();
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeLogPaneIdRef = useRef(activeLogPaneId);
  activeLogPaneIdRef.current = activeLogPaneId;
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  // Refs for stable access in callbacks without stale closures
  const processorsRef = useRef(processors);
  useEffect(() => { processorsRef.current = processors; }, [processors]);

  const pipelineChainRef = useRef(pipelineChain);
  useEffect(() => { pipelineChainRef.current = pipelineChain; }, [pipelineChain]);

  const disabledChainIdsRef = useRef(disabledChainIds);
  useEffect(() => { disabledChainIdsRef.current = disabledChainIds; }, [disabledChainIds]);

  const resultsBySessionRef = useRef(resultsBySession);
  resultsBySessionRef.current = resultsBySession;

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const adbProcUnlistenRef = useRef<UnlistenFn | null>(null);
  const chainInitializedRef = useRef(false);
  const hasRestoredChainRef = useRef(false);
  const metaSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist chain + disabled state to localStorage + backend whenever they change
  useEffect(() => {
    if (!chainInitializedRef.current) return;
    storageSetJSON(LS_KEY, pipelineChain);
    storageSetJSON(LS_DISABLED_KEY, disabledChainIds);
    bus.emit('pipeline:chain-changed', { chain: pipelineChain });

    // Debounced push to backend for workspace persistence (500ms)
    if (metaSyncTimerRef.current) clearTimeout(metaSyncTimerRef.current);
    metaSyncTimerRef.current = setTimeout(() => {
      metaSyncTimerRef.current = null;
      const sessionId = paneSessionMapRef.current.get(activeLogPaneIdRef.current ?? '');
      if (!sessionId) return;
      setSessionPipelineMeta(sessionId, pipelineChain, disabledChainIds).catch(() => {});
    }, 500);
  }, [pipelineChain, disabledChainIds]);

  // Push chain to backend when a session becomes active (handles the case where
  // the chain was initialized from localStorage before any session was loaded).
  useEffect(() => {
    if (!chainInitializedRef.current) return;
    const sessionId = paneSessionMap.get(activeLogPaneId ?? '');
    if (!sessionId) return;
    setSessionPipelineMeta(sessionId, pipelineChainRef.current, disabledChainIdsRef.current).catch(() => {});
  }, [activeLogPaneId, paneSessionMap]);

  // Cleanup debounce timer on unmount
  useEffect(() => () => {
    if (metaSyncTimerRef.current) clearTimeout(metaSyncTimerRef.current);
  }, []);

  useEffect(() => {
    if (!chainInitializedRef.current) return;
    setMcpAnonymize(pipelineChain.includes('__pii_anonymizer')).catch(() => {});
  }, [pipelineChain]);

  // Subscribe to pipeline-progress events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    listen<PipelineProgress>('pipeline-progress', (event) => {
      if (cancelled) return;
      const { sessionId } = event.payload;
      dispatch({ type: 'run:progress', sessionId, current: event.payload.linesProcessed, total: event.payload.totalLines });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, [dispatch]);

  // Subscribe to adb-processor-update events.
  // Results are updated immediately; runCount is throttled to at most once per 2s.
  const streamRunCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRunCountBumpRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listen<AdbProcessorUpdate>('adb-processor-update', (event) => {
      if (cancelled) return;
      const { sessionId, processorId, matchedLines, emissionCount } = event.payload;
      dispatch({ type: 'adb:results-update', sessionId, processorId, matchedLines, emissionCount });
      // Throttle runCount bump to at most once per 2s
      pendingRunCountBumpRef.current = sessionId;
      if (!streamRunCountTimerRef.current) {
        streamRunCountTimerRef.current = setTimeout(() => {
          streamRunCountTimerRef.current = null;
          const pendingSessionId = pendingRunCountBumpRef.current;
          if (pendingSessionId) {
            pendingRunCountBumpRef.current = null;
            dispatch({ type: 'adb:run-count-bump', sessionId: pendingSessionId });
          }
        }, 2000);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else adbProcUnlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      adbProcUnlistenRef.current?.();
      if (streamRunCountTimerRef.current) {
        clearTimeout(streamRunCountTimerRef.current);
        streamRunCountTimerRef.current = null;
      }
    };
  }, [dispatch]);

  // Subscribe to session:pre-load to auto-clear results for the outgoing session.
  useEffect(() => {
    const handlePreLoad = (e: { paneId: string }) => {
      if (e.paneId === activeLogPaneIdRef.current) {
        const sessionId = paneSessionMapRef.current.get(e.paneId);
        if (sessionId) {
          dispatch({ type: 'pre-load:cleared', sessionId });
        }
      }
    };
    bus.on('session:pre-load', handlePreLoad);
    return () => { bus.off('session:pre-load', handlePreLoad); };
  }, [dispatch]);

  // Subscribe to session:closed to clean up Map entry
  useEffect(() => {
    const handleSessionClosed = (e: { sessionId: string }) => {
      dispatch({ type: 'session:removed', sessionId: e.sessionId });
    };
    bus.on('session:closed', handleSessionClosed);
    return () => { bus.off('session:closed', handleSessionClosed); };
  }, [dispatch]);

  // Refresh processor list when a marketplace processor is installed or updated
  useEffect(() => {
    const refresh = () => { listProcessors().then((list) => dispatch({ type: 'processors:loaded', processors: list })).catch(() => {}); };
    bus.on('marketplace:processor-installed', refresh);
    bus.on('marketplace:processor-updated', refresh);
    return () => {
      bus.off('marketplace:processor-installed', refresh);
      bus.off('marketplace:processor-updated', refresh);
    };
  }, [dispatch]);

  const loadProcessors = useCallback(async () => {
    try {
      const list = await listProcessors();
      if (!chainInitializedRef.current) {
        chainInitializedRef.current = true;
        if (hasRestoredChainRef.current) {
          // Workspace restore already set the chain — don't overwrite from localStorage
          dispatch({ type: 'processors:loaded', processors: list });
        } else {
          const validIds = new Set(list.map((p) => p.id));
          const initialChain = loadChainFromStorage(validIds);
          const initialDisabled = loadDisabledFromStorage(new Set(initialChain));
          dispatch({ type: 'processors:loaded', processors: list, initialChain, initialDisabled });
        }
      } else {
        dispatch({ type: 'processors:loaded', processors: list });
      }
    } catch (e) {
      dispatch({ type: 'error:set', error: String(e) });
    }
  }, [dispatch, hasRestoredChainRef]);

  const installFromYaml = useCallback(async (yaml: string) => {
    dispatch({ type: 'error:clear' });
    try {
      const processor = await loadProcessorYaml(yaml);
      dispatch({ type: 'processor:installed', processor });
    } catch (e) {
      dispatch({ type: 'error:set', error: String(e) });
      throw e;
    }
  }, [dispatch]);

  const removeProcessor = useCallback(async (id: string) => {
    try {
      await uninstallProcessor(id);
      dispatch({ type: 'processor:removed', id });
    } catch (e) {
      dispatch({ type: 'error:set', error: String(e) });
    }
  }, [dispatch]);

  const addToChain = useCallback((id: string) => {
    dispatch({ type: 'chain:add', id });
  }, [dispatch]);

  const addPackToChain = useCallback((processorIds: string[]) => {
    dispatch({ type: 'chain:add-pack', processorIds });
  }, [dispatch]);

  const removeFromChain = useCallback((id: string) => {
    dispatch({ type: 'chain:remove', id });
  }, [dispatch]);

  const reorderChain = useCallback((fromIndex: number, toIndex: number) => {
    dispatch({ type: 'chain:reorder', fromIndex, toIndex });
  }, [dispatch]);

  const toggleChainEnabled = useCallback((id: string) => {
    dispatch({ type: 'chain:toggle-enabled', id });
  }, [dispatch]);

  const toggleProcessor = useCallback((id: string) => {
    // Implemented via add/remove to keep logic in the reducer
    dispatch(pipelineChainRef.current.includes(id)
      ? { type: 'chain:remove', id }
      : { type: 'chain:add', id });
  }, [dispatch]);

  const run = useCallback(
    async (sessionId: string, anonymize = false) => {
      const chain = pipelineChainRef.current;
      const disabled = new Set(disabledChainIdsRef.current);
      const effectiveChain = chain.filter((id) => !disabled.has(id));
      if (effectiveChain.length === 0) return;
      dispatch({ type: 'run:started', sessionId });
      try {
        const results = await runPipeline(sessionId, effectiveChain, anonymize);
        // Compute newRunCount before dispatching — the reducer will set runCount to this value.
        const prevState = resultsBySessionRef.current.get(sessionId);
        const newRunCount = (prevState?.runCount ?? 0) + 1;
        dispatch({ type: 'run:complete', sessionId, results, newRunCount });

        // Determine which processor types are active in this run
        const chainSet = new Set(effectiveChain);
        const activeProcessors = processorsRef.current.filter((p) => chainSet.has(p.id));
        bus.emit('pipeline:completed', {
          sessionId,
          runCount: newRunCount,
          hasTrackers: activeProcessors.some((p) => p.processorType === 'state_tracker'),
          hasReporters: activeProcessors.some((p) => p.processorType === 'reporter'),
          hasCorrelators: activeProcessors.some((p) => p.processorType === 'correlator'),
        });
      } catch (e) {
        dispatch({ type: 'run:failed', sessionId, error: String(e) });
      }
    },
    [dispatch],
  );

  // ── Workspace restore: set chain from .ltw and auto-rerun ────────────────
  const getIsIndexing = useCallback(
    (sessionId: string) => sessionsRef.current.get(sessionId)?.isIndexing ?? false,
    [],
  );
  useWorkspaceRestore(dispatch, processors, run, getIsIndexing, hasRestoredChainRef);

  const clearResults = useCallback((sessionId: string) => {
    dispatch({ type: 'results:cleared', sessionId });
    bus.emit('pipeline:cleared', undefined);
  }, [dispatch]);

  // Note: the backend `stopPipeline()` sets a single global cancellation flag —
  // it does not support per-session cancellation. The sessionId here only scopes
  // the frontend state transition. True per-session stop requires backend changes.
  const stop = useCallback(async (sessionId: string) => {
    try {
      await stopPipeline();
    } finally {
      dispatch({ type: 'run:stopped', sessionId });
    }
  }, [dispatch]);

  const getVars = useCallback(
    async (sessionId: string, processorId: string) => getProcessorVars(sessionId, processorId),
    [],
  );

  return {
    loadProcessors,
    installFromYaml,
    removeProcessor,
    addToChain,
    addPackToChain,
    removeFromChain,
    reorderChain,
    toggleChainEnabled,
    toggleProcessor,
    run,
    stop,
    getVars,
    clearResults,
  };
}
