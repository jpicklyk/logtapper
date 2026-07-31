import { useState, useCallback } from 'react';
import type { ChartData } from '../bridge/types';
import { getChartData } from '../bridge/commands';

/** Drop every entry under a `${sessionId}:` prefix key from a per-key record. */
function withoutSessionKeys<T>(record: Record<string, T>, sessionId: string): Record<string, T> {
  const prefix = `${sessionId}:`;
  const next: Record<string, T> = {};
  for (const key of Object.keys(record)) {
    if (!key.startsWith(prefix)) next[key] = record[key];
  }
  return next;
}

export function useChartData() {
  const [charts, setCharts] = useState<Record<string, ChartData[]>>({});
  // Keyed like `charts` (`${sessionId}:${processorId}`) rather than a single
  // shared flag — concurrent fetchCharts calls for different processors (or
  // sessions) must not clear/overwrite each other's loading/error state when
  // one finishes before another.
  const [loadingByKey, setLoadingByKey] = useState<Record<string, boolean>>({});
  const [errorByKey, setErrorByKey] = useState<Record<string, string | null>>({});

  const fetchCharts = useCallback(async (sessionId: string, processorId: string) => {
    const key = `${sessionId}:${processorId}`;
    setLoadingByKey((prev) => ({ ...prev, [key]: true }));
    setErrorByKey((prev) => ({ ...prev, [key]: null }));
    try {
      const data = await getChartData(sessionId, processorId);
      setCharts((prev) => ({ ...prev, [key]: data }));
    } catch (e) {
      setErrorByKey((prev) => ({ ...prev, [key]: String(e) }));
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [key]: false }));
    }
  }, []);

  const getProcessorCharts = useCallback(
    (sessionId: string, processorId: string): ChartData[] => {
      return charts[`${sessionId}:${processorId}`] ?? [];
    },
    [charts],
  );

  const isLoading = useCallback(
    (sessionId: string, processorId: string): boolean => {
      return loadingByKey[`${sessionId}:${processorId}`] ?? false;
    },
    [loadingByKey],
  );

  const getError = useCallback(
    (sessionId: string, processorId: string): string | null => {
      return errorByKey[`${sessionId}:${processorId}`] ?? null;
    },
    [errorByKey],
  );

  const clearSessionCharts = useCallback((sessionId: string) => {
    setCharts((prev) => withoutSessionKeys(prev, sessionId));
    setLoadingByKey((prev) => withoutSessionKeys(prev, sessionId));
    setErrorByKey((prev) => withoutSessionKeys(prev, sessionId));
  }, []);

  return { fetchCharts, getProcessorCharts, clearSessionCharts, isLoading, getError };
}
