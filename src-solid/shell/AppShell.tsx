/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { createTier } from './tier';
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
import type { ResizableRegion } from './Splitter';
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
  topBar?: JSX.Element;
  statusBar?: JSX.Element;
  slots?: SurfaceSlots;
  regionSlots?: RegionSlots;
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

/**
 * The layout shell: a top bar, the `rail | navigator | viewer | details |
 * presence` grid body, and a status bar. Which regions exist and what each one
 * holds comes from `surfaces.ts` crossed with the live tier and mode — the
 * component itself hard-codes no placement.
 */
export function AppShell(props: AppShellProps) {
  const tier = createTier();
  const mode = createMode({ sessionKind: () => props.sessionKind });
  const widths = createRegionWidths(() => props.workspaceId);

  // Read once, untracked: see `initialDrawer`'s doc. A surface that is not a
  // drawer on this tier and mode is ignored rather than opening an empty aside.
  const [openDrawer, setOpenDrawer] = createSignal<SurfaceId | null>(
    (() => {
      const requested = props.initialDrawer ?? null;
      if (requested === null) return null;
      const openable = [...railSurfaces(mode(), tier()), ...drawerSurfaces(mode(), tier())];
      return openable.some((s) => s.id === requested) ? requested : null;
    })(),
  );

  const regions = createMemo(() => activeRegions(mode(), tier()));

  /** Rail buttons open the surfaces that are not a persistent column here. */
  const railItems = createMemo(() => [
    ...railSurfaces(mode(), tier()),
    ...drawerSurfaces(mode(), tier()),
  ]);

  const columns = createMemo(() =>
    [
      'var(--shell-rail-w)',
      ...regions().map((region) =>
        region === 'viewer' ? 'minmax(0, 1fr)' : `${widths.width(region as ResizableRegion)}px`,
      ),
    ].join(' '),
  );

  const drawerSurface = createMemo(() => {
    const id = openDrawer();
    return id ? (surfaceById(id) ?? null) : null;
  });

  const toggleDrawer = (id: SurfaceId) => setOpenDrawer((current) => (current === id ? null : id));

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
              onClick={() => toggleDrawer(surface.id)}
            >
              <span class={styles.railGlyph} aria-hidden="true">
                {surface.title.slice(0, 2)}
              </span>
            </button>
          )}
        </For>
      </nav>

      <For each={regions()}>
        {(region) => (
          <div class={styles.region} data-region={region}>
            <Show when={region === 'viewer'}>
              <div class={styles.viewerSlot}>{props.slots?.viewer?.()}</div>
            </Show>
            <For each={regionSurfaces(region, mode(), tier()).filter((s) => s.id !== 'viewer')}>
              {(surface) => <SurfacePanel surface={surface} slot={props.slots?.[surface.id]} />}
            </For>
            {props.regionSlots?.[region]?.()}
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

      <Show when={drawerSurface()}>
        {(surface) => (
          <aside class={styles.drawer} aria-label={surface().title}>
            <header class={styles.drawerHeader}>
              <span>{surface().title}</span>
              <button
                type="button"
                class={styles.drawerClose}
                aria-label="Close"
                onClick={() => setOpenDrawer(null)}
              >
                ×
              </button>
            </header>
            <div class={styles.drawerBody}>
              <SurfacePanel surface={surface()} slot={props.slots?.[surface().id]} />
            </div>
          </aside>
        )}
      </Show>

      <footer class={styles.statusBar}>
        {props.statusBar}
        <span class={styles.statusMeta}>
          {mode()} · {tier()}
        </span>
      </footer>
    </div>
  );
}
