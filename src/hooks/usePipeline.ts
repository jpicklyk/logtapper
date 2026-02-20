import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ProcessorSummary, PipelineRunSummary, PipelineProgress, AdbProcessorUpdate } from '../bridge/types';
import {
  listProcessors,
  loadProcessorYaml,
  uninstallProcessor,
  runPipeline,
  stopPipeline,
  getProcessorVars,
} from '../bridge/commands';
import { arrayMove } from '@dnd-kit/sortable';

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

export interface PipelineState {
  processors: ProcessorSummary[];
  pipelineChain: string[];
  activeProcessorIds: Set<string>;
  running: boolean;
  progress: Record<string, PipelineProgress>;
  lastResults: PipelineRunSummary[];
  runCount: number;
  error: string | null;

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

export function usePipeline(): PipelineState {
  const [processors, setProcessors] = useState<ProcessorSummary[]>([]);
  const [pipelineChain, setPipelineChain] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, PipelineProgress>>({});
  const [lastResults, setLastResults] = useState<PipelineRunSummary[]>([]);
  const [runCount, setRunCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const adbProcUnlistenRef = useRef<UnlistenFn | null>(null);
  const chainInitializedRef = useRef(false);

  // Derive activeProcessorIds from pipelineChain for backward compatibility
  const activeProcessorIds = useMemo(() => new Set(pipelineChain), [pipelineChain]);

  // Persist chain to localStorage whenever it changes (after initialization)
  useEffect(() => {
    if (!chainInitializedRef.current) return;
    localStorage.setItem(LS_KEY, JSON.stringify(pipelineChain));
  }, [pipelineChain]);

  // Subscribe to pipeline-progress events (batch runs)
  useEffect(() => {
    let cancelled = false;
    listen<PipelineProgress>('pipeline-progress', (event) => {
      if (cancelled) return;
      setProgress((prev) => ({
        ...prev,
        [event.payload.processorId]: event.payload,
      }));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, []);

  // Subscribe to adb-processor-update events (continuous streaming runs).
  useEffect(() => {
    let cancelled = false;
    listen<AdbProcessorUpdate>('adb-processor-update', (event) => {
      if (cancelled) return;
      const { processorId, matchedLines, emissionCount } = event.payload;
      setLastResults((prev) => {
        const existing = prev.find((r) => r.processorId === processorId);
        const without = prev.filter((r) => r.processorId !== processorId);
        return [
          ...without,
          {
            processorId,
            matchedLines: (existing?.matchedLines ?? 0) + matchedLines,
            emissionCount: (existing?.emissionCount ?? 0) + emissionCount,
          },
        ];
      });
      setRunCount((n) => n + 1);
    }).then((fn) => {
      if (cancelled) fn();
      else adbProcUnlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      adbProcUnlistenRef.current?.();
    };
  }, []);

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
  }, []);

  const installFromYaml = useCallback(async (yaml: string) => {
    setError(null);
    try {
      const summary = await loadProcessorYaml(yaml);
      setProcessors((prev) => {
        const without = prev.filter((p) => p.id !== summary.id);
        return [...without, summary].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, []);

  const removeProcessor = useCallback(async (id: string) => {
    try {
      await uninstallProcessor(id);
      setProcessors((prev) => prev.filter((p) => p.id !== id));
      setPipelineChain((prev) => prev.filter((chainId) => chainId !== id));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const addToChain = useCallback((id: string) => {
    setPipelineChain((prev) => {
      if (prev.includes(id)) return prev;
      return [...prev, id];
    });
  }, []);

  const removeFromChain = useCallback((id: string) => {
    setPipelineChain((prev) => prev.filter((chainId) => chainId !== id));
  }, []);

  const reorderChain = useCallback((fromIndex: number, toIndex: number) => {
    setPipelineChain((prev) => arrayMove(prev, fromIndex, toIndex));
  }, []);

  // Backward-compat toggle: add if not in chain, remove if present
  const toggleProcessor = useCallback((id: string) => {
    setPipelineChain((prev) => {
      if (prev.includes(id)) return prev.filter((chainId) => chainId !== id);
      return [...prev, id];
    });
  }, []);

  const run = useCallback(
    async (sessionId: string, anonymize = false) => {
      if (pipelineChain.length === 0) return;
      setRunning(true);
      setProgress({});
      setError(null);
      try {
        const results = await runPipeline(sessionId, pipelineChain, anonymize);
        setLastResults(results);
        setRunCount((n) => n + 1);
      } catch (e) {
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [pipelineChain],
  );

  const clearResults = useCallback(() => {
    setLastResults([]);
    setProgress({});
  }, []);

  const stop = useCallback(async () => {
    try {
      await stopPipeline();
    } finally {
      setRunning(false);
    }
  }, []);

  const getVars = useCallback(
    async (sessionId: string, processorId: string) => {
      return getProcessorVars(sessionId, processorId);
    },
    [],
  );

  return {
    processors,
    pipelineChain,
    activeProcessorIds,
    running,
    progress,
    lastResults,
    runCount,
    error,
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
