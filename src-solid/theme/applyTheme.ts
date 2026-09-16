/**
 * Theme application + the Solid controller that owns theme/density state.
 *
 * `resolveTheme`/`applyTheme` are framework-free (usable from index.html's
 * bootstrap or a test); `createThemeController` is the Solid-signal-backed
 * runtime piece main.tsx mounts before render.
 */
import { createEffect, createMemo, createRoot, createSignal, onCleanup, untrack } from 'solid-js';
import { readTheme } from '@bridge/commands';

export type ThemeBase = 'dark' | 'light' | 'dark-hc' | 'light-hc';
export type ThemeMode = ThemeBase | 'system';
export type Density = 'compact' | 'comfortable';

export const BASE_THEMES: readonly ThemeBase[] = ['dark', 'light', 'dark-hc', 'light-hc'];

/** Shared with src-next/context/ThemeContext.tsx's STORAGE_KEY — both UIs
 * read/write the same localStorage key so a preference set in one carries
 * to the other (same app-data dir, same browser storage origin only when
 * served from the same Tauri window — this is a best-effort convention,
 * not cross-process sync). */
export const THEME_STORAGE_KEY = 'logtapper-theme';
/** Solid-only for now — density has no React/src-next equivalent yet. */
export const DENSITY_STORAGE_KEY = 'logtapper-density';
/**
 * Slug of the user theme the user chose to *use* (Settings → Themes → Use).
 * Only the slug is persisted; the tokens themselves are re-read from the
 * backend on startup, so editing or deleting a theme is reflected on the next
 * launch instead of being frozen into localStorage.
 */
export const APPLIED_THEME_STORAGE_KEY = 'logtapper-applied-theme';

export function isThemeMode(value: string | null | undefined): value is ThemeMode {
  if (value === 'system') return true;
  return !!value && (BASE_THEMES as readonly string[]).includes(value);
}

export function isDensity(value: string | null | undefined): value is Density {
  return value === 'compact' || value === 'comfortable';
}

/** `system` resolves against the live `prefers-color-scheme` match; every other mode is already a concrete base theme. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ThemeBase {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

const OVERRIDE_KEYS_ATTR = 'data-user-theme-keys';

export interface ApplyThemeOptions {
  base: ThemeBase;
  overrides?: Record<string, string>;
}

/**
 * Sets `data-theme` and writes `overrides` as inline custom properties on
 * `root`. Overrides applied by a previous call that are absent from the new
 * set are cleared (tracked via a marker attribute) so switching to a theme
 * with fewer/no overrides doesn't leave stale inline properties shadowing
 * the stylesheet.
 */
export function applyTheme(root: HTMLElement, options: ApplyThemeOptions): void {
  root.setAttribute('data-theme', options.base);

  const previousAttr = root.getAttribute(OVERRIDE_KEYS_ATTR);
  const previousKeys = previousAttr ? previousAttr.split(',').filter(Boolean) : [];
  const nextOverrides = options.overrides ?? {};
  const nextKeys = Object.keys(nextOverrides);

  for (const key of previousKeys) {
    if (!(key in nextOverrides)) {
      root.style.removeProperty(key);
    }
  }
  for (const [key, value] of Object.entries(nextOverrides)) {
    root.style.setProperty(key, value);
  }

  if (nextKeys.length > 0) {
    root.setAttribute(OVERRIDE_KEYS_ATTR, nextKeys.join(','));
  } else {
    root.removeAttribute(OVERRIDE_KEYS_ATTR);
  }
}

/** Sets `data-density`. Independent of theme — see styles/tokens.css's density block. */
export function applyDensity(root: HTMLElement, density: Density): void {
  root.setAttribute('data-density', density);
}

/** The shape `applyUserTheme` needs — structurally `UserTheme` minus `name`. */
export interface AppliedUserTheme {
  base: ThemeBase;
  tokens: Record<string, string>;
}

export interface ThemeController {
  mode: () => ThemeMode;
  resolvedBase: () => ThemeBase;
  density: () => Density;
  userOverrides: () => Record<string, string> | undefined;
  /** Slug of the user theme currently in use, or `null` for a built-in theme. */
  appliedThemeSlug: () => string | null;
  setMode: (mode: ThemeMode) => void;
  setDensity: (density: Density) => void;
  /** Applies a user theme's token overrides on top of `resolvedBase()`. Pass `undefined` to clear back to the built-in theme. Does not change `mode`/`resolvedBase` — a user theme always declares its own `base`, applied via `setMode` separately if it differs from the current one. */
  setUserOverrides: (overrides: Record<string, string> | undefined) => void;
  /**
   * "Use this theme": the whole of what applying a user theme means — switch to
   * the theme's own `base`, paint its token overrides on top, and remember the
   * slug so the next launch restores it. The single entry point the Settings UI
   * calls; `setUserOverrides`/`setMode` stay available for finer-grained use.
   */
  applyUserTheme: (slug: string, theme: AppliedUserTheme) => void;
  /** Drops the user theme, leaving the built-in `mode()` as-is, and forgets the persisted slug. */
  clearUserTheme: () => void;
  /** Disposes the underlying Solid root (media-query listener, effects). */
  dispose: () => void;
}

export interface ThemeControllerOptions {
  /**
   * How a persisted slug is turned back into tokens on startup. Defaults to the
   * `read_theme` bridge command; injected by tests so they never touch IPC.
   */
  loadTheme?: (slug: string) => Promise<AppliedUserTheme>;
  /** Set `false` to skip the startup restore entirely (tests). */
  restore?: boolean;
}

function readAppliedSlug(): string | null {
  try {
    const stored = localStorage.getItem(APPLIED_THEME_STORAGE_KEY);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

function readStoredDensity(): Density {
  try {
    const stored = localStorage.getItem(DENSITY_STORAGE_KEY);
    return isDensity(stored) ? stored : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or storage disabled — the in-memory signal still holds the value for this session.
  }
}

function clearStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as writeStorage: storage is best-effort, the session still works.
  }
}

/**
 * Builds the live theme/density controller. Call once, before the first
 * render (main.tsx), so `data-theme`/`data-density` are correct before any
 * component paints. `system` mode tracks `prefers-color-scheme` for the
 * life of the controller.
 */
export function createThemeController(
  root: HTMLElement = document.documentElement,
  options: ThemeControllerOptions = {},
): ThemeController {
  return createRoot((dispose) => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const [mode, setModeSignal] = createSignal<ThemeMode>(readStoredMode());
    const [prefersDark, setPrefersDark] = createSignal(media.matches);
    const [density, setDensitySignal] = createSignal<Density>(readStoredDensity());
    const [userOverrides, setUserOverridesSignal] = createSignal<Record<string, string> | undefined>(undefined);
    const [appliedThemeSlug, setAppliedThemeSlug] = createSignal<string | null>(readAppliedSlug());

    const resolvedBase = createMemo(() => resolveTheme(mode(), prefersDark()));

    createEffect(() => {
      applyTheme(root, { base: resolvedBase(), overrides: userOverrides() });
    });
    createEffect(() => {
      applyDensity(root, density());
    });

    const onMediaChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener('change', onMediaChange);
    onCleanup(() => media.removeEventListener('change', onMediaChange));

    function setMode(next: ThemeMode): void {
      setModeSignal(next);
      writeStorage(THEME_STORAGE_KEY, next);
    }
    function setDensity(next: Density): void {
      setDensitySignal(next);
      writeStorage(DENSITY_STORAGE_KEY, next);
    }
    function setUserOverrides(next: Record<string, string> | undefined): void {
      setUserOverridesSignal(() => next);
    }
    function applyUserTheme(slug: string, theme: AppliedUserTheme): void {
      setMode(theme.base);
      setUserOverrides({ ...theme.tokens });
      setAppliedThemeSlug(slug);
      writeStorage(APPLIED_THEME_STORAGE_KEY, slug);
    }
    function clearUserTheme(): void {
      setUserOverrides(undefined);
      setAppliedThemeSlug(null);
      clearStorage(APPLIED_THEME_STORAGE_KEY);
    }

    // Startup restore. Only runs when a slug was actually persisted, so a host
    // without user themes (and every test that does not opt in) never reaches
    // the loader — and therefore never touches IPC.
    // Untracked: a one-time read of the slug read from storage above, not a subscription.
    const restoreSlug = options.restore === false ? null : untrack(appliedThemeSlug);
    if (restoreSlug !== null) {
      const load = options.loadTheme ?? readTheme;
      void load(restoreSlug)
        .then((theme) => {
          applyUserTheme(restoreSlug, theme);
        })
        .catch(() => {
          // The theme was deleted or is unreadable: forget it rather than
          // re-failing on every launch. The built-in `mode()` is already painted.
          clearUserTheme();
        });
    }

    return {
      mode, resolvedBase, density, userOverrides, appliedThemeSlug,
      setMode, setDensity, setUserOverrides, applyUserTheme, clearUserTheme, dispose,
    };
  });
}
