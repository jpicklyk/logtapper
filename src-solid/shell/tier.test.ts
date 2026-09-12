import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { TIER_MIN_WIDTH, TIER_QUERIES, createTier, tierForWidth } from './tier';

/**
 * jsdom has no `matchMedia`. This shim drives the three tier queries from a
 * single width and lets a test move that width and fire `change`, which is what
 * a real browser does when a window is dragged across a threshold.
 */
function installMatchMedia(initialWidth: number) {
  let width = initialWidth;
  const lists = new Map<string, { list: MediaQueryList; listeners: Set<() => void> }>();

  const minWidthOf = (query: string) => Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);

  const factory = (query: string): MediaQueryList => {
    const existing = lists.get(query);
    if (existing) return existing.list;
    const listeners = new Set<() => void>();
    const list = {
      get matches() {
        return width >= minWidthOf(query);
      },
      media: query,
      addEventListener: (_type: string, handler: () => void) => listeners.add(handler),
      removeEventListener: (_type: string, handler: () => void) => listeners.delete(handler),
    } as unknown as MediaQueryList;
    lists.set(query, { list, listeners });
    return list;
  };

  vi.stubGlobal('matchMedia', factory);
  (window as unknown as { matchMedia: typeof factory }).matchMedia = factory;

  return {
    setWidth(next: number) {
      width = next;
      for (const { listeners } of lists.values()) for (const handler of listeners) handler();
    },
    listenerCount() {
      let total = 0;
      for (const { listeners } of lists.values()) total += listeners.size;
      return total;
    },
  };
}

/**
 * Solid flushes effects at the end of the `createRoot` update cycle, so the
 * `data-tier` write is only observable once the root callback has returned —
 * hence building outside and asserting after.
 */
function inRoot<T>(build: () => T): [T, () => void] {
  let value!: T;
  let dispose!: () => void;
  createRoot((disposer) => {
    dispose = disposer;
    value = build();
  });
  return [value, dispose];
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Partial<Window>).matchMedia;
  document.documentElement.removeAttribute('data-tier');
});

describe('tierForWidth', () => {
  it('maps each threshold to its tier, inclusive of the lower bound', () => {
    expect(tierForWidth(1280)).toBe('compact');
    expect(tierForWidth(TIER_MIN_WIDTH.standard - 1)).toBe('compact');
    expect(tierForWidth(TIER_MIN_WIDTH.standard)).toBe('standard');
    expect(tierForWidth(TIER_MIN_WIDTH.wide - 1)).toBe('standard');
    expect(tierForWidth(TIER_MIN_WIDTH.wide)).toBe('wide');
    expect(tierForWidth(TIER_MIN_WIDTH.ultrawide - 1)).toBe('wide');
    expect(tierForWidth(TIER_MIN_WIDTH.ultrawide)).toBe('ultrawide');
    expect(tierForWidth(5120)).toBe('ultrawide');
  });

  it('declares the three queries that separate the four tiers', () => {
    expect(TIER_QUERIES.standard).toBe('(min-width: 1600px)');
    expect(TIER_QUERIES.wide).toBe('(min-width: 2560px)');
    expect(TIER_QUERIES.ultrawide).toBe('(min-width: 3440px)');
  });
});

describe('createTier', () => {
  it('reads the initial tier and writes data-tier on the root', () => {
    const root = document.createElement('html');
    installMatchMedia(2600);

    const [tier, dispose] = inRoot(() => createTier(root));
    expect(tier()).toBe('wide');
    expect(root.getAttribute('data-tier')).toBe('wide');
    dispose();
  });

  it('updates on media-query change events and detaches on dispose', () => {
    const root = document.createElement('html');
    const media = installMatchMedia(1400);

    const [tier, dispose] = inRoot(() => createTier(root));
    expect(tier()).toBe('compact');
    expect(root.getAttribute('data-tier')).toBe('compact');

    media.setWidth(1600);
    expect(tier()).toBe('standard');
    expect(root.getAttribute('data-tier')).toBe('standard');

    media.setWidth(3440);
    expect(tier()).toBe('ultrawide');
    expect(root.getAttribute('data-tier')).toBe('ultrawide');

    expect(media.listenerCount()).toBe(3);
    dispose();
    expect(media.listenerCount()).toBe(0);
  });

  it('falls back to innerWidth + resize where matchMedia is missing', () => {
    const root = document.createElement('html');
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 2560, configurable: true });

    const [tier, dispose] = inRoot(() => createTier(root));
    expect(tier()).toBe('wide');

    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(tier()).toBe('compact');
    expect(root.getAttribute('data-tier')).toBe('compact');

    dispose();
    Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
  });
});
