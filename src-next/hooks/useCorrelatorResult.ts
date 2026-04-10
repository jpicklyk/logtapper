import { useState, useEffect } from 'react';
import type { CorrelatorResult } from '../bridge/types';
import { getCorrelatorEvents } from '../bridge/commands';

export interface UseCorrelatorResultReturn {
  result: CorrelatorResult | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches correlator events for a given session + correlator.
 * Pass null sessionId or correlatorId to skip fetching.
 * Refetches when refreshKey changes.
 */
export function useCorrelatorResult(
  sessionId: string | null,
  correlatorId: string | null,
  refreshKey: number,
): UseCorrelatorResultReturn {
  const [result, setResult] = useState<CorrelatorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !correlatorId || refreshKey === 0) {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCorrelatorEvents(sessionId, correlatorId)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
      })
      .catch((e) => {
        if (cancelled) return;
        setResult(null);
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId, correlatorId, refreshKey]);

  return { result, loading, error };
}
