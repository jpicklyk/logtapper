import { useState, useCallback } from 'react';

export interface BookmarkCategoryDef {
  id: string;
  label: string;
  color: string;
}

export interface AppSettings {
  /** Max raw log lines kept in the backend ADB buffer. Oldest lines are evicted above this. */
  streamBackendLineMax: number;
  /** Total line budget for the CacheManager (distributed across views). Covers both file and streaming modes. */
  fileCacheBudget: number;
  /** Automatically reconnect the ADB stream when it stops due to EOF (e.g. screen unlock USB reset). */
  autoReconnectStream: boolean;
  /** User-configurable bookmark categories with display labels and colors. */
  bookmarkCategories: BookmarkCategoryDef[];
}

const STORAGE_KEY = 'logtapper_settings';

export const DEFAULT_BOOKMARK_CATEGORIES: BookmarkCategoryDef[] = [
  { id: 'error',        label: 'Errors',        color: '#f85149' },
  { id: 'warning',      label: 'Warnings',      color: '#d29922' },
  { id: 'state-change', label: 'State Changes',  color: '#58a6ff' },
  { id: 'timing',       label: 'Timing',         color: '#3fb950' },
  { id: 'observation',  label: 'Observations',   color: '#8b949e' },
  { id: 'custom',       label: 'Other',          color: '#484f58' },
];

export const SETTING_DEFAULTS: AppSettings = {
  streamBackendLineMax: 500_000,
  fileCacheBudget: 100_000,
  autoReconnectStream: true,
  bookmarkCategories: DEFAULT_BOOKMARK_CATEGORIES,
};

export function loadSettings(): AppSettings {
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
          // localStorage unavailable -- continue without persistence
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
