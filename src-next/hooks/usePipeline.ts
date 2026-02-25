import { useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PipelineProgress, AdbProcessorUpdate } from '../bridge/types';
import {
  listProcessors,
  loadProcessorYaml,
  uninstallProcessor,
  runPipeline,
  stopPipeline,
  getProcessorVars,
  setMcpAnonymize,
} from '../bridge/commands';
import { usePipelineContext } from '../context/PipelineContext';
import { bus } from '../events/bus';

const LS_KEY = 'logtapper_pipeline_chain';

function loadChainFromStorage(validIds: Set<string>): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter((id): id is string => typeof id === 'string' && validIds.has(id));
  } catch {
    return [];
  }
}

export interface PipelineActions {
  loadProcessors: () => Promise<void>;
  installFromYaml: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => Promise<void>;
  addToChain: (id: string) => void;
  removeFromChain: (id: string) => void;
  reorderChain: (fromIndex: number, toIndex: number) => void;
  /** @deprecated Use addToChain / removeFromChain instead */
  toggleProcessor: (id: string) => void;
  run: (sessionId: string, anonymize?: boolean) => Promise<void>;
  stop: () => Promise<void>;
  getVars: (sessionId: string, processorId: string) => Promise<Record<string, unknown>>;
  clearResults: () => void;
}

export function usePipeline(): PipelineActions {
  const { processors, pipelineChain, runCount, dispatch } = usePipelineContext();

  // Refs for stable access in callbacks without stale closures
  const processorsRef = useRef(processors);
  useEffect(() => { processorsRef.current = processors; }, [processors]);

  const pipelineChainRef = useRef(pipelineChain);
  useEffect(() => { pipelineChainRef.current = pipelineChain; }, [pipelineChain]);

  const runCountRef = useRef(runCount);
  useEffect(() => { runCountRef.current = runCount; }, [runCount]);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const adbProcUnlistenRef = useRef<UnlistenFn | null>(null);
  const chainInitializedRef = useRef(false);

  // Persist chain to localStorage and sync MCP anonymize flag whenever chain changes
  useEffect(() => {
    if (!chainInitializedRef.current) return;
    localStorage.setItem(LS_KEY, JSON.stringify(pipelineChain));
    bus.emit('pipeline:chain-changed', { chain: pipelineChain });
  }, [pipelineChain]);

  useEffect(() => {
    if (!chainInitializedRef.current) return;
    setMcpAnonymize(pipelineChain.includes('__pii_anonymizer')).catch(() => {});
  }, [pipelineChain]);

  // Subscribe to pipeline-progress events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    listen<PipelineProgress>('pipeline-progress', (event) => {
      if (cancelled) return;
      dispatch({ type: 'run:progress', current: event.payload.linesProcessed, total: event.payload.totalLines });
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
  const pendingRunCountBumpRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    listen<AdbProcessorUpdate>('adb-processor-update', (event) => {
      if (cancelled) return;
      const { processorId, matchedLines, emissionCount } = event.payload;
      dispatch({ type: 'adb:results-update', processorId, matchedLines, emissionCount });
      // Throttle runCount bump to at most once per 2s
      pendingRunCountBumpRef.current = true;
      if (!streamRunCountTimerRef.current) {
        streamRunCountTimerRef.current = setTimeout(() => {
          streamRunCountTimerRef.current = null;
          if (pendingRunCountBumpRef.current) {
            pendingRunCountBumpRef.current = false;
            dispatch({ type: 'adb:run-count-bump' });
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

  // Subscribe to session:pre-load to auto-clear results
  useEffect(() => {
    const handlePreLoad = () => { dispatch({ type: 'pre-load:cleared' }); };
    bus.on('session:pre-load', handlePreLoad);
    return () => { bus.off('session:pre-load', handlePreLoad); };
  }, [dispatch]);

  const loadProcessors = useCallback(async () => {
    try {
      const list = await listProcessors();
      if (!chainInitializedRef.current) {
        chainInitializedRef.current = true;
        const validIds = new Set(list.map((p) => p.id));
        const initialChain = loadChainFromStorage(validIds);
        dispatch({ type: 'processors:loaded', processors: list, initialChain });
      } else {
        dispatch({ type: 'processors:loaded', processors: list });
      }
    } catch (e) {
      dispatch({ type: 'error:set', error: String(e) });
    }
  }, [dispatch]);

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

  const removeFromChain = useCallback((id: string) => {
    dispatch({ type: 'chain:remove', id });
  }, [dispatch]);

  const reorderChain = useCallback((fromIndex: number, toIndex: number) => {
    dispatch({ type: 'chain:reorder', fromIndex, toIndex });
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
      if (chain.length === 0) return;
      dispatch({ type: 'run:started' });
      try {
        const results = await runPipeline(sessionId, chain, anonymize);
        // Compute newRunCount before dispatching — the reducer will set runCount to this value.
        const newRunCount = runCountRef.current + 1;
        dispatch({ type: 'run:complete', results, newRunCount });

        // Determine which processor types are active in this run
        const chainSet = new Set(chain);
        const activeProcessors = processorsRef.current.filter((p) => chainSet.has(p.id));
        bus.emit('pipeline:completed', {
          sessionId,
          runCount: newRunCount,
          hasTrackers: activeProcessors.some((p) => p.processorType === 'state_tracker'),
          hasReporters: activeProcessors.some((p) => p.processorType === 'reporter'),
          hasCorrelators: activeProcessors.some((p) => p.processorType === 'correlator'),
        });
      } catch (e) {
        dispatch({ type: 'run:failed', error: String(e) });
      }
    },
    [dispatch],
  );

  const clearResults = useCallback(() => {
    dispatch({ type: 'results:cleared' });
    bus.emit('pipeline:cleared', undefined);
  }, [dispatch]);

  const stop = useCallback(async () => {
    try {
      await stopPipeline();
    } finally {
      dispatch({ type: 'run:stopped' });
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
    removeFromChain,
    reorderChain,
    toggleProcessor,
    run,
    stop,
    getVars,
    clearResults,
  };
}
