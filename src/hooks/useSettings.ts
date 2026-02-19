import { useState, useCallback } from 'react';

export interface AppSettings {
  /** Max lines held in the frontend lineCache. Oldest entries are evicted above this. */
  streamFrontendCacheMax: number;
  /** Max raw log lines kept in the backend buffer. Oldest lines are evicted above this. */
  streamBackendLineMax: number;
}

const STORAGE_KEY = 'logtapper_settings';

export const SETTING_DEFAULTS: AppSettings = {
  streamFrontendCacheMax: 50_000,
  streamBackendLineMax: 500_000,
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...SETTING_DEFAULTS };
    return { ...SETTING_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...SETTING_DEFAULTS };
  }
}

export interface UseSettingsResult {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  resetSettings: () => void;
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const updateSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // localStorage unavailable — continue without persistence
        }
        return next;
      });
    },
    [],
  );

  const resetSettings = useCallback(() => {
    setSettings({ ...SETTING_DEFAULTS });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return { settings, updateSetting, resetSettings };
}
