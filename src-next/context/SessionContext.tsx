import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { LoadResult } from '../bridge/types';

export interface IndexingProgress {
  linesIndexed: number;
  totalLines: number;
  done: boolean;
}

interface SessionState {
  session: LoadResult | null;
  sessionGeneration: number;
  isStreaming: boolean;
  loading: boolean;
  error: string | null;
  indexingProgress: IndexingProgress | null;
}

interface SessionContextValue extends SessionState {
  setSession: React.Dispatch<React.SetStateAction<LoadResult | null>>;
  setSessionGeneration: React.Dispatch<React.SetStateAction<number>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setIndexingProgress: React.Dispatch<React.SetStateAction<IndexingProgress | null>>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LoadResult | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexingProgress, setIndexingProgress] = useState<IndexingProgress | null>(null);

  const value = useMemo<SessionContextValue>(() => ({
    session,
    sessionGeneration,
    isStreaming,
    loading,
    error,
    indexingProgress,
    setSession,
    setSessionGeneration,
    setIsStreaming,
    setLoading,
    setError,
    setIndexingProgress,
  }), [session, sessionGeneration, isStreaming, loading, error, indexingProgress]);

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSessionContext must be used within a SessionProvider');
  }
  return ctx;
}
