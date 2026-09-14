/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { MarketplaceEntry, MarketplacePackEntry } from '@bridge/types';
import { matchesQuery } from '@bridge/types';
import type { PacksStore } from './packsStore';
import styles from './packs.module.css';

const OTHER_CATEGORY = 'Other';

export interface PacksPanelProps {
  store: PacksStore;
  /**
   * The existing `settings/SourcesTab.tsx`, rendered unchanged inside the
   * Advanced disclosure below — passed as a slot rather than imported
   * directly so this module never reaches into `settings/`'s internals
   * (barrel-export rule: `settings/index.ts` does not export `SourcesTab`,
   * on purpose, because nothing outside `SettingsPanel.tsx` mounted it
   * before this package). See this package's implementation-notes.
   */
  sourcesPanel: JSX.Element;
}

/**
 * The `settings` surface's primary Packs tab (brief §3): curated packs by
 * subsystem, grouped by `category`, each with a plain-language description —
 * "add pack" is a two-step action (preview the member analyzers, then
 * confirm) because installing runs third-party processor YAML. Library
 * (standalone analyzers), marketplace sources and update management sit
 * inside the `<details>` "Advanced" disclosure beneath the curated grid, per
 * brief §3's "library, YAML authoring, sources, updates and uninstall move
 * under an Advanced disclosure".
 */
export function PacksPanel(props: PacksPanelProps): JSX.Element {
  const store = () => props.store;
  const [query, setQuery] = createSignal('');
  const [confirmingPackId, setConfirmingPackId] = createSignal<string | null>(null);
  const [confirmingRemovePackId, setConfirmingRemovePackId] = createSignal<string | null>(null);
  const [confirmingRemoveProcId, setConfirmingRemoveProcId] = createSignal<string | null>(null);

  const enabledSources = createMemo(() => store().sources().filter((s) => s.enabled));

  onMount(() => {
    const first = enabledSources()[0];
    if (first) void store().fetchEntries(first.name);
  });

  const installedPackIds = createMemo(() => new Set(store().installedPacks().map((p) => p.id)));
  const installedProcessorIds = createMemo(() => new Set(store().installedProcessors().map((p) => p.id)));
  const entriesById = createMemo(() => new Map(store().entries().map((e) => [e.id, e])));

  const filteredPacks = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? store().packEntries().filter((p) => matchesQuery(p, q)) : store().packEntries();
  });

  const grouped = createMemo<Array<[string, MarketplacePackEntry[]]>>(() => {
    const map = new Map<string, MarketplacePackEntry[]>();
    for (const p of filteredPacks()) {
      const key = p.category ?? OTHER_CATEGORY;
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return [...map.entries()].sort(([a], [b]) => {
      if (a === OTHER_CATEGORY) return 1;
      if (b === OTHER_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  });

  // Standalone analyzers not covered by any pack from this source — the
  // demoted "library" browsing view, per brief §3.
  const packMemberIds = createMemo(() => {
    const ids = new Set<string>();
    for (const p of store().packEntries()) for (const pid of p.processorIds) ids.add(pid);
    return ids;
  });
  const standaloneEntries = createMemo<MarketplaceEntry[]>(() => store().entries().filter((e) => !packMemberIds().has(e.id)));

  const handleSourceChange = (e: Event): void => {
    const name = (e.currentTarget as HTMLSelectElement).value;
    void store().fetchEntries(name);
    setQuery('');
  };

  const handleConfirmInstallPack = (entry: MarketplacePackEntry): void => {
    const src = store().selectedSource();
    if (!src) return;
    setConfirmingPackId(null);
    void store().installPack(src, entry);
  };

  const handleConfirmRemovePack = (packId: string): void => {
    const src = store().selectedSource();
    setConfirmingRemovePackId(null);
    if (!src) return;
    void store().uninstallPack(src, packId);
  };

  const handleConfirmRemoveProcessor = (processorId: string): void => {
    setConfirmingRemoveProcId(null);
    void store().uninstallProcessor(processorId);
  };

  const totalUpdates = createMemo(() => store().pendingUpdates().length + store().pendingPackUpdates().length);

  return (
    <div class={styles.panel} data-testid="packs-panel">
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
          placeholder="Filter packs…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          aria-label="Filter packs"
        />
        <button
          type="button"
          class={styles.fetchBtn}
          disabled={store().entriesLoading() || !store().selectedSource()}
          onClick={() => {
            const s = store().selectedSource();
            if (s) void store().fetchEntries(s);
          }}
        >
          {store().entriesLoading() ? 'Loading…' : store().packEntries().length > 0 ? 'Refresh' : 'Fetch'}
        </button>
      </div>

      <Show when={enabledSources().length === 0}>
        <div class={styles.empty}>No marketplace sources configured. Open Advanced below to add one.</div>
      </Show>

      <Show when={store().entriesError()}>
        <div class={styles.error} role="alert">{store().entriesError()}</div>
      </Show>

      <Show when={totalUpdates() > 0}>
        <div class={styles.updateBar} data-testid="packs-update-summary">
          <span>{totalUpdates()} update{totalUpdates() === 1 ? '' : 's'} available — see Advanced</span>
        </div>
      </Show>

      <Show when={enabledSources().length > 0 && filteredPacks().length === 0 && !store().entriesLoading()}>
        <div class={styles.empty}>
          {store().packEntries().length === 0 ? 'No packs found. Try Fetch or a different source.' : 'No packs match your filter.'}
        </div>
      </Show>

      <For each={grouped()}>
        {([category, packs]) => (
          <div>
            <div class={styles.groupLabel}>{category}</div>
            <div class={styles.grid}>
              <For each={packs}>
                {(pack) => {
                  const installed = createMemo(() => installedPackIds().has(pack.id));
                  const update = createMemo(() => store().pendingPackUpdates().find((u) => u.packId === pack.id));
                  const accent = createMemo(() => (installed() ? 'var(--success)' : 'var(--border)'));
                  return (
                    <div class={styles.card} data-testid={`pack-card-${pack.id}`} style={{ '--pack-accent': accent() } as JSX.CSSProperties}>
                      <div class={styles.cardTop}>
                        <span class={styles.cardName}>{pack.name}</span>
                      </div>
                      <Show when={pack.description}>
                        <div class={styles.cardDesc}>{pack.description}</div>
                      </Show>
                      <div class={styles.badgeRow}>
                        <Show when={pack.category}><span class={styles.categoryBadge}>{pack.category}</span></Show>
                        <span class={styles.categoryBadge}>
                          {pack.processorIds.length} analyzer{pack.processorIds.length === 1 ? '' : 's'}
                        </span>
                        <Show when={installed()}><span class={styles.installedBadge}>Added</span></Show>
                        <Show when={update()}><span class={styles.updateBadge}>Update available</span></Show>
                      </div>
                      <Show when={pack.tags.length > 0}>
                        <div class={styles.tagRow}><For each={pack.tags}>{(t) => <span class={styles.tag}>{t}</span>}</For></div>
                      </Show>

                      <div class={styles.cardActions}>
                        <Show
                          when={!installed()}
                          fallback={
                            <Show
                              when={confirmingRemovePackId() !== pack.id}
                              fallback={
                                <>
                                  <button type="button" class={`${styles.btn} ${styles.btnDanger}`} onClick={() => handleConfirmRemovePack(pack.id)}>
                                    Confirm remove
                                  </button>
                                  <button type="button" class={styles.btn} onClick={() => setConfirmingRemovePackId(null)}>Cancel</button>
                                </>
                              }
                            >
                              <Show
                                when={update()}
                                fallback={
                                  <button
                                    type="button"
                                    class={styles.btn}
                                    disabled={store().isPending(pack.id)}
                                    onClick={() => setConfirmingRemovePackId(pack.id)}
                                  >
                                    {store().isPending(pack.id) ? 'Working…' : 'Remove'}
                                  </button>
                                }
                              >
                                <button
                                  type="button"
                                  class={`${styles.btn} ${styles.btnPrimary}`}
                                  disabled={store().isPending(pack.id)}
                                  onClick={() => {
                                    const u = update();
                                    if (u) void store().updatePack(u.sourceName, u.entry);
                                  }}
                                >
                                  {store().isPending(pack.id) ? 'Updating…' : 'Update'}
                                </button>
                              </Show>
                            </Show>
                          }
                        >
                          <button
                            type="button"
                            class={`${styles.btn} ${styles.btnPrimary}`}
                            disabled={store().isPending(pack.id)}
                            onClick={() => setConfirmingPackId(pack.id)}
                          >
                            {store().isPending(pack.id) ? 'Adding…' : 'Add pack'}
                          </button>
                        </Show>
                      </div>

                      <Show when={store().errorFor(pack.id)}>
                        <div class={styles.itemError}>{store().errorFor(pack.id)}</div>
                      </Show>

                      <Show when={confirmingPackId() === pack.id}>
                        <div class={styles.preview} data-testid={`pack-preview-${pack.id}`}>
                          <div class={styles.previewTitle}>
                            This pack adds {pack.processorIds.length} analyzer{pack.processorIds.length === 1 ? '' : 's'}:
                          </div>
                          <For each={pack.processorIds}>
                            {(pid) => {
                              const entry = entriesById().get(pid);
                              return (
                                <div class={styles.previewRow}>
                                  <span class={styles.previewName}>{entry?.name ?? pid}</span>
                                  <Show when={entry?.description}><span class={styles.previewDesc}>{entry?.description}</span></Show>
                                </div>
                              );
                            }}
                          </For>
                          <div class={styles.previewActions}>
                            <button type="button" class={`${styles.btn} ${styles.btnPrimary}`} onClick={() => handleConfirmInstallPack(pack)}>
                              Confirm add
                            </button>
                            <button type="button" class={styles.btn} onClick={() => setConfirmingPackId(null)}>Cancel</button>
                          </div>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        )}
      </For>

      <details class={styles.advanced} data-testid="packs-advanced">
        <summary class={styles.advancedSummary}>Advanced</summary>
        <div class={styles.advancedBody}>
          <div class={styles.section}>
            <div class={styles.sectionTitle}>Library — individual analyzers</div>
            <For each={standaloneEntries()}>
              {(entry) => {
                const installed = createMemo(() => installedProcessorIds().has(entry.id));
                return (
                  <div class={styles.row} data-testid={`library-row-${entry.id}`}>
                    <div class={styles.rowInfo}>
                      <span class={styles.rowName}>{entry.name}</span>
                      <Show when={entry.description}><span class={styles.rowDesc}>{entry.description}</span></Show>
                    </div>
                    <Show
                      when={!installed()}
                      fallback={
                        <Show
                          when={confirmingRemoveProcId() !== entry.id}
                          fallback={
                            <>
                              <button type="button" class={`${styles.btn} ${styles.btnDanger}`} onClick={() => handleConfirmRemoveProcessor(entry.id)}>
                                Confirm
                              </button>
                              <button type="button" class={styles.btn} onClick={() => setConfirmingRemoveProcId(null)}>Cancel</button>
                            </>
                          }
                        >
                          <button
                            type="button"
                            class={styles.btn}
                            disabled={store().isPending(entry.id)}
                            onClick={() => setConfirmingRemoveProcId(entry.id)}
                          >
                            {store().isPending(entry.id) ? 'Working…' : 'Uninstall'}
                          </button>
                        </Show>
                      }
                    >
                      <button
                        type="button"
                        class={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={store().isPending(entry.id)}
                        onClick={() => {
                          const s = store().selectedSource();
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
            <Show when={standaloneEntries().length === 0}>
              <span class={styles.empty}>No standalone analyzers from this source.</span>
            </Show>
          </div>

          <div class={styles.section}>
            <div class={styles.sectionTitle}>Marketplace sources</div>
            {props.sourcesPanel}
          </div>

          <div class={styles.section}>
            <div class={styles.sectionTitle}>Updates</div>
            <button type="button" class={styles.btn} disabled={store().updatesLoading()} onClick={() => void store().checkUpdates()}>
              {store().updatesLoading() ? 'Checking…' : 'Check for updates'}
            </button>
            <Show when={store().updateErrors().length > 0}>
              <div class={styles.error} role="alert">
                <For each={store().updateErrors()}>{(e) => <div>{e.sourceName}: {e.error}</div>}</For>
              </div>
            </Show>
            <Show when={store().pendingUpdates().length === 0 && store().pendingPackUpdates().length === 0}>
              <span class={styles.empty}>No pending updates.</span>
            </Show>
            <For each={store().pendingUpdates()}>
              {(u) => (
                <div class={styles.row} data-testid={`update-row-${u.processorId}`}>
                  <div class={styles.rowInfo}>
                    <span class={styles.rowName}>{u.processorName}</span>
                    <span class={styles.versionDiff}>{u.installedVersion} → <span class={styles.newVersion}>{u.availableVersion}</span></span>
                  </div>
                  <button
                    type="button"
                    class={styles.btn}
                    disabled={store().isPending(u.processorId)}
                    onClick={() => void store().updateOne(u.processorId)}
                  >
                    {store().isPending(u.processorId) ? 'Updating…' : 'Update'}
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </details>
    </div>
  );
}
