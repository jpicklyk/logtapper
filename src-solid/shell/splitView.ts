/**
 * S1's split-pane state: whether the `viewer` region is split into two panes,
 * which session (if any) the secondary pane shows, the divider ratio, and
 * which pane last held focus.
 *
 * Deliberately bounded to two panes side by side — not React's arbitrary
 * `centerTree` split tree (see this package's task-scope note). `'main'` is
 * the pane `App.tsx` always renders, the same one every session used before
 * this package landed; `'secondary'` exists only while `active()` is true.
 *
 * Pure UI state: no controller or session-store dependency. The owner
 * (`App.tsx`) reads `secondarySessionId()` to decide which session's
 * `LogViewer` to mount at `SECONDARY_PANE_ID`, calls `handleSessionClosed`
 * when a session closes so a stale id can never linger as the secondary
 * pane's selection, and reads/writes the whole store through
 * `toLayout`/`applyLayout` at workspace save/restore — see
 * `workspace/layoutBlob.ts`'s `SplitLayout`, which this mirrors field for
 * field.
 */
import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
// Deliberately the internal module, not the `../workspace` barrel that also
// exports these (review B-L2 asked for the reason to be written down):
// `workspace/workspaceStore.ts` imports `widthsStorageKey` from `'../shell'`,
// so `shell` → `workspace/index` → `workspaceStore` → `shell/index` is a real
// import cycle, and `workspace/index` additionally pulls in `WorkspaceHome`,
// which reaches into `stream/` and `app/`. `layoutBlob.ts` is a leaf (Solid +
// `@bridge` types only), so importing it directly is the acyclic edge. The
// barrel rule's purpose — one module never depending on another's internals —
// is preserved in spirit: these five symbols ARE part of `workspace`'s public
// API, they are just reached at their definition site to break the cycle.
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, DEFAULT_SPLIT_RATIO } from '../workspace/layoutBlob';
import type { SplitLayout } from '../workspace/layoutBlob';
import type { Tier } from './tier';

/**
 * The split is a wide/ultra-wide feature (brief §6.2's driver: two sessions
 * side by side once there is room for both). `compact` and `standard` keep
 * `split.active()` as persisted state — so re-widening the window brings a
 * saved split straight back — but `ViewerSplit` renders only the primary pane
 * on those tiers, and `App.tsx` disables the control that opens one.
 */
export function isSplitTier(tier: Tier): boolean {
  return tier === 'wide' || tier === 'ultrawide';
}

/** The two panes S1 renders. `'main'` is the controller's existing default —
 *  deliberately not re-exported as a constant here: `viewer`'s
 *  `DEFAULT_PANE_ID` and `app`'s `MAIN_PANE_ID` already name it, and neither
 *  `App.tsx` nor `LogViewer` needs a third spelling (the primary pane simply
 *  omits `paneId`, which defaults to `DEFAULT_PANE_ID`). */
export type PaneSlot = 'main' | 'secondary';

export const SECONDARY_PANE_ID: PaneSlot = 'secondary';

export interface SplitView {
  active: Accessor<boolean>;
  secondarySessionId: Accessor<string | null>;
  ratio: Accessor<number>;
  /**
   * Which pane last had pointer-down or native focus — drives a `QueryBar`'s
   * shortcut-gating `active` prop and the split host's "active pane" outline.
   * Independent of the controller's own (unexposed) `activePaneId`; the two
   * are kept in sync by `App.tsx` wiring `LogViewer`'s `onActivate` to
   * `setActivePane`, which fires from the same call site as
   * `controller.focusPane`.
   */
  activePane: Accessor<PaneSlot>;

  /** Turn the split on. Leaves `secondarySessionId` alone unless `sessionId`
   *  is given, so re-opening a split remembers the last session shown there. */
  split(sessionId?: string): void;
  /** Turn the split off and forget the secondary pane's session. Its
   *  `LogViewer` unmounts, which detaches its controller pane. */
  unsplit(): void;
  setSecondarySession(sessionId: string | null): void;
  setRatio(ratio: number): void;
  setActivePane(pane: PaneSlot): void;
  /** Clears the secondary selection if the session that just closed was
   *  showing there — called by `App.tsx`'s session-close path. */
  handleSessionClosed(sessionId: string): void;

  /** Snapshot for a workspace save. */
  toLayout(): SplitLayout;
  /** Restore from a workspace's saved layout. Always resets `activePane` to
   *  `'main'` — a restored split has not been clicked into yet. */
  applyLayout(layout: SplitLayout): void;
}

function clampRatio(ratio: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function createSplitView(): SplitView {
  const [active, setActive] = createSignal(false);
  const [secondarySessionId, setSecondarySessionId] = createSignal<string | null>(null);
  const [ratio, setRatioSignal] = createSignal(DEFAULT_SPLIT_RATIO);
  const [activePane, setActivePaneSignal] = createSignal<PaneSlot>('main');

  const split = (sessionId?: string): void => {
    setActive(true);
    if (sessionId !== undefined) setSecondarySessionId(sessionId);
    setActivePaneSignal('secondary');
  };

  const unsplit = (): void => {
    setActive(false);
    setSecondarySessionId(null);
    setActivePaneSignal('main');
  };

  return {
    active,
    secondarySessionId,
    ratio,
    activePane,
    split,
    unsplit,
    setSecondarySession: setSecondarySessionId,
    setRatio: (r) => setRatioSignal(clampRatio(r)),
    setActivePane: setActivePaneSignal,
    handleSessionClosed: (sessionId) => {
      if (secondarySessionId() === sessionId) setSecondarySessionId(null);
    },
    toLayout: () => ({ active: active(), secondarySessionId: secondarySessionId(), ratio: ratio() }),
    applyLayout: (layout) => {
      setActive(layout.active);
      setSecondarySessionId(layout.secondarySessionId);
      setRatioSignal(clampRatio(layout.ratio));
      setActivePaneSignal('main');
    },
  };
}
