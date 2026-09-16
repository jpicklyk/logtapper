/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { createTier } from './tier';
import type { Tier } from './tier';
import { createMode } from './mode';
import type { SessionKind } from './mode';
import {
  activeRegions,
  drawerSurfaces,
  railSurfaces,
  regionSurfaces,
  surfaceById,
} from './surfaces';
import type { RegionId, SurfaceDef, SurfaceId } from './surfaces';
import { Splitter, createRegionWidths } from './Splitter';
import type { RegionWidths, ResizableRegion } from './Splitter';
import { WindowControls } from './WindowControls';
import styles from './shell.module.css';

/**
 * A surface renderer. Later packages hand one per surface they own — A2 passes
 * `{ presence: () => <PresencePanel /> }` and the shell mounts it wherever
 * `surfaces.ts` places `presence` for the current mode and tier (its own column
 * on wide, inside `details` on standard, a drawer off the rail on compact).
 */
export type SurfaceSlots = Partial<Record<SurfaceId, () => JSX.Element>>;

/**
 * Extra content appended to a region after its surfaces. E1's editor tab is not
 * a brief §4 surface, so it arrives as `{ details: () => <EditorTab /> }`.
 */
export type RegionSlots = Partial<Record<RegionId, () => JSX.Element>>;

export interface AppShellProps {
  /** Splitter widths are stored per workspace. */
  workspaceId: string;
  /** Focused session's source; decides `data-mode`. */
  sessionKind: SessionKind;
  /**
   * Drawer to open on mount, read ONCE at construction and never again.
   *
   * A1 put the first-run attach and open actions on `workspace-home`, which is
   * a rail surface on every tier, so with the drawer closed by default a cold
   * start showed only the viewer's "No log open" line and those actions sat
   * behind a glyph nobody had a reason to press. The caller decides (it is the
   * one that knows whether any session exists); the shell just honours it.
   *
   * Deliberately not reactive: a drawer that reopens whenever its condition
   * becomes true again would fight a user who closed it.
   */
  initialDrawer?: SurfaceId | null;
  /**
   * The app's single tier subscription.
   *
   * `createTier()` registers three `matchMedia` listeners and mirrors the
   * result onto `<html data-tier>`; the shell, `ViewerSplit` and `App.tsx`
   * each used to create their own, so three subscriptions ran and two of them
   * wrote the same attribute (review B-L6). `App.tsx` now creates one and
   * passes it to both consumers. Optional so a test (or any standalone mount)
   * can still render the shell on its own.
   */
  tier?: Accessor<Tier>;
  topBar?: JSX.Element;
  statusBar?: JSX.Element;
  slots?: SurfaceSlots;
  regionSlots?: RegionSlots;
  /**
   * Hands the caller a reference to this shell instance's region-width store
   * and open-drawer state, called exactly once at setup (a Solid component's
   * function body runs once for its whole lifetime, so this is not a render
   * effect — same forward-reference trick `App.tsx`'s `editorStoreBox` uses
   * for the editor store). The workspace store's `shellLayout` port is the
   * only consumer: it needs to read the live widths/drawer for a save and
   * seed them on a restore, and both live here because validating a restored
   * drawer id needs this shell's own `mode`/`tier`.
   */
  onReady?: (handle: ShellLayoutHandle) => void;
}

/**
 * What `AppShell` exposes to whoever owns workspace persistence — the parts
 * of its state that travel with a saved workspace (S1c). Not itself part of
 * `SolidLayout`; `App.tsx`'s `shellLayout` port maps these onto that shape.
 */
export interface ShellLayoutHandle {
  /** This shell instance's region-width store. */
  widths: RegionWidths;
  /** The currently open drawer's surface id, or null. */
  openDrawer: Accessor<SurfaceId | null>;
  /**
   * Open the given drawer id if it is still openable for the *current*
   * tier/mode (the same check `initialDrawer` applies on first mount),
   * otherwise leave it closed. Used to restore a workspace's saved drawer
   * without springing open an id that no longer applies here.
   */
  applyDrawer(id: string | null): void;
}

/** A surface with no implementation yet still renders, so the shell is reviewable.
 *  `keyed`: the drawer reuses one panel and swaps `slot` in place when the
 *  rail moves from one surface to another; a non-keyed Show would keep the
 *  first slot's output (a different function is still truthy) while the
 *  header above it changed. */
function SurfacePanel(props: { surface: SurfaceDef; slot?: () => JSX.Element }) {
  return (
    <section class={styles.panel} aria-label={props.surface.title} data-surface={props.surface.id}>
      <Show
        when={props.slot}
        keyed
        fallback={
          <>
            <header class={styles.panelHeader}>{props.surface.title}</header>
            <p class={styles.panelDescription}>{props.surface.description}</p>
          </>
        }
      >
        {(slot) => slot()}
      </Show>
    </section>
  );
}

/** What a focus trap considers reachable by Tab. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The layout shell: a top bar, the `rail | navigator | viewer | details |
 * presence` grid body, and a status bar. Which regions exist and what each one
 * holds comes from `surfaces.ts` crossed with the live tier and mode — the
 * component itself hard-codes no placement.
 */
export function AppShell(props: AppShellProps) {
  // `props.tier` is read once: the caller owns exactly one subscription for the
  // app's lifetime (see `AppShellProps.tier`), so re-reading it reactively
  // would only add a dependency that can never change.
  // eslint-disable-next-line solid/reactivity -- constant for the shell's lifetime, by design
  const tier = props.tier ?? createTier();
  const mode = createMode({ sessionKind: () => props.sessionKind });
  const widths = createRegionWidths(() => props.workspaceId);

  /** Every surface openable as a drawer right now, for this tier and mode —
   *  shared by the initial-drawer check below and by `applyDrawer`, which
   *  needs the identical check at restore time. */
  const openableSurfaces = (): SurfaceDef[] => [
    ...railSurfaces(mode(), tier()),
    ...drawerSurfaces(mode(), tier()),
  ];

  // Read once, untracked: see `initialDrawer`'s doc. A surface that is not a
  // drawer on this tier and mode is ignored rather than opening an empty aside.
  const [openDrawer, setOpenDrawer] = createSignal<SurfaceId | null>(
    (() => {
      const requested = props.initialDrawer ?? null;
      if (requested === null) return null;
      return openableSurfaces().some((s) => s.id === requested) ? requested : null;
    })(),
  );

  /** See `ShellLayoutHandle.applyDrawer`'s doc. */
  const applyDrawer = (id: string | null): void => {
    if (id === null) {
      setOpenDrawer(null);
      return;
    }
    const match = openableSurfaces().find((s) => s.id === id);
    setOpenDrawer(match?.id ?? null);
  };

  // Called once, deliberately non-reactively: `onReady` is a one-shot handoff
  // of the store references at setup, not a value the shell needs to re-emit
  // on every prop change (same non-reactive read as `props.tier` above).
  // eslint-disable-next-line solid/reactivity -- one-shot handoff at setup, by design
  props.onReady?.({ widths, openDrawer, applyDrawer });

  const regions = createMemo(() => activeRegions(mode(), tier()));

  /** Rail buttons open the surfaces that are not a persistent column here. */
  const railItems = createMemo(() => [
    ...railSurfaces(mode(), tier()),
    ...drawerSurfaces(mode(), tier()),
  ]);

  /**
   * The drawer's surface, revalidated against the *current* tier and mode
   * (review B-H3).
   *
   * `openDrawer` is a plain id, but where `surfaces.ts` places that id changes
   * with the viewport and with the focused session's kind. Without this check
   * a surface that has since been promoted to its own column renders twice —
   * once in the region loop below, once in the drawer — with two sets of
   * effects and two copies of every DOM id; and a live-only surface
   * (`watches`, `stream-controls`) keeps rendering after the capture stops,
   * with no rail glyph left to close it.
   *
   * `railItems()` is exactly "everything openable as a drawer here", so the
   * check reuses it rather than recomputing the two surface lists.
   */
  const drawerSurface = createMemo(() => {
    const id = openDrawer();
    if (id === null) return null;
    if (!railItems().some((surface) => surface.id === id)) return null;
    return surfaceById(id) ?? null;
  });

  // Keep the signal honest too, so re-narrowing the window (or restarting a
  // capture) does not spring a drawer the user never reopened back into view.
  // The memo above is what makes the *render* safe within the same frame; this
  // is what makes the state match what is on screen.
  createEffect(
    on([mode, tier], () => {
      const id = openDrawer();
      if (id !== null && !railItems().some((surface) => surface.id === id)) setOpenDrawer(null);
    }),
  );

  /** How an open drawer sits next to the rail. On compact there is no room —
   *  it overlays the single column as a sheet (backdrop, click-outside and
   *  Escape close it). On standard and wider it is a real grid column that
   *  pushes the navigator right, so opening Settings never hides sections
   *  or bookmarks behind it. */
  const drawerPlacement = createMemo<'overlay' | 'push'>(() => (tier() === 'compact' ? 'overlay' : 'push'));
  const pushing = createMemo(() => drawerSurface() !== null && drawerPlacement() === 'push');

  const columns = createMemo(() =>
    [
      'var(--shell-rail-w)',
      ...(pushing() ? ['var(--shell-drawer-w)'] : []),
      ...regions().map((region) =>
        region === 'viewer' ? 'minmax(0, 1fr)' : `${widths.width(region as ResizableRegion)}px`,
      ),
    ].join(' '),
  );

  /** The overlay sheet's root, for focus move and containment (review B-M6). */
  let drawerEl: HTMLElement | undefined;
  /** The rail button that opened the drawer — focus goes back here on close. */
  let invoker: HTMLElement | null = null;

  const toggleDrawer = (id: SurfaceId, source?: HTMLElement): void => {
    const next = openDrawer() === id ? null : id;
    if (next !== null) invoker = source ?? null;
    setOpenDrawer(next);
  };
  const closeDrawer = () => setOpenDrawer(null);

  // Escape closes an overlay drawer, the way a sheet should; a pushed column
  // is persistent chrome and keeps Escape for whatever is focused inside it.
  createEffect(() => {
    if (drawerSurface() === null || drawerPlacement() !== 'overlay') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  // An overlay drawer is a modal sheet: move focus into it on open and put it
  // back on the rail button that opened it on close. Without this, Tab from a
  // compact-width sheet walks straight into the log viewer behind it and
  // Escape leaves focus on `document.body` (review B-M6). A *pushed* drawer is
  // an ordinary column — it is not modal and must not steal focus.
  createEffect(() => {
    if (drawerSurface() === null || drawerPlacement() !== 'overlay') return;
    const sheet = drawerEl;
    if (!sheet) return;
    const previous = invoker ?? (document.activeElement as HTMLElement | null);
    (sheet.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? sheet).focus();
    onCleanup(() => {
      if (previous?.isConnected) previous.focus();
    });
  });

  /** Contain Tab inside the sheet while it is modal. */
  const onDrawerKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || drawerPlacement() !== 'overlay') return;
    const sheet = drawerEl;
    if (!sheet) return;
    const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      sheet.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === sheet)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      class={styles.shell}
      data-tier={tier()}
      data-mode={mode()}
      style={{ '--shell-columns': columns() } as JSX.CSSProperties}
    >
      {/* The window renders a 1px caption (see `WindowControls`), so this bar
          IS the title bar: it has to be draggable, or the window could only be
          moved with the keyboard. Tauri drags only when the mousedown target
          itself carries the attribute, so the bar's buttons still click. */}
      <header class={styles.topBar} data-testid="top-bar" data-tauri-drag-region>
        {props.topBar}
        <WindowControls />
      </header>

      <nav class={styles.rail} aria-label="Surfaces">
        <For each={railItems()}>
          {(surface) => (
            <button
              type="button"
              class={styles.railButton}
              classList={{ [styles.railButtonOpen]: openDrawer() === surface.id }}
              title={surface.title}
              aria-label={surface.title}
              aria-pressed={openDrawer() === surface.id}
              aria-haspopup="dialog"
              onClick={(event) => toggleDrawer(surface.id, event.currentTarget)}
            >
              <span class={styles.railGlyph} aria-hidden="true">
                {surface.glyph}
              </span>
            </button>
          )}
        </For>
      </nav>

      {/* Rendered before the regions on purpose: when the drawer is a pushed
          column, grid auto-placement must reach it right after the rail. */}
      <Show when={drawerSurface()}>
        {(surface) => (
          <>
            <Show when={drawerPlacement() === 'overlay'}>
              {/* Decorative: Escape and the header's Close button are the
                  keyboard paths out of the sheet, so the backdrop carries no
                  role of its own and is hidden from assistive tech. */}
              <div
                class={styles.drawerBackdrop}
                data-testid="drawer-backdrop"
                aria-hidden="true"
                onClick={closeDrawer}
              />
            </Show>
            <aside
              ref={drawerEl}
              class={styles.drawer}
              data-placement={drawerPlacement()}
              aria-label={surface().title}
              // Modal only as a sheet; a pushed drawer is an ordinary column
              // and announcing it as a modal dialog would be a lie.
              role={drawerPlacement() === 'overlay' ? 'dialog' : undefined}
              aria-modal={drawerPlacement() === 'overlay' ? 'true' : undefined}
              tabindex={drawerPlacement() === 'overlay' ? -1 : undefined}
              onKeyDown={onDrawerKeyDown}
            >
              <header class={styles.drawerHeader}>
                <span>{surface().title}</span>
                <button type="button" class={styles.drawerClose} aria-label="Close" onClick={closeDrawer}>
                  ×
                </button>
              </header>
              <div class={styles.drawerBody}>
                <SurfacePanel surface={surface()} slot={props.slots?.[surface().id]} />
              </div>
            </aside>
          </>
        )}
      </Show>

      <For each={regions()}>
        {(region) => (
          <div class={styles.region} data-region={region}>
            {/* The scroll container is an inner element so the splitter can be
                its *sibling* rather than its child (review B-M4): an
                absolutely positioned child of a scroll container scrolls away
                with the content, so on a `details` column tall enough to
                overflow the 5px resize handle ended up above the viewport and
                the column could no longer be resized. */}
            <div class={styles.regionScroll}>
              <Show when={region === 'viewer'}>
                <div class={styles.viewerSlot}>{props.slots?.viewer?.()}</div>
              </Show>
              <For each={regionSurfaces(region, mode(), tier()).filter((s) => s.id !== 'viewer')}>
                {(surface) => <SurfacePanel surface={surface} slot={props.slots?.[surface.id]} />}
              </For>
              {props.regionSlots?.[region]?.()}
            </div>
            <Show when={region !== 'viewer'}>
              <Splitter
                region={region as ResizableRegion}
                widths={widths}
                side={region === 'navigator' ? 'start' : 'end'}
              />
            </Show>
          </div>
        )}
      </For>

      {/* The mode/tier pair used to ship here as text. It is a developer
          affordance (review B-L18) and it is already on the root element as
          `data-mode`/`data-tier`, which is where a test or a devtools
          inspection reads it from. */}
      <footer class={styles.statusBar}>{props.statusBar}</footer>
    </div>
  );
}
