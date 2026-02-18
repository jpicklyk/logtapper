import { useState, useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ProcessorSummary, PipelineRunSummary, PipelineProgress } from '../bridge/types';
import {
  listProcessors,
  loadProcessorYaml,
  uninstallProcessor,
  runPipeline,
  stopPipeline,
  getProcessorVars,
} from '../bridge/commands';

export interface PipelineState {
  processors: ProcessorSummary[];
  activeProcessorIds: Set<string>;
  running: boolean;
  progress: Record<string, PipelineProgress>;
  lastResults: PipelineRunSummary[];
  runCount: number;
  error: string | null;

  loadProcessors: () => Promise<void>;
  installFromYaml: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => Promise<void>;
  toggleProcessor: (id: string) => void;
  run: (sessionId: string, anonymize?: boolean) => Promise<void>;
  stop: () => Promise<void>;
  getVars: (sessionId: string, processorId: string) => Promise<Record<string, unknown>>;
}

export function usePipeline(): PipelineState {
  const [processors, setProcessors] = useState<ProcessorSummary[]>([]);
  const [activeProcessorIds, setActiveProcessorIds] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, PipelineProgress>>({});
  const [lastResults, setLastResults] = useState<PipelineRunSummary[]>([]);
  const [runCount, setRunCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Subscribe to pipeline-progress events
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

  const loadProcessors = useCallback(async () => {
    try {
      const list = await listProcessors();
      setProcessors(list);
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
      setActiveProcessorIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const toggleProcessor = useCallback((id: string) => {
    setActiveProcessorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const run = useCallback(
    async (sessionId: string, anonymize = false) => {
      if (activeProcessorIds.size === 0) return;
      setRunning(true);
      setProgress({});
      setError(null);
      try {
        const ids = Array.from(activeProcessorIds);
        const results = await runPipeline(sessionId, ids, anonymize);
        setLastResults(results);
        setRunCount((n) => n + 1);
      } catch (e) {
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [activeProcessorIds],
  );

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
    activeProcessorIds,
    running,
    progress,
    lastResults,
    runCount,
    error,
    loadProcessors,
    installFromYaml,
    removeProcessor,
    toggleProcessor,
    run,
    stop,
    getVars,
  };
}
