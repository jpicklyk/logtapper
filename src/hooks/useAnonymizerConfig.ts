import { useState, useCallback, useEffect } from 'react';
import type { AnonymizerConfig, DetectorEntry, PatternEntry } from '../bridge/types';
import { getAnonymizerConfig, setAnonymizerConfig } from '../bridge/commands';

export interface UseAnonymizerConfigResult {
  config: AnonymizerConfig | null;
  loading: boolean;
  updateConfig: (next: AnonymizerConfig) => Promise<void>;
  toggleDetector: (id: string, enabled: boolean) => void;
  togglePattern: (detectorId: string, patternIndex: number, enabled: boolean) => void;
  addPatternToDetector: (detectorId: string, label: string, regex: string) => void;
  removePattern: (detectorId: string, patternIndex: number) => void;
  addCustomDetector: (label: string, regex: string) => void;
  removeCustomDetector: (id: string) => void;
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useAnonymizerConfig(): UseAnonymizerConfigResult {
  const [config, setConfig] = useState<AnonymizerConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAnonymizerConfig()
      .then(setConfig)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const updateConfig = useCallback(async (next: AnonymizerConfig) => {
    await setAnonymizerConfig(next);
    setConfig(next);
  }, []);

  const toggleDetector = useCallback((id: string, enabled: boolean) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        detectors: prev.detectors.map((d) =>
          d.id === id ? { ...d, enabled } : d
        ),
      };
      setAnonymizerConfig(next).catch(console.error);
      return next;
    });
  }, []);

  const togglePattern = useCallback((detectorId: string, patternIndex: number, enabled: boolean) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        detectors: prev.detectors.map((d) => {
          if (d.id !== detectorId) return d;
          const patterns = d.patterns.map((p, i) =>
            i === patternIndex ? { ...p, enabled } : p
          );
          return { ...d, patterns };
        }),
      };
      setAnonymizerConfig(next).catch(console.error);
      return next;
    });
  }, []);

  const addPatternToDetector = useCallback((detectorId: string, label: string, regex: string) => {
    const newPattern: PatternEntry = { label, regex, builtin: false, enabled: true };
    setConfig((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        detectors: prev.detectors.map((d) =>
          d.id === detectorId
            ? { ...d, patterns: [...d.patterns, newPattern] }
            : d
        ),
      };
      setAnonymizerConfig(next).catch(console.error);
      return next;
    });
  }, []);

  const removePattern = useCallback((detectorId: string, patternIndex: number) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        detectors: prev.detectors.map((d) => {
          if (d.id !== detectorId) return d;
          const patterns = d.patterns.filter((_, i) => i !== patternIndex);
          return { ...d, patterns };
        }),
      };
      setAnonymizerConfig(next).catch(console.error);
      return next;
    });
  }, []);

  const addCustomDetector = useCallback((label: string, regex: string) => {
    const newDetector: DetectorEntry = {
      id: generateId(),
      label,
      tier: 'tier1',
      fpHint: 'custom',
      enabled: true,
      patterns: [{ label: 'Pattern', regex, builtin: false, enabled: true }],
    };
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, detectors: [...prev.detectors, newDetector] };
      setAnonymizerConfig(next).catch(console.error);
      return next;
    });
  }, []);

  const removeCustomDetector = useCallback((id: string) => {
    setConfig((prev) => {
      if (!prev) return prev;
      // Prevent removing built-in detectors (known IDs)
      const BUILTIN_IDS = new Set([
        'email', 'mac', 'ipv4', 'ipv6', 'imei', 'android_id', 'serial',
        'jwt', 'api_keys', 'bearer_token', 'gaid', 'session_id', 'url_credentials', 'phone',
      ]);
      if (BUILTIN_IDS.has(id)) return prev;
      const next = {
        ...prev,
        detectors: prev.detectors.filter((d) => d.id !== id),
      };
      setAnonymizerConfig(next).catch(console.error);
      return next;
    });
  }, []);

  return {
    config,
    loading,
    updateConfig,
    toggleDetector,
    togglePattern,
    addPatternToDetector,
    removePattern,
    addCustomDetector,
    removeCustomDetector,
  };
}
