import { useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ProcessorSummary, PipelineRunSummary, PipelineProgress, AdbProcessorUpdate } from '../bridge/types';
import {
  listProcessors,
  loadProcessorYaml,
  uninstallProcessor,
  runPipeline,
  stopPipeline,
  getProcessorVars,
  setMcpAnonymize,
} from '../bridge/commands';
import { arrayMove } from '@dnd-kit/sortable';
import { usePipelineContext } from '../context/PipelineContext';
import { bus } from '../events/bus';

const LS_KEY = 'logtapper_pipeline_chain';

/** Processors that must always stay at the end of the chain. */
const PINNED_TAIL_IDS = new Set(['__pii_anonymizer']);

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
  const {
    setProcessors,
    setPipelineChain,
    setActiveProcessorIds,
    setRunning,
    setProgress,
    setLastResults,
    setRunCount,
    setError,
    pipelineChain,
  } = usePipelineContext();

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const adbProcUnlistenRef = useRef<UnlistenFn | null>(null);
  const chainInitializedRef = useRef(false);
  // Local ref for pipelineChain to avoid stale closure in callbacks
  const pipelineChainRef = useRef(pipelineChain);
  useEffect(() => { pipelineChainRef.current = pipelineChain; }, [pipelineChain]);

  // Persist chain to localStorage whenever it changes (after initialization)
  useEffect(() => {
    if (!chainInitializedRef.current) return;
    localStorage.setItem(LS_KEY, JSON.stringify(pipelineChain));
    // Also update activeProcessorIds from chain
    setActiveProcessorIds([...pipelineChain]);
    // Emit chain-changed bus event
    bus.emit('pipeline:chain-changed', { chain: pipelineChain });
  }, [pipelineChain, setActiveProcessorIds]);

  // Sync MCP anonymization flag whenever the chain changes
  useEffect(() => {
    if (!chainInitializedRef.current) return;
    setMcpAnonymize(pipelineChain.includes('__pii_anonymizer')).catch(() => {});
  }, [pipelineChain]);

  // Subscribe to pipeline-progress events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    listen<PipelineProgress>('pipeline-progress', (event) => {
      if (cancelled) return;
      setProgress({ current: event.payload.linesProcessed, total: event.payload.totalLines });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, [setProgress]);

  // Subscribe to adb-processor-update events (continuous streaming runs).
  // lastResults is updated immediately. runCount is THROTTLED to at most once per 2s.
  const streamRunCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRunCountBumpRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    listen<AdbProcessorUpdate>('adb-processor-update', (event) => {
      if (cancelled) return;
      const { processorId, matchedLines, emissionCount } = event.payload;
      setLastResults((prev: unknown[]) => {
        const typedPrev = prev as PipelineRunSummary[];
        const existing = typedPrev.find((r) => r.processorId === processorId);
        const without = typedPrev.filter((r) => r.processorId !== processorId);
        return [
          ...without,
          {
            processorId,
            matchedLines: (existing?.matchedLines ?? 0) + matchedLines,
            emissionCount: (existing?.emissionCount ?? 0) + emissionCount,
          },
        ];
      });
      // Throttle runCount
      pendingRunCountBumpRef.current = true;
      if (!streamRunCountTimerRef.current) {
        streamRunCountTimerRef.current = setTimeout(() => {
          streamRunCountTimerRef.current = null;
          if (pendingRunCountBumpRef.current) {
            pendingRunCountBumpRef.current = false;
            setRunCount((n: number) => n + 1);
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
  }, [setLastResults, setRunCount]);

  // Subscribe to session:pre-load to auto-clear results
  useEffect(() => {
    const handlePreLoad = () => {
      setLastResults([]);
      setProgress(null);
      setError(null);
    };
    bus.on('session:pre-load', handlePreLoad);
    return () => { bus.off('session:pre-load', handlePreLoad); };
  }, [setLastResults, setProgress, setError]);

  const loadProcessors = useCallback(async () => {
    try {
      const list = await listProcessors();
      setProcessors(list);
      // Initialize chain from localStorage on first load
      if (!chainInitializedRef.current) {
        chainInitializedRef.current = true;
        const validIds = new Set(list.map((p) => p.id));
        const saved = loadChainFromStorage(validIds);
        setPipelineChain(saved);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [setProcessors, setPipelineChain, setError]);

  const installFromYaml = useCallback(async (yaml: string) => {
    setError(null);
    try {
      const summary = await loadProcessorYaml(yaml);
      setProcessors((prev: ProcessorSummary[]) => {
        const without = prev.filter((p) => p.id !== summary.id);
        return [...without, summary].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, [setProcessors, setError]);

  const removeProcessor = useCallback(async (id: string) => {
    try {
      await uninstallProcessor(id);
      setProcessors((prev: ProcessorSummary[]) => prev.filter((p) => p.id !== id));
      setPipelineChain((prev: string[]) => prev.filter((chainId) => chainId !== id));
    } catch (e) {
      setError(String(e));
    }
  }, [setProcessors, setPipelineChain, setError]);

  const addToChain = useCallback((id: string) => {
    setPipelineChain((prev: string[]) => {
      if (prev.includes(id)) return prev;
      if (PINNED_TAIL_IDS.has(id)) {
        return [...prev, id];
      }
      const firstPinnedIdx = prev.findIndex((x) => PINNED_TAIL_IDS.has(x));
      if (firstPinnedIdx !== -1) {
        return [...prev.slice(0, firstPinnedIdx), id, ...prev.slice(firstPinnedIdx)];
      }
      return [...prev, id];
    });
  }, [setPipelineChain]);

  const removeFromChain = useCallback((id: string) => {
    setPipelineChain((prev: string[]) => prev.filter((chainId) => chainId !== id));
  }, [setPipelineChain]);

  const reorderChain = useCallback((fromIndex: number, toIndex: number) => {
    setPipelineChain((prev: string[]) => {
      if (PINNED_TAIL_IDS.has(prev[fromIndex])) return prev;
      const firstPinnedIdx = prev.findIndex((x) => PINNED_TAIL_IDS.has(x));
      const clampedTo =
        firstPinnedIdx !== -1 ? Math.min(toIndex, firstPinnedIdx - 1) : toIndex;
      return arrayMove(prev, fromIndex, clampedTo);
    });
  }, [setPipelineChain]);

  const toggleProcessor = useCallback((id: string) => {
    setPipelineChain((prev: string[]) => {
      if (prev.includes(id)) return prev.filter((chainId) => chainId !== id);
      return [...prev, id];
    });
  }, [setPipelineChain]);

  const run = useCallback(
    async (sessionId: string, anonymize = false) => {
      const chain = pipelineChainRef.current;
      if (chain.length === 0) return;
      setRunning(true);
      setProgress(null);
      setError(null);
      try {
        const results = await runPipeline(sessionId, chain, anonymize);
        setLastResults(results as unknown[]);
        setRunCount((n: number) => n + 1);
        // Emit pipeline:completed for downstream consumers (e.g. state tracker)
        bus.emit('pipeline:completed', {
          sessionId,
          runCount: 0, // will be set by the context
          hasTrackers: true,
          hasReporters: true,
          hasCorrelators: true,
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [setRunning, setProgress, setError, setLastResults, setRunCount],
  );

  const clearResults = useCallback(() => {
    setLastResults([]);
    setProgress(null);
    bus.emit('pipeline:cleared', undefined);
  }, [setLastResults, setProgress]);

  const stop = useCallback(async () => {
    try {
      await stopPipeline();
    } finally {
      setRunning(false);
    }
  }, [setRunning]);

  const getVars = useCallback(
    async (sessionId: string, processorId: string) => {
      return getProcessorVars(sessionId, processorId);
    },
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
