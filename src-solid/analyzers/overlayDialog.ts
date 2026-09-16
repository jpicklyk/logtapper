/**
 * The a11y wiring both analyzer overlays need, in one place (D1-L6).
 *
 * `packs/UpdatesPrompt.tsx` already does this correctly — `role="dialog"`,
 * `aria-modal`, an autofocused control, Escape to dismiss — while
 * `AnalyzerDetail` and `AddAnalyzer` were bare `<div class={styles.overlay}>`s:
 * no role, no Escape, no focus move, so a keyboard user tabbed straight past
 * the overlay into the panel behind it and had no way out. The pattern is
 * hand-rolled once here rather than a third and fourth time, and stays inside
 * `analyzers/` because `packs/` is a sibling module (nothing may import across
 * except through a barrel, and `ui/` is not this package's to extend).
 *
 * Escape is handled on the overlay root rather than on `window`: the panel can
 * have both overlays mounted at once, and a window listener would dismiss both
 * from one keypress. Focus starts inside the overlay, so the keydown lands.
 */
import { createUniqueId, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';

export interface OverlayDialog {
  /** Put on the element that names the dialog (its title). */
  labelId: string;
  /** Spread onto the overlay's root element. */
  props: {
    ref: (el: HTMLElement) => void;
    tabIndex: number;
    role: 'dialog';
    'aria-modal': 'true';
    'aria-labelledby': string;
    onKeyDown: JSX.EventHandler<HTMLElement, KeyboardEvent>;
  };
}

/** Call from an overlay component's body; `onClose` runs on Escape. */
export function createOverlayDialog(onClose: () => void): OverlayDialog {
  const labelId = createUniqueId();
  let root: HTMLElement | undefined;
  let restore: HTMLElement | null = null;

  onMount(() => {
    // Captured here, not in the component body: reading `document.activeElement`
    // during render is reading external mutable state (root CLAUDE.md).
    restore = (document.activeElement as HTMLElement | null) ?? null;
    root?.focus();
  });
  onCleanup(() => restore?.focus?.());

  return {
    labelId,
    props: {
      ref: (el: HTMLElement) => { root = el; },
      tabIndex: -1,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': labelId,
      onKeyDown: (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      },
    },
  };
}
