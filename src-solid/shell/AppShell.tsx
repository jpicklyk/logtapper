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
  topBar?: JSX.Element;
  statusBar?: JSX.Element;
  slots?: SurfaceSlots;
  regionSlots?: RegionSlots;
}

/** A surface with no implementation yet still renders, so the shell is reviewable. */
function SurfacePanel(props: { surface: SurfaceDef; slot?: () => JSX.Element }) {
  return (
    <section class={styles.panel} aria-label={props.surface.title} data-surface={props.surface.id}>
      <Show
        when={props.slot}
        fallback={
          <>
            <header class={styles.panelHeader}>{props.surface.title}</header>
            <p class={styles.panelDescription}>{props.surface.description}</p>
          </>
        }
      >
        {(slot) => slot()()}
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

  const [openDrawer, setOpenDrawer] = createSignal<SurfaceId | null>(null);

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
      <header class={styles.topBar}>{props.topBar}</header>

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
