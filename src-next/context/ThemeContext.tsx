import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storageGet, storageSet } from '../utils';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  resolvedTheme: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'logtapper-theme';
const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');

function getSystemPreference(): ResolvedTheme {
  return systemQuery.matches ? 'dark' : 'light';
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolved);
}

function isValidTheme(v: string): v is ThemeMode {
  return v === 'dark' || v === 'light' || v === 'system';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = storageGet(STORAGE_KEY, 'dark');
    return isValidTheme(stored) ? stored : 'dark';
  });

  // Track system preference changes (only matters when mode is 'system')
  const [systemPref, setSystemPref] = useState<ResolvedTheme>(getSystemPreference);

  // Derive resolved theme — no separate state needed
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemPref : theme;

  // Apply theme attribute and persist on change
  useEffect(() => {
    applyTheme(resolvedTheme);
    storageSet(STORAGE_KEY, theme);
  }, [theme, resolvedTheme]);

  // Listen for system preference changes
  useEffect(() => {
    if (theme !== 'system') return;

    const handleChange = (e: MediaQueryListEvent) => {
      setSystemPref(e.matches ? 'dark' : 'light');
    };

    systemQuery.addEventListener('change', handleChange);
    return () => systemQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, resolvedTheme }),
    [theme, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
