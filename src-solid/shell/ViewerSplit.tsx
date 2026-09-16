/** @jsxImportSource solid-js */
import { For, Show, onCleanup } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { createTier } from './tier';
import type { Tier } from './tier';
import { isSplitTier } from './splitView';
import type { SplitView } from './splitView';
import styles from './viewerSplit.module.css';

/** Arrow-key resize step for the divider, as a ratio delta. */
const KEY_STEP = 0.02;

export interface ViewerSplitSessionOption {
  sessionId: string;
  label: string;
}

export interface ViewerSplitProps {
  split: SplitView;
  /**
   * The app's single tier subscription — see `AppShellProps.tier` (review
   * B-L6). Optional so a standalone mount still works.
   */
  tier?: Accessor<Tier>;
  /** Sessions selectable for the secondary pane — `App.tsx` excludes whatever
   *  the primary pane is showing, so the same session can never be picked in
   *  both (each pane's cursor/query state is keyed by session, not by pane). */
  secondaryOptions: () => ViewerSplitSessionOption[];
  /** The primary (always-visible) pane's content. */
  primary: () => JSX.Element;
  /** The secondary pane's content for the session currently chosen there.
   *  Only invoked while `split.active()` is true and a session is picked. */
  secondary: (sessionId: string) => JSX.Element;
}

/**
 * The viewer region's split host (S1): one pane always, a second beside it
 * once `split.active()` **and** the tier is wide/ultra-wide (`isSplitTier`).
 * Bounded to exactly two panes — see this package's task-scope note on why
 * React's arbitrary `centerTree` tree is not ported.
 *
 * Owns the split's chrome (the divider and the secondary pane's session
 * picker / close button); the panes' actual content — tab strip, query bar,
 * `LogViewer` — is supplied by the caller so this file stays session-domain
 * free, the same split `AppShell`/`surfaces.ts` draw between layout and
 * content.
 */
export function ViewerSplit(props: ViewerSplitProps) {
  let host: HTMLDivElement | undefined;

  // The split is wide/ultra-wide only (see `isSplitTier`'s doc comment).
  // `split.active()` itself stays whatever the workspace persisted — this
  // only decides whether that state renders as two panes *right now* — so
  // narrowing the window back to standard/compact never loses the choice.
  // eslint-disable-next-line solid/reactivity -- constant for this component's lifetime, by design
  const tier = props.tier ?? createTier();
  const effectivelySplit = () => props.split.active() && isSplitTier(tier());

  /**
   * Tears down the in-flight divider drag, if any.
   *
   * Set while dragging, cleared on pointerup/cancel — and called from
   * `onCleanup`, so a drag interrupted by an unmount (closing the split, a
   * workspace switch) does not leave three `window` listeners alive until the
   * next pointer release, writing a ratio into a disposed store. Re-entry
   * (a second `pointerdown` before the first `pointerup` — two pointers, or a
   * button chord) tears the first drag down instead of stacking onto it.
   * `Splitter.tsx` has the same guard; review B-L7.
   */
  let endDrag: (() => void) | null = null;
  onCleanup(() => endDrag?.());

  const dragDivider = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    endDrag?.();

    const startX = event.clientX;
    const startRatio = props.split.ratio();

    const onMove = (moveEvent: PointerEvent): void => {
      const width = host?.clientWidth ?? 0;
      if (width <= 0) return;
      props.split.setRatio(startRatio + (moveEvent.clientX - startX) / width);
    };
    const onUp = (): void => {
      endDrag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    endDrag = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onDividerKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') props.split.setRatio(props.split.ratio() - KEY_STEP);
    else if (event.key === 'ArrowRight') props.split.setRatio(props.split.ratio() + KEY_STEP);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={host}
      class={styles.host}
      data-split={effectivelySplit()}
      style={{ '--split-ratio': props.split.ratio() } as JSX.CSSProperties}
    >
      <div class={styles.pane} data-pane="main" data-active={props.split.activePane() === 'main'}>
        {props.primary()}
      </div>
      <Show when={effectivelySplit()}>
        <div
          class={styles.divider}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize split"
          tabindex={0}
          onPointerDown={dragDivider}
          onKeyDown={onDividerKeyDown}
          onDblClick={() => props.split.setRatio(0.5)}
        />
        <div
          class={styles.pane}
          data-pane="secondary"
          data-active={props.split.activePane() === 'secondary'}
        >
          <div class={styles.paneHeader}>
            <select
              class={styles.picker}
              aria-label="Secondary pane session"
              value={props.split.secondarySessionId() ?? ''}
              onChange={(event) => props.split.setSecondarySession(event.currentTarget.value || null)}
            >
              <option value="" disabled>
                Choose a session…
              </option>
              <For each={props.secondaryOptions()}>
                {(option) => <option value={option.sessionId}>{option.label}</option>}
              </For>
            </select>
            <button
              type="button"
              class={styles.closeButton}
              aria-label="Close split"
              title="Close split"
              onClick={() => props.split.unsplit()}
            >
              ×
            </button>
          </div>
          <div class={styles.paneBody}>
            <Show
              when={props.split.secondarySessionId()}
              fallback={<div class={styles.emptyPane}>Pick a session above to view it side by side.</div>}
              keyed
            >
              {(sessionId) => props.secondary(sessionId)}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
