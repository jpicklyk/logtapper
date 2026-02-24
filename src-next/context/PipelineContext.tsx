import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ProcessorSummary } from '../bridge/types';

interface PipelineState {
  processors: ProcessorSummary[];
  pipelineChain: string[];
  activeProcessorIds: string[];
  running: boolean;
  progress: { current: number; total: number } | null;
  lastResults: unknown[];
  runCount: number;
  error: string | null;
}

interface PipelineContextValue extends PipelineState {
  setProcessors: React.Dispatch<React.SetStateAction<ProcessorSummary[]>>;
  setPipelineChain: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveProcessorIds: React.Dispatch<React.SetStateAction<string[]>>;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setProgress: React.Dispatch<React.SetStateAction<{ current: number; total: number } | null>>;
  setLastResults: React.Dispatch<React.SetStateAction<unknown[]>>;
  setRunCount: React.Dispatch<React.SetStateAction<number>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

const PipelineContext = createContext<PipelineContextValue | null>(null);

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [processors, setProcessors] = useState<ProcessorSummary[]>([]);
  const [pipelineChain, setPipelineChain] = useState<string[]>([]);
  const [activeProcessorIds, setActiveProcessorIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [lastResults, setLastResults] = useState<unknown[]>([]);
  const [runCount, setRunCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const value = useMemo<PipelineContextValue>(() => ({
    processors,
    pipelineChain,
    activeProcessorIds,
    running,
    progress,
    lastResults,
    runCount,
    error,
    setProcessors,
    setPipelineChain,
    setActiveProcessorIds,
    setRunning,
    setProgress,
    setLastResults,
    setRunCount,
    setError,
  }), [processors, pipelineChain, activeProcessorIds, running, progress,
       lastResults, runCount, error]);

  return (
    <PipelineContext.Provider value={value}>
      {children}
    </PipelineContext.Provider>
  );
}

export function usePipelineContext(): PipelineContextValue {
  const ctx = useContext(PipelineContext);
  if (!ctx) {
    throw new Error('usePipelineContext must be used within a PipelineProvider');
  }
  return ctx;
}
