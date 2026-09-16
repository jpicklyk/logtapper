import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLIED_THEME_STORAGE_KEY,
  applyDensity,
  applyTheme,
  createThemeController,
  DENSITY_STORAGE_KEY,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './applyTheme';

describe('resolveTheme', () => {
  it('passes concrete base themes through unchanged', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark-hc', false)).toBe('dark-hc');
    expect(resolveTheme('light-hc', true)).toBe('light-hc');
  });

  it('resolves "system" from the prefers-dark flag', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('applyTheme', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('html');
  });

  it('sets the data-theme attribute', () => {
    applyTheme(root, { base: 'dark' });
    expect(root.getAttribute('data-theme')).toBe('dark');

    applyTheme(root, { base: 'light-hc' });
    expect(root.getAttribute('data-theme')).toBe('light-hc');
  });

  it('writes overrides as inline custom properties', () => {
    applyTheme(root, { base: 'dark', overrides: { '--accent': '#ff0000', '--text': '#eeeeee' } });
    expect(root.style.getPropertyValue('--accent')).toBe('#ff0000');
    expect(root.style.getPropertyValue('--text')).toBe('#eeeeee');
  });

  it('clears overrides that are absent from a later call', () => {
    applyTheme(root, { base: 'dark', overrides: { '--accent': '#ff0000', '--text': '#eeeeee' } });
    applyTheme(root, { base: 'dark', overrides: { '--accent': '#00ff00' } });

    expect(root.style.getPropertyValue('--accent')).toBe('#00ff00');
    expect(root.style.getPropertyValue('--text')).toBe('');
  });

  it('clears every override when the next call has none', () => {
    applyTheme(root, { base: 'dark', overrides: { '--accent': '#ff0000' } });
    applyTheme(root, { base: 'light' });

    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(root.getAttribute('data-theme')).toBe('light');
  });
});

describe('applyDensity', () => {
  it('sets the data-density attribute', () => {
    const root = document.createElement('html');
    applyDensity(root, 'compact');
    expect(root.getAttribute('data-density')).toBe('compact');
    applyDensity(root, 'comfortable');
    expect(root.getAttribute('data-density')).toBe('comfortable');
  });
});

/** jsdom does not implement matchMedia — stub it the same way ThemeContext's callers work around the gap elsewhere in this codebase (see useCenterTree.test.ts). */
function installMatchMediaStub(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initialMatches;
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return {
    setMatches(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

describe('createThemeController', () => {
  let root: HTMLElement;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    root = document.createElement('html');
    localStorage.clear();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('defaults to dark and applies it to the root immediately', () => {
    installMatchMediaStub(true);
    const controller = createThemeController(root);
    expect(controller.mode()).toBe('dark');
    expect(controller.resolvedBase()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    controller.dispose();
  });

  it('reads a previously stored mode', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light-hc');
    installMatchMediaStub(true);
    const controller = createThemeController(root);
    expect(controller.mode()).toBe('light-hc');
    expect(root.getAttribute('data-theme')).toBe('light-hc');
    controller.dispose();
  });

  it('in system mode, follows prefers-color-scheme changes live', () => {
    const media = installMatchMediaStub(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const controller = createThemeController(root);

    expect(controller.resolvedBase()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');

    media.setMatches(false);
    expect(controller.resolvedBase()).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');

    controller.dispose();
  });

  it('setMode persists to localStorage and updates the root', () => {
    installMatchMediaStub(true);
    const controller = createThemeController(root);

    controller.setMode('light');
    expect(controller.mode()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');

    controller.dispose();
  });

  it('setDensity persists to localStorage and updates the root', () => {
    installMatchMediaStub(true);
    const controller = createThemeController(root);

    controller.setDensity('compact');
    expect(controller.density()).toBe('compact');
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact');
    expect(root.getAttribute('data-density')).toBe('compact');

    controller.dispose();
  });

  it('setUserOverrides writes and clears inline overrides without changing mode', () => {
    installMatchMediaStub(true);
    const controller = createThemeController(root);

    controller.setUserOverrides({ '--accent': '#123456' });
    expect(root.style.getPropertyValue('--accent')).toBe('#123456');
    expect(controller.mode()).toBe('dark');

    controller.setUserOverrides(undefined);
    expect(root.style.getPropertyValue('--accent')).toBe('');

    controller.dispose();
  });

  it('dispose stops tracking prefers-color-scheme changes', () => {
    const media = installMatchMediaStub(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const controller = createThemeController(root);

    controller.dispose();
    expect(media.listenerCount()).toBe(0);

    // A change after dispose must not throw and must not repaint the (disposed) root.
    const before = root.getAttribute('data-theme');
    media.setMatches(false);
    expect(root.getAttribute('data-theme')).toBe(before);
  });
});

describe('createThemeController user themes (B-M5)', () => {
  let root: HTMLElement;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    root = document.createElement('html');
    localStorage.clear();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('applyUserTheme paints the theme tokens, switches to its base and remembers the slug', () => {
    installMatchMediaStub(true);
    const controller = createThemeController(root);

    controller.applyUserTheme('ember', { base: 'light', tokens: { '--accent': '#ff8800' } });

    expect(root.style.getPropertyValue('--accent')).toBe('#ff8800');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(controller.mode()).toBe('light');
    expect(controller.appliedThemeSlug()).toBe('ember');
    expect(localStorage.getItem(APPLIED_THEME_STORAGE_KEY)).toBe('ember');

    controller.clearUserTheme();
    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(controller.appliedThemeSlug()).toBeNull();
    expect(localStorage.getItem(APPLIED_THEME_STORAGE_KEY)).toBeNull();
    // Clearing the user theme leaves the built-in mode the theme selected.
    expect(controller.mode()).toBe('light');

    controller.dispose();
  });

  it('re-applies the persisted slug on startup', async () => {
    installMatchMediaStub(true);
    localStorage.setItem(APPLIED_THEME_STORAGE_KEY, 'ember');
    const loadTheme = vi.fn(() => Promise.resolve({ base: 'light-hc' as const, tokens: { '--accent': '#0a4f9e' } }));

    const controller = createThemeController(root, { loadTheme });

    await vi.waitFor(() => expect(root.style.getPropertyValue('--accent')).toBe('#0a4f9e'));
    expect(loadTheme).toHaveBeenCalledWith('ember');
    expect(root.getAttribute('data-theme')).toBe('light-hc');
    expect(controller.appliedThemeSlug()).toBe('ember');

    controller.dispose();
  });

  it('never calls the loader when no slug is persisted', () => {
    installMatchMediaStub(true);
    const loadTheme = vi.fn(() => Promise.resolve({ base: 'dark' as const, tokens: {} }));

    const controller = createThemeController(root, { loadTheme });

    expect(loadTheme).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('forgets a persisted slug whose theme can no longer be read', async () => {
    installMatchMediaStub(true);
    localStorage.setItem(APPLIED_THEME_STORAGE_KEY, 'deleted');
    const loadTheme = vi.fn(() => Promise.reject(new Error('no such theme')));

    const controller = createThemeController(root, { loadTheme });

    await vi.waitFor(() => expect(localStorage.getItem(APPLIED_THEME_STORAGE_KEY)).toBeNull());
    expect(controller.appliedThemeSlug()).toBeNull();
    expect(root.getAttribute('data-theme')).toBe('dark');

    controller.dispose();
  });
});
