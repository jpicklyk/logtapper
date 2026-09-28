/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { MarketplaceEntry, MarketplacePackEntry, PackSummary, ProcessorSummary } from '@bridge/types';
import { getBareId, matchesQuery } from '@bridge/types';
import type { PacksStore } from './packsStore';
import { PackDetailsDialog } from './PackDetailsDialog';
import styles from './packs.module.css';

const OTHER_CATEGORY = 'Other';

export interface PacksPanelProps {
  store: PacksStore;
  /**
   * The existing `settings/SourcesTab.tsx`, rendered unchanged as the Sources
   * sub-tab below — passed as a slot rather than imported directly so this
   * module never reaches into `settings/`'s internals (barrel-export rule:
   * `settings/index.ts` does not export `SourcesTab`, on purpose, because
   * nothing outside `SettingsPanel.tsx` mounted it before this package).
   */
  sourcesPanel: JSX.Element;
}

type PacksTab = 'browse' | 'installed' | 'updates' | 'library' | 'sources';
const TAB_ORDER: PacksTab[] = ['browse', 'installed', 'updates', 'library', 'sources'];
const tabId = (id: PacksTab): string => `packs-tab-${id}`;
const panelId = (id: PacksTab): string => `packs-tabpanel-${id}`;

type StatusFilter = 'all' | 'available' | 'added';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The `settings` surface's Packs tab, split into sub-tabs so nothing is
 * buried under a growing catalog:
 *
 * - **Browse** — curated packs from the selected source, filtered by a search
 *   box, category chips and an added/not-added toggle. Cards stay compact; a
 *   pack's member analyzers, and the add/remove actions, live in
 *   `PackDetailsDialog` (adding is a two-step action because installing runs
 *   third-party processor YAML).
 * - **Installed** — what is on this machine, from any source: packs and
 *   standalone marketplace analyzers, with Update and confirm-gated Remove.
 * - **Updates** — pending pack and analyzer updates, "Check for updates" and
 *   "Update all".
 * - **Library** — standalone analyzers from the selected source that no pack
 *   covers.
 * - **Sources** — the injected `SourcesTab`, unchanged.
 */
export function PacksPanel(props: PacksPanelProps): JSX.Element {
  const store = () => props.store;
  const [tab, setTab] = createSignal<PacksTab>('browse');
  // One query shared by Browse and Library, so "not a pack, try the library"
  // carries the search across.
  const [query, setQuery] = createSignal('');
  const [category, setCategory] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<StatusFilter>('all');
  const [detailsPackId, setDetailsPackId] = createSignal<string | null>(null);
  const [confirmingRemovePackId, setConfirmingRemovePackId] = createSignal<string | null>(null);
  const [confirmingRemoveProcId, setConfirmingRemoveProcId] = createSignal<string | null>(null);

  const enabledSources = createMemo(() => store().sources().filter((s) => s.enabled));
  const isSelectable = (name: string): boolean => enabledSources().some((s) => s.name === name);

  // The source list belongs to `settingsStore`, and the only thing that used to
  // load it was `SourcesTab`'s own `onMount` — and `SourcesTab` is rendered
  // *inside* this panel, under its own sub-tab. So on a fresh launch with no
  // `updates-available` event, opening Settings → Packs found an empty list,
  // picked no source, and disabled the Fetch button; with exactly one
  // configured source the `<select>` is not rendered either, leaving the tab a
  // dead end until it was unmounted and remounted (D1-H1). Ask for the list
  // here when nobody has loaded it yet.
  //
  // The store outlives this panel, which `SettingsPanel` unmounts on every tab
  // switch, so a source picked on an earlier visit keeps its catalog — which
  // meant a published pack stayed invisible until the app restarted. Every
  // visit re-fetches the selected source instead (the old entries stay on
  // screen until the new ones land), and re-runs the update check so the
  // "Update available" badges and the Updates list describe the same catalog
  // the user is looking at, not whatever the startup check saw.
  //
  // This runs before the effect below (both are queued in declaration order),
  // so a first visit with no selection still fetches exactly once, from the
  // effect. A selection the loaded list no longer has is left to the effect,
  // which replaces it; an unloaded list (empty) cannot tell us, so fetch.
  onMount(() => {
    const sources = store().sources();
    if (sources.length === 0) store().refreshSources();
    const selected = store().selectedSource();
    if (selected && (sources.length === 0 || isSelectable(selected))) void store().fetchEntries(selected);
    if (!store().updatesLoading()) void store().checkUpdates();
  });

  // Reactive, not `onMount`: the list arrives asynchronously and an `onMount`
  // read of `enabledSources()[0]` ran before it. Re-runs when the sources
  // populate or change. A selection that is still an enabled source is left
  // alone (the `onMount` refresh above covers it); one that was removed or
  // disabled is replaced, or the tab would keep re-fetching a source that no
  // longer exists — with one source left the `<select>` is hidden, so the
  // user had no way off it.
  createEffect(() => {
    const selected = store().selectedSource();
    if (selected && isSelectable(selected)) return;
    const first = enabledSources()[0];
    if (first) void store().fetchEntries(first.name);
  });

  /** The selection, but only while it is still an enabled source. */
  const activeSource = createMemo(() => {
    const selected = store().selectedSource();
    return selected && isSelectable(selected) ? selected : null;
  });

  const installedPackIds = createMemo(() => new Set(store().installedPacks().map((p) => p.id)));
  /** Bare catalog id → installed (qualified `id@source`) id, for the browsed
   *  source only. Catalog entries carry bare ids, installed processors are
   *  keyed qualified, so a plain id comparison never matched. */
  const libraryInstalled = createMemo(() => {
    const src = activeSource();
    const map = new Map<string, string>();
    for (const p of store().installedProcessors()) if (src && p.source === src) map.set(getBareId(p.id), p.id);
    return map;
  });
  const entriesById = createMemo(() => new Map(store().entries().map((e) => [e.id, e])));

  // ── Browse ────────────────────────────────────────────────────────────────
  // The catalog on screen belongs to `activeSource`; once its source is removed
  // or disabled (and nothing replaced it) there is no catalog to show or act on.
  const catalogPacks = createMemo(() => (activeSource() ? store().packEntries() : []));

  /** Query + status applied, category not — the chip counts come from here. */
  const matchingPacks = createMemo(() => {
    const q = query().trim().toLowerCase();
    const s = status();
    return catalogPacks().filter((p) => {
      if (q && !matchesQuery(p, q)) return false;
      if (s === 'added') return installedPackIds().has(p.id);
      if (s === 'available') return !installedPackIds().has(p.id);
      return true;
    });
  });

  const categoryCounts = createMemo<Array<[string, number]>>(() => {
    const counts = new Map<string, number>();
    for (const p of matchingPacks()) {
      const key = p.category ?? OTHER_CATEGORY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => {
      if (a === OTHER_CATEGORY) return 1;
      if (b === OTHER_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  });

  /** The chosen category, but only while some matching pack still has it. */
  const activeCategory = createMemo(() => {
    const c = category();
    return c && categoryCounts().some(([name]) => name === c) ? c : null;
  });

  const grouped = createMemo<Array<[string, MarketplacePackEntry[]]>>(() => {
    const only = activeCategory();
    const map = new Map<string, MarketplacePackEntry[]>();
    for (const p of matchingPacks()) {
      const key = p.category ?? OTHER_CATEGORY;
      if (only && key !== only) continue;
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    const order = categoryCounts().map(([name]) => name);
    return [...map.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  });

  const detailsPack = createMemo(() => {
    const id = detailsPackId();
    return id ? catalogPacks().find((p) => p.id === id) ?? null : null;
  });

  // ── Library ───────────────────────────────────────────────────────────────
  // Standalone analyzers not covered by any pack from this source.
  const packMemberIds = createMemo(() => {
    const ids = new Set<string>();
    for (const p of store().packEntries()) for (const pid of p.processorIds) ids.add(pid);
    return ids;
  });
  const standaloneEntries = createMemo<MarketplaceEntry[]>(() =>
    activeSource() ? store().entries().filter((e) => !packMemberIds().has(e.id)) : [],
  );
  const filteredStandalone = createMemo<MarketplaceEntry[]>(() => {
    const q = query().trim().toLowerCase();
    return q ? standaloneEntries().filter((e) => matchesQuery(e, q)) : standaloneEntries();
  });

  // ── Installed ─────────────────────────────────────────────────────────────
  /** Marketplace-installed analyzers that are not part of an installed pack. */
  const installedStandalone = createMemo<ProcessorSummary[]>(() =>
    store().installedProcessors().filter((p) => !p.builtin && !p.packId && p.source),
  );
  /** A pack remembers no source of its own; its members do. Uninstall needs it
   *  (see `PacksStore.uninstallPack`), so read it off the first member. */
  const packSource = (packId: string): string | null =>
    store().installedProcessors().find((p) => p.packId === packId && p.source)?.source ?? activeSource();
  const installedCount = createMemo(() => store().installedPacks().length + installedStandalone().length);

  // ── Updates ───────────────────────────────────────────────────────────────
  const totalUpdates = createMemo(() => store().pendingUpdates().length + store().pendingPackUpdates().length);
  const processorUpdate = (id: string) => store().pendingUpdates().find((u) => u.processorId === id);
  const packUpdate = (id: string) => store().pendingPackUpdates().find((u) => u.packId === id);

  const tabLabel = (id: PacksTab): string => {
    switch (id) {
      case 'browse': return 'Browse';
      case 'installed': return installedCount() > 0 ? `Installed (${installedCount()})` : 'Installed';
      case 'updates': return totalUpdates() > 0 ? `Updates (${totalUpdates()})` : 'Updates';
      case 'library': return 'Library';
      case 'sources': return 'Sources';
    }
  };

  let stripRef: HTMLDivElement | undefined;
  const focusTab = (id: PacksTab): void => {
    setTab(id);
    stripRef?.querySelector<HTMLButtonElement>(`#${tabId(id)}`)?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    // Keep the outer Settings tab strip from also handling the arrow key.
    event.stopPropagation();
    if (event.key === 'Home') return focusTab(TAB_ORDER[0]);
    if (event.key === 'End') return focusTab(TAB_ORDER[TAB_ORDER.length - 1]);
    const current = TAB_ORDER.indexOf(tab());
    focusTab(TAB_ORDER[(current + delta + TAB_ORDER.length) % TAB_ORDER.length]);
  };

  const handleSourceChange = (e: Event): void => {
    const name = (e.currentTarget as HTMLSelectElement).value;
    void store().fetchEntries(name);
    setQuery('');
    setCategory(null);
  };

  const handleConfirmRemovePack = (packId: string): void => {
    setConfirmingRemovePackId(null);
    const src = packSource(packId);
    if (src) void store().uninstallPack(src, packId);
  };

  const handleConfirmRemoveProcessor = (processorId: string): void => {
    setConfirmingRemoveProcId(null);
    void store().uninstallProcessor(processorId);
  };

  /** Source picker + search + Fetch — shared by the two catalog tabs. */
  const catalogToolbar = (placeholder: string, label: string): JSX.Element => (
    <div class={styles.toolbar}>
      <Show when={enabledSources().length > 1}>
        <select
          class={styles.sourceSelect}
          value={store().selectedSource() ?? ''}
          onChange={handleSourceChange}
          aria-label="Marketplace source"
        >
          <For each={enabledSources()}>{(s) => <option value={s.name}>{s.name}</option>}</For>
        </select>
      </Show>
      <input
        type="text"
        class={styles.search}
        placeholder={placeholder}
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        aria-label={label}
      />
      <button
        type="button"
        class={styles.fetchBtn}
        disabled={store().entriesLoading() || !activeSource()}
        onClick={() => {
          const s = activeSource();
          if (s) void store().fetchEntries(s);
        }}
      >
        {store().entriesLoading() ? 'Loading…' : store().entries().length + store().packEntries().length > 0 ? 'Refresh' : 'Fetch'}
      </button>
    </div>
  );

  const noSourcesHint = (): JSX.Element => (
    <Show when={enabledSources().length === 0}>
      <div class={styles.empty}>
        No marketplace sources configured.{' '}
        <button type="button" class={styles.linkBtn} onClick={() => setTab('sources')}>Add one in Sources</button>
      </div>
    </Show>
  );

  /** Remove button that turns into Confirm/Cancel in place. */
  const confirmRemove = (
    id: string,
    confirming: () => string | null,
    setConfirming: (v: string | null) => void,
    onConfirm: () => void,
    label: string,
  ): JSX.Element => (
    <Show
      when={confirming() !== id}
      fallback={
        <>
          <button type="button" class={`${styles.btn} ${styles.btnDanger}`} onClick={onConfirm}>Confirm</button>
          <button type="button" class={styles.btn} onClick={() => setConfirming(null)}>Cancel</button>
        </>
      }
    >
      <button type="button" class={styles.btn} disabled={store().isPending(id)} onClick={() => setConfirming(id)}>
        {store().isPending(id) ? 'Working…' : label}
      </button>
    </Show>
  );

  const updateButton = (id: string, onClick: () => void): JSX.Element => (
    <button type="button" class={`${styles.btn} ${styles.btnPrimary}`} disabled={store().isPending(id)} onClick={onClick}>
      {store().isPending(id) ? 'Updating…' : 'Update'}
    </button>
  );

  return (
    <div class={styles.panel} data-testid="packs-panel">
      <div class={styles.subTabs} role="tablist" aria-label="Packs" ref={stripRef} onKeyDown={onTabKeyDown}>
        <For each={TAB_ORDER}>
          {(id) => (
            <button
              type="button"
              role="tab"
              id={tabId(id)}
              aria-controls={panelId(id)}
              aria-selected={tab() === id}
              tabindex={tab() === id ? 0 : -1}
              class={`${styles.subTab} ${tab() === id ? styles.subTabActive : ''}`}
              data-testid={`packs-subtab-${id}`}
              onClick={() => setTab(id)}
            >
              {tabLabel(id)}
            </button>
          )}
        </For>
      </div>

      <Show when={totalUpdates() > 0 && (tab() === 'browse' || tab() === 'installed')}>
        <div class={styles.updateBar} data-testid="packs-update-summary">
          <span>{plural(totalUpdates(), 'update')} available</span>
          <button type="button" class={styles.linkBtn} onClick={() => setTab('updates')}>Review updates</button>
        </div>
      </Show>

      {/* ── Browse ─────────────────────────────────────────────────────── */}
      <Show when={tab() === 'browse'}>
        <div class={styles.tabBody} role="tabpanel" id={panelId('browse')} aria-labelledby={tabId('browse')}>
          {catalogToolbar('Filter packs…', 'Filter packs')}
          {noSourcesHint()}

          <Show when={store().entriesError()}>
            <div class={styles.error} role="alert">{store().entriesError()}</div>
          </Show>

          <Show when={catalogPacks().length > 0}>
            <div class={styles.filterRow}>
              <div class={styles.chips} role="group" aria-label="Category">
                <button
                  type="button"
                  class={`${styles.chip} ${activeCategory() === null ? styles.chipActive : ''}`}
                  aria-pressed={activeCategory() === null}
                  onClick={() => setCategory(null)}
                >
                  All <span class={styles.chipCount}>{matchingPacks().length}</span>
                </button>
                <For each={categoryCounts()}>
                  {([name, n]) => (
                    <button
                      type="button"
                      class={`${styles.chip} ${activeCategory() === name ? styles.chipActive : ''}`}
                      aria-pressed={activeCategory() === name}
                      data-testid={`packs-chip-${name}`}
                      onClick={() => setCategory(activeCategory() === name ? null : name)}
                    >
                      {name} <span class={styles.chipCount}>{n}</span>
                    </button>
                  )}
                </For>
              </div>
              <select
                class={styles.select}
                value={status()}
                onChange={(e) => setStatus(e.currentTarget.value as StatusFilter)}
                aria-label="Show packs"
              >
                <option value="all">All packs</option>
                <option value="available">Not added</option>
                <option value="added">Added</option>
              </select>
            </div>
          </Show>

          <Show when={enabledSources().length > 0 && grouped().length === 0 && !store().entriesLoading()}>
            <div class={styles.empty}>
              {catalogPacks().length === 0 ? 'No packs found. Try Fetch or a different source.' : 'No packs match your filter.'}
              <Show when={query().trim() !== '' && filteredStandalone().length > 0}>
                {' '}
                <button type="button" class={styles.linkBtn} onClick={() => setTab('library')}>
                  {plural(filteredStandalone().length, 'individual analyzer')} in the Library match
                </button>
              </Show>
            </div>
          </Show>

          <For each={grouped()}>
            {([name, packs]) => (
              <div>
                <Show when={activeCategory() === null}>
                  <div class={styles.groupLabel}>{name}</div>
                </Show>
                <div class={styles.grid}>
                  <For each={packs}>
                    {(pack) => {
                      const installed = createMemo(() => installedPackIds().has(pack.id));
                      const update = createMemo(() => packUpdate(pack.id));
                      const accent = createMemo(() => (installed() ? 'var(--success)' : 'var(--border)'));
                      return (
                        <div class={styles.card} data-testid={`pack-card-${pack.id}`} style={{ '--pack-accent': accent() } as JSX.CSSProperties}>
                          <div class={styles.cardTop}>
                            <span class={styles.cardName}>{pack.name}</span>
                            <Show when={update()} fallback={<Show when={installed()}><span class={styles.installedBadge}>Added</span></Show>}>
                              <span class={styles.updateBadge}>Update available</span>
                            </Show>
                          </div>
                          <Show when={pack.description}>
                            <div class={styles.cardDesc} title={pack.description ?? undefined}>{pack.description}</div>
                          </Show>
                          <div class={styles.cardFooter}>
                            <span class={styles.cardMeta}>{plural(pack.processorIds.length, 'analyzer')}</span>
                            <div class={styles.cardActions}>
                              <Show when={update()}>
                                {(u) => updateButton(pack.id, () => void store().updatePack(u().sourceName, u().entry))}
                              </Show>
                              <button
                                type="button"
                                class={`${styles.btn} ${installed() ? '' : styles.btnPrimary}`}
                                disabled={store().isPending(pack.id)}
                                onClick={() => setDetailsPackId(pack.id)}
                              >
                                {store().isPending(pack.id) ? 'Working…' : installed() ? 'Details' : 'Add pack'}
                              </button>
                            </div>
                          </div>
                          <Show when={store().errorFor(pack.id)}>
                            <div class={styles.itemError}>{store().errorFor(pack.id)}</div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* ── Installed ──────────────────────────────────────────────────── */}
      <Show when={tab() === 'installed'}>
        <div class={styles.tabBody} role="tabpanel" id={panelId('installed')} aria-labelledby={tabId('installed')}>
          <Show when={installedCount() === 0}>
            <div class={styles.empty}>
              Nothing added yet.{' '}
              <button type="button" class={styles.linkBtn} onClick={() => setTab('browse')}>Browse packs</button>
            </div>
          </Show>

          <Show when={store().installedPacks().length > 0}>
            <div class={styles.section}>
              <div class={styles.sectionTitle}>Packs</div>
              <For each={store().installedPacks()}>
                {(pack: PackSummary) => {
                  const update = createMemo(() => packUpdate(pack.id));
                  return (
                    <div class={styles.row} data-testid={`installed-pack-${pack.id}`}>
                      <div class={styles.rowInfo}>
                        <span class={styles.rowName}>
                          {pack.name} <span class={styles.rowVersion}>v{pack.version}</span>
                        </span>
                        <span class={styles.rowDesc}>
                          {plural(pack.processorIds.length, 'analyzer')}
                          <Show when={packSource(pack.id)}>{(src) => <> · {src()}</>}</Show>
                          <Show when={update()}>{(u) => <> · <span class={styles.updateBadge}>{u().availableVersion} available</span></>}</Show>
                        </span>
                      </div>
                      <Show when={update()}>
                        {(u) => updateButton(pack.id, () => void store().updatePack(u().sourceName, u().entry))}
                      </Show>
                      {confirmRemove(pack.id, confirmingRemovePackId, setConfirmingRemovePackId, () => handleConfirmRemovePack(pack.id), 'Remove')}
                      <Show when={store().errorFor(pack.id)}>
                        <div class={styles.itemError}>{store().errorFor(pack.id)}</div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>

          <Show when={installedStandalone().length > 0}>
            <div class={styles.section}>
              <div class={styles.sectionTitle}>Individual analyzers</div>
              <For each={installedStandalone()}>
                {(proc) => {
                  const update = createMemo(() => processorUpdate(proc.id));
                  return (
                    <div class={styles.row} data-testid={`installed-processor-${proc.id}`}>
                      <div class={styles.rowInfo}>
                        <span class={styles.rowName}>
                          {proc.name} <span class={styles.rowVersion}>v{proc.version}</span>
                        </span>
                        <span class={styles.rowDesc}>
                          {proc.source}
                          <Show when={update()}>{(u) => <> · <span class={styles.updateBadge}>{u().availableVersion} available</span></>}</Show>
                        </span>
                      </div>
                      <Show when={update()}>
                        {updateButton(proc.id, () => void store().updateOne(proc.id))}
                      </Show>
                      {confirmRemove(proc.id, confirmingRemoveProcId, setConfirmingRemoveProcId, () => handleConfirmRemoveProcessor(proc.id), 'Uninstall')}
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* ── Updates ────────────────────────────────────────────────────── */}
      <Show when={tab() === 'updates'}>
        <div class={styles.tabBody} role="tabpanel" id={panelId('updates')} aria-labelledby={tabId('updates')}>
          <div class={styles.toolbar}>
            <button type="button" class={styles.btn} disabled={store().updatesLoading() || store().updatingAll()} onClick={() => void store().checkUpdates()}>
              {store().updatesLoading() ? 'Checking…' : 'Check for updates'}
            </button>
            <Show when={totalUpdates() > 1}>
              <button
                type="button"
                class={`${styles.btn} ${styles.btnPrimary}`}
                disabled={store().updatingAll() || store().updatesLoading()}
                onClick={() => void store().updateAll()}
              >
                {store().updatingAll()
                  ? `Updating… ${store().updateAllProgress().done} of ${store().updateAllProgress().total}`
                  : 'Update all'}
              </button>
            </Show>
          </div>
          <Show when={store().updatesError()}>
            {(message) => (
              <div class={styles.error} role="alert" data-testid="updates-check-error">
                Update check failed — {message()}
              </div>
            )}
          </Show>
          <Show when={store().updateErrors().length > 0}>
            <div class={styles.error} role="alert">
              <For each={store().updateErrors()}>{(e) => <div>{e.sourceName}: {e.error}</div>}</For>
            </div>
          </Show>
          <Show when={!store().updatesError() && totalUpdates() === 0}>
            <span class={styles.empty}>No pending updates.</span>
          </Show>
          <For each={store().pendingPackUpdates()}>
            {(u) => (
              <div class={styles.row} data-testid={`pack-update-row-${u.packId}`}>
                <div class={styles.rowInfo}>
                  <span class={styles.rowName}>{u.packName} <span class={styles.rowVersion}>pack</span></span>
                  <span class={styles.versionDiff}>{u.installedVersion} → <span class={styles.newVersion}>{u.availableVersion}</span></span>
                </div>
                {updateButton(u.packId, () => void store().updatePack(u.sourceName, u.entry))}
                <Show when={store().errorFor(u.packId)}>
                  <div class={styles.itemError}>{store().errorFor(u.packId)}</div>
                </Show>
              </div>
            )}
          </For>
          <For each={store().pendingUpdates()}>
            {(u) => (
              <div class={styles.row} data-testid={`update-row-${u.processorId}`}>
                <div class={styles.rowInfo}>
                  <span class={styles.rowName}>{u.processorName}</span>
                  <span class={styles.versionDiff}>{u.installedVersion} → <span class={styles.newVersion}>{u.availableVersion}</span></span>
                </div>
                {updateButton(u.processorId, () => void store().updateOne(u.processorId))}
                <Show when={store().errorFor(u.processorId)}>
                  <div class={styles.itemError}>{store().errorFor(u.processorId)}</div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* ── Library ────────────────────────────────────────────────────── */}
      <Show when={tab() === 'library'}>
        <div class={styles.tabBody} role="tabpanel" id={panelId('library')} aria-labelledby={tabId('library')}>
          {catalogToolbar('Filter analyzers…', 'Filter analyzers')}
          {noSourcesHint()}
          <div class={styles.hint}>Individual analyzers that are not part of any pack from this source.</div>
          <For each={filteredStandalone()}>
            {(entry) => {
              const installedId = createMemo(() => libraryInstalled().get(entry.id));
              return (
                <div class={styles.row} data-testid={`library-row-${entry.id}`}>
                  <div class={styles.rowInfo}>
                    <span class={styles.rowName}>{entry.name}</span>
                    <Show when={entry.description}><span class={styles.rowDesc}>{entry.description}</span></Show>
                  </div>
                  <Show
                    when={!installedId()}
                    fallback={
                      <Show when={installedId()}>
                        {(id) => confirmRemove(id(), confirmingRemoveProcId, setConfirmingRemoveProcId, () => handleConfirmRemoveProcessor(id()), 'Uninstall')}
                      </Show>
                    }
                  >
                    <button
                      type="button"
                      class={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={store().isPending(entry.id)}
                      onClick={() => {
                        const s = activeSource();
                        if (s) void store().installProcessor(s, entry);
                      }}
                    >
                      {store().isPending(entry.id) ? 'Adding…' : 'Add'}
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={enabledSources().length > 0 && filteredStandalone().length === 0}>
            <span class={styles.empty}>
              {standaloneEntries().length === 0 ? 'No standalone analyzers from this source.' : 'No analyzers match your filter.'}
            </span>
          </Show>
        </div>
      </Show>

      {/* ── Sources ────────────────────────────────────────────────────── */}
      <Show when={tab() === 'sources'}>
        <div class={styles.tabBody} role="tabpanel" id={panelId('sources')} aria-labelledby={tabId('sources')}>
          {props.sourcesPanel}
        </div>
      </Show>

      <Show when={detailsPack()}>
        {(pack) => (
          <PackDetailsDialog
            store={store()}
            pack={pack()}
            sourceName={activeSource() ?? ''}
            entriesById={entriesById()}
            installed={installedPackIds().has(pack().id)}
            onClose={() => setDetailsPackId(null)}
          />
        )}
      </Show>
    </div>
  );
}
