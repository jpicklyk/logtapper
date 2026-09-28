/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { JSX } from 'solid-js';
import type { MarketplaceEntry, MarketplacePackEntry } from '@bridge/types';
import { createOverlayDialog } from '../ui';
import type { PacksStore } from './packsStore';
import styles from './packs.module.css';

export interface PackDetailsDialogProps {
  store: PacksStore;
  pack: MarketplacePackEntry;
  /** The source the pack was browsed from — install and remove act on it. */
  sourceName: string;
  entriesById: Map<string, MarketplaceEntry>;
  installed: boolean;
  onClose: () => void;
}

/**
 * One pack's full detail — every member analyzer with its description,
 * version, source and tags — and the only place a pack is added or removed
 * from the Browse tab. Adding stays a two-step action (open this, then
 * confirm) because installing runs third-party processor YAML; removing is
 * confirm-gated inside the dialog.
 *
 * Portalled to `<body>`: the Settings drawer it opens from is itself an
 * overlay, and a `position: fixed` element inside a transformed ancestor is
 * clipped to that ancestor. Escape is handled on the dialog root with
 * `stopPropagation` (`createOverlayDialog`), so it closes this dialog without
 * also closing the drawer behind it.
 */
export function PackDetailsDialog(props: PackDetailsDialogProps): JSX.Element {
  const dialog = createOverlayDialog(() => props.onClose());
  const [confirmingRemove, setConfirmingRemove] = createSignal(false);
  const pending = (): boolean => props.store.isPending(props.pack.id);
  const update = createMemo(() => props.store.pendingPackUpdates().find((u) => u.packId === props.pack.id));
  const count = (): number => props.pack.processorIds.length;

  return (
    <Portal>
      <div
        class={styles.modalBackdrop}
        data-testid="pack-details-backdrop"
        onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      >
        <div class={`${styles.modal} ${styles.detailsModal}`} data-testid={`pack-details-${props.pack.id}`} {...dialog.props}>
          <div class={styles.detailsHeader}>
            <h2 id={dialog.labelId} class={styles.modalTitle}>{props.pack.name}</h2>
            <button type="button" class={styles.iconBtn} aria-label="Close" title="Close" onClick={() => props.onClose()}>
              ×
            </button>
          </div>

          <div class={styles.detailsMeta}>
            <span>v{props.pack.version}</span>
            <Show when={props.pack.category}><span>{props.pack.category}</span></Show>
            <span>from {props.sourceName}</span>
            <Show when={props.installed}><span class={styles.installedBadge}>Added</span></Show>
            <Show when={update()}>
              {(u) => <span class={styles.updateBadge}>Update available: {u().availableVersion}</span>}
            </Show>
          </div>

          <Show when={props.pack.description}>
            <p class={styles.modalLead}>{props.pack.description}</p>
          </Show>

          <Show when={props.pack.tags.length > 0}>
            <div class={styles.tagRow}><For each={props.pack.tags}>{(t) => <span class={styles.tag}>{t}</span>}</For></div>
          </Show>

          <div class={styles.previewTitle}>
            {props.installed ? 'This pack includes' : 'This pack adds'} {count()} analyzer{count() === 1 ? '' : 's'}:
          </div>
          <ul class={styles.modalList}>
            <For each={props.pack.processorIds}>
              {(pid) => {
                const entry = props.entriesById.get(pid);
                return (
                  <li class={styles.previewRow}>
                    <span class={styles.previewName}>{entry?.name ?? pid}</span>
                    <Show when={entry?.description}><span class={styles.previewDesc}>{entry?.description}</span></Show>
                  </li>
                );
              }}
            </For>
          </ul>

          <Show when={props.store.errorFor(props.pack.id)}>
            {(err) => <div class={styles.error} role="alert">{err()}</div>}
          </Show>

          <div class={styles.modalActions}>
            <Show
              when={props.installed}
              fallback={
                <>
                  <button type="button" class={styles.btn} onClick={() => props.onClose()}>Cancel</button>
                  <button
                    type="button"
                    class={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={pending()}
                    onClick={() => void props.store.installPack(props.sourceName, props.pack)}
                  >
                    {pending() ? 'Adding…' : 'Confirm add'}
                  </button>
                </>
              }
            >
              <Show
                when={!confirmingRemove()}
                fallback={
                  <>
                    <button type="button" class={styles.btn} onClick={() => setConfirmingRemove(false)}>Cancel</button>
                    <button
                      type="button"
                      class={`${styles.btn} ${styles.btnDanger}`}
                      onClick={() => {
                        setConfirmingRemove(false);
                        void props.store.uninstallPack(props.sourceName, props.pack.id);
                      }}
                    >
                      Confirm remove
                    </button>
                  </>
                }
              >
                <button type="button" class={styles.btn} disabled={pending()} onClick={() => setConfirmingRemove(true)}>
                  Remove
                </button>
                <Show when={update()}>
                  {(u) => (
                    <button
                      type="button"
                      class={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={pending()}
                      onClick={() => void props.store.updatePack(u().sourceName, u().entry)}
                    >
                      {pending() ? 'Updating…' : 'Update'}
                    </button>
                  )}
                </Show>
                <button type="button" class={styles.btn} onClick={() => props.onClose()}>Close</button>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
