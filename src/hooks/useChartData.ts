import { useState, useCallback } from 'react';
import type { ChartData } from '../bridge/types';
import { getChartData } from '../bridge/commands';

export function useChartData() {
  const [charts, setCharts] = useState<Record<string, ChartData[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCharts = useCallback(async (sessionId: string, processorId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getChartData(sessionId, processorId);
      setCharts((prev) => ({ ...prev, [`${sessionId}:${processorId}`]: data }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const getProcessorCharts = useCallback(
    (sessionId: string, processorId: string): ChartData[] => {
      return charts[`${sessionId}:${processorId}`] ?? [];
    },
    [charts],
  );

  const clearSessionCharts = useCallback((sessionId: string) => {
    setCharts((prev) => {
      const prefix = `${sessionId}:`;
      const next: Record<string, ChartData[]> = {};
      for (const key of Object.keys(prev)) {
        if (!key.startsWith(prefix)) {
          next[key] = prev[key];
        }
      }
      return next;
    });
  }, []);

  return { fetchCharts, getProcessorCharts, clearSessionCharts, loading, error };
}
