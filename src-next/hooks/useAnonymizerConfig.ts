import { useState, useCallback, useEffect, useRef } from 'react';
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

const BUILTIN_IDS = new Set([
  'email', 'mac', 'ipv4', 'ipv6', 'imei', 'android_id', 'serial',
  'jwt', 'api_keys', 'bearer_token', 'gaid', 'session_id', 'url_credentials', 'phone',
]);

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Apply a pure transform to the current config, update local state, and
 * persist to the backend via IPC. The transform runs outside the setState
 * updater so that IPC is never called from within a React updater function
 * (which StrictMode/concurrent mode may invoke multiple times).
 */
function useConfigMutation(
  configRef: React.RefObject<AnonymizerConfig | null>,
  setConfig: React.Dispatch<React.SetStateAction<AnonymizerConfig | null>>,
) {
  return useCallback(
    (transform: (prev: AnonymizerConfig) => AnonymizerConfig) => {
      const prev = configRef.current;
      if (!prev) return;
      const next = transform(prev);
      setConfig(next);
      setAnonymizerConfig(next).catch(console.error);
    },
    [configRef, setConfig],
  );
}

export function useAnonymizerConfig(): UseAnonymizerConfigResult {
  const [config, setConfig] = useState<AnonymizerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const configRef = useRef<AnonymizerConfig | null>(null);

  // Keep ref in sync for stable callback access
  configRef.current = config;

  useEffect(() => {
    let cancelled = false;
    getAnonymizerConfig()
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch((e) => { if (!cancelled) console.error(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const applyMutation = useConfigMutation(configRef, setConfig);

  const updateConfig = useCallback(async (next: AnonymizerConfig) => {
    await setAnonymizerConfig(next);
    setConfig(next);
  }, []);

  const toggleDetector = useCallback((id: string, enabled: boolean) => {
    applyMutation((prev) => ({
      ...prev,
      detectors: prev.detectors.map((d) =>
        d.id === id ? { ...d, enabled } : d
      ),
    }));
  }, [applyMutation]);

  const togglePattern = useCallback((detectorId: string, patternIndex: number, enabled: boolean) => {
    applyMutation((prev) => ({
      ...prev,
      detectors: prev.detectors.map((d) => {
        if (d.id !== detectorId) return d;
        const patterns = d.patterns.map((p, i) =>
          i === patternIndex ? { ...p, enabled } : p
        );
        return { ...d, patterns };
      }),
    }));
  }, [applyMutation]);

  const addPatternToDetector = useCallback((detectorId: string, label: string, regex: string) => {
    const newPattern: PatternEntry = { label, regex, builtin: false, enabled: true };
    applyMutation((prev) => ({
      ...prev,
      detectors: prev.detectors.map((d) =>
        d.id === detectorId
          ? { ...d, patterns: [...d.patterns, newPattern] }
          : d
      ),
    }));
  }, [applyMutation]);

  const removePattern = useCallback((detectorId: string, patternIndex: number) => {
    applyMutation((prev) => ({
      ...prev,
      detectors: prev.detectors.map((d) => {
        if (d.id !== detectorId) return d;
        const patterns = d.patterns.filter((_, i) => i !== patternIndex);
        return { ...d, patterns };
      }),
    }));
  }, [applyMutation]);

  const addCustomDetector = useCallback((label: string, regex: string) => {
    const newDetector: DetectorEntry = {
      id: generateId(),
      label,
      tier: 'tier1',
      fpHint: 'custom',
      enabled: true,
      patterns: [{ label: 'Pattern', regex, builtin: false, enabled: true }],
    };
    applyMutation((prev) => ({
      ...prev,
      detectors: [...prev.detectors, newDetector],
    }));
  }, [applyMutation]);

  const removeCustomDetector = useCallback((id: string) => {
    if (BUILTIN_IDS.has(id)) return;
    applyMutation((prev) => ({
      ...prev,
      detectors: prev.detectors.filter((d) => d.id !== id),
    }));
  }, [applyMutation]);

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
