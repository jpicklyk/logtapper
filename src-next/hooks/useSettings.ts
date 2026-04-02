import { useState, useCallback } from 'react';
import { storageGetJSON, storageSetJSON, storageRemove } from '../utils';

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
  /** Whether the MCP HTTP bridge (port 40404) is enabled. */
  mcpBridgeEnabled: boolean;
}

const STORAGE_KEY = 'logtapper_settings';

export const DEFAULT_BOOKMARK_CATEGORIES: BookmarkCategoryDef[] = [
  { id: 'error',        label: 'Errors',        color: 'var(--danger)' },
  { id: 'warning',      label: 'Warnings',      color: 'var(--level-warning)' },
  { id: 'state-change', label: 'State Changes',  color: 'var(--accent)' },
  { id: 'timing',       label: 'Timing',         color: 'var(--success)' },
  { id: 'observation',  label: 'Observations',   color: 'var(--text-muted)' },
  { id: 'custom',       label: 'Other',          color: 'var(--text-dimmed)' },
];

export const SETTING_DEFAULTS: AppSettings = {
  streamBackendLineMax: 500_000,
  fileCacheBudget: 250_000,
  autoReconnectStream: true,
  bookmarkCategories: DEFAULT_BOOKMARK_CATEGORIES,
  mcpBridgeEnabled: false,
};

/** Map of old default hex colors → new theme-aware token references.
 *  Only migrates values that match the original defaults — custom user picks are preserved. */
const LEGACY_COLOR_MIGRATION: Record<string, string> = {
  '#f85149': 'var(--danger)',
  '#d29922': 'var(--level-warning)',
  '#58a6ff': 'var(--accent)',
  '#3fb950': 'var(--success)',
  '#8b949e': 'var(--text-muted)',
  '#484f58': 'var(--text-dimmed)',
};

function migrateBookmarkColors(cats: BookmarkCategoryDef[]): BookmarkCategoryDef[] {
  let changed = false;
  const migrated = cats.map((cat) => {
    const replacement = LEGACY_COLOR_MIGRATION[cat.color];
    if (replacement) {
      changed = true;
      return { ...cat, color: replacement };
    }
    return cat;
  });
  return changed ? migrated : cats;
}

export function loadSettings(): AppSettings {
  const stored = storageGetJSON<Partial<AppSettings>>(STORAGE_KEY, {});

  // Migrate legacy hex bookmark colors to theme-aware tokens
  if (stored.bookmarkCategories) {
    const migrated = migrateBookmarkColors(stored.bookmarkCategories);
    if (migrated !== stored.bookmarkCategories) {
      stored.bookmarkCategories = migrated;
      storageSetJSON(STORAGE_KEY, { ...SETTING_DEFAULTS, ...stored });
    }
  }

  return { ...SETTING_DEFAULTS, ...stored };
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
        storageSetJSON(STORAGE_KEY, next);
        return next;
      });
    },
    [],
  );

  const resetSettings = useCallback(() => {
    setSettings({ ...SETTING_DEFAULTS });
    storageRemove(STORAGE_KEY);
  }, []);

  return { settings, updateSetting, resetSettings };
}
