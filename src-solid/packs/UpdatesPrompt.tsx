/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { PacksStore, UpdateAllOutcome } from './packsStore';
import styles from './packs.module.css';

export interface UpdatesPromptProps {
  store: PacksStore;
}

/** The launch-time "updates are available" dialog. Rendered by `App.tsx` at
 *  the top level while `store.updatePromptOpen()` is true — outside the
 *  shell's regions, since it must sit over whatever surface the app opened
 *  on. Pure over the store: the pending lists are the store's, **Update all**
 *  is `store.updateAll()`, and **Later** is `store.dismissUpdatePrompt()`
 *  (session-long — see the store). After a run with failures it stays open
 *  listing what is still pending, so nothing is swallowed. */
export function UpdatesPrompt(props: UpdatesPromptProps): JSX.Element {
  const [outcome, setOutcome] = createSignal<UpdateAllOutcome | null>(null);
  let primaryRef: HTMLButtonElement | undefined;

  const sources = createMemo(() =>
    [...new Set([
      ...props.store.pendingUpdates().map((u) => u.sourceName),
      ...props.store.pendingPackUpdates().map((u) => u.sourceName),
    ])].sort(),
  );
  const processorCount = (): number => props.store.pendingUpdates().length;
  const packCount = (): number => props.store.pendingPackUpdates().length;
  const failed = createMemo(() => {
    const o = outcome();
    return o ? o.failedProcessorIds.length + o.failedPackIds.length : 0;
  });

  const handleUpdateAll = async (): Promise<void> => {
    const result = await props.store.updateAll();
    if (result.failedProcessorIds.length === 0 && result.failedPackIds.length === 0) {
      props.store.dismissUpdatePrompt();
      return;
    }
    setOutcome(result);
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !props.store.updatingAll()) props.store.dismissUpdatePrompt();
  };

  onMount(() => {
    primaryRef?.focus();
    window.addEventListener('keydown', handleKey);
  });
  onCleanup(() => window.removeEventListener('keydown', handleKey));

  const summary = (): string => {
    const parts: string[] = [];
    if (processorCount() > 0) parts.push(`${processorCount()} analyzer update${processorCount() === 1 ? '' : 's'}`);
    if (packCount() > 0) parts.push(`${packCount()} pack update${packCount() === 1 ? '' : 's'}`);
    return parts.join(' and ');
  };

  return (
    <div class={styles.modalBackdrop} data-testid="updates-prompt">
      <div class={styles.modal} role="dialog" aria-modal="true" aria-labelledby="updates-prompt-title">
        <h2 id="updates-prompt-title" class={styles.modalTitle}>
          Updates available
        </h2>
        <p class={styles.modalLead}>
          {summary()} from {sources().join(', ')}.
        </p>
        <ul class={styles.modalList}>
          <For each={props.store.pendingPackUpdates()}>
            {(u) => (
              <li class={styles.modalRow}>
                <span class={styles.modalName}>{u.packName}</span>
                <span class={styles.modalVersion}>{u.installedVersion} → {u.availableVersion}</span>
                <Show when={props.store.errorFor(u.packId)}>
                  {(err) => <span class={styles.itemError}>{err()}</span>}
                </Show>
              </li>
            )}
          </For>
          <For each={props.store.pendingUpdates()}>
            {(u) => (
              <li class={styles.modalRow}>
                <span class={styles.modalName}>{u.processorName}</span>
                <span class={styles.modalVersion}>{u.installedVersion} → {u.availableVersion}</span>
                <Show when={props.store.errorFor(u.processorId)}>
                  {(err) => <span class={styles.itemError}>{err()}</span>}
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.store.updatingAll()}>
          <p class={styles.modalLead} role="status">
            Updating… {props.store.updateAllProgress().done} of {props.store.updateAllProgress().total}
          </p>
        </Show>
        <Show when={!props.store.updatingAll() && failed() > 0}>
          <p class={styles.error} role="alert">
            {failed()} update{failed() === 1 ? '' : 's'} failed and {failed() === 1 ? 'is' : 'are'} still pending.
            You can retry from Settings → Packs.
          </p>
        </Show>
        <div class={styles.modalActions}>
          <Show
            when={failed() === 0}
            fallback={
              <button type="button" class={styles.btn} onClick={() => props.store.dismissUpdatePrompt()}>
                Close
              </button>
            }
          >
            <button
              type="button"
              class={styles.btn}
              disabled={props.store.updatingAll()}
              onClick={() => props.store.dismissUpdatePrompt()}
            >
              Later
            </button>
            <button
              ref={primaryRef}
              type="button"
              class={`${styles.btn} ${styles.btnPrimary}`}
              disabled={props.store.updatingAll()}
              onClick={() => void handleUpdateAll()}
            >
              {props.store.updatingAll() ? 'Updating…' : 'Update all'}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
