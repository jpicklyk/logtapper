import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';

/**
 * Layout tiers (brief §6.2). The shell never hides a surface below a tier —
 * `surfaces.ts` only demotes it to a rail or a drawer.
 */
export type Tier = 'compact' | 'standard' | 'wide' | 'ultrawide';

/** Ordered narrow → wide; `surfaces.ts` indexes its placement tuples by this. */
export const TIERS = ['compact', 'standard', 'wide', 'ultrawide'] as const;

/** Inclusive lower bound of each tier, in CSS px. */
export const TIER_MIN_WIDTH: Record<Tier, number> = {
  compact: 0,
  standard: 1600,
  wide: 2560,
  ultrawide: 3440,
};

/** The three `matchMedia` queries that separate the four tiers. */
export const TIER_QUERIES = {
  standard: `(min-width: ${TIER_MIN_WIDTH.standard}px)`,
  wide: `(min-width: ${TIER_MIN_WIDTH.wide}px)`,
  ultrawide: `(min-width: ${TIER_MIN_WIDTH.ultrawide}px)`,
} as const;

export function tierForWidth(width: number): Tier {
  if (width >= TIER_MIN_WIDTH.ultrawide) return 'ultrawide';
  if (width >= TIER_MIN_WIDTH.wide) return 'wide';
  if (width >= TIER_MIN_WIDTH.standard) return 'standard';
  return 'compact';
}

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * Live tier accessor. Mirrors the value onto `data-tier` on `root` so CSS can
 * branch without a JS round-trip, and tears its listeners down with the owner
 * (call inside a component or a `createRoot`).
 *
 * Falls back to `innerWidth` + `resize` where `matchMedia` is missing (jsdom),
 * so mounting the shell in a test needs no media-query shim.
 */
export function createTier(root: HTMLElement = document.documentElement): Accessor<Tier> {
  const lists = hasMatchMedia()
    ? ([TIER_QUERIES.standard, TIER_QUERIES.wide, TIER_QUERIES.ultrawide].map((query) =>
        window.matchMedia(query),
      ) as [MediaQueryList, MediaQueryList, MediaQueryList])
    : null;

  const read = (): Tier => {
    if (!lists) return tierForWidth(typeof window === 'undefined' ? 0 : window.innerWidth);
    if (lists[2].matches) return 'ultrawide';
    if (lists[1].matches) return 'wide';
    if (lists[0].matches) return 'standard';
    return 'compact';
  };

  const [tier, setTier] = createSignal<Tier>(read());
  const update = () => setTier(read());

  if (lists) {
    for (const list of lists) list.addEventListener('change', update);
    onCleanup(() => {
      for (const list of lists) list.removeEventListener('change', update);
    });
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', update);
    onCleanup(() => window.removeEventListener('resize', update));
  }

  createEffect(() => {
    root.setAttribute('data-tier', tier());
  });

  return tier;
}
