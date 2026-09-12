/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { WorkspaceStore } from './workspaceStore';
import styles from './switcher.module.css';

const LTW_SAVE_FILTERS = [{ name: 'LogTapper Workspace', extensions: ['ltw'] }];

export interface SwitcherProps {
  store: WorkspaceStore;
}

/**
 * Compact top-bar picker: active workspace name (+ dirty marker), a dropdown
 * of recent workspaces to switch into, and Save / Save As. Switching and
 * saving both route through the store — no dialog or IPC call happens here
 * beyond the native Save As picker (the same `Ui`-consent pattern `EditorTab`
 * and `AppActions.openFileDialog` already use).
 */
export function Switcher(props: SwitcherProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [error, setError] = createSignal('');

  const active = createMemo(() => props.store.active());
  const displayName = createMemo(() => active()?.name ?? 'No workspace');

  const close = (): void => {
    setOpen(false);
  };
  const toggle = (): void => {
    setOpen((v) => !v);
  };

  const handleSwitch = (id: string): void => {
    close();
    if (id === props.store.activeId()) return;
    setError('');
    void props.store.switchWorkspace(id).catch((e: unknown) => setError(String(e)));
  };

  const handleSave = (): void => {
    close();
    setError('');
    void props.store.saveWorkspace().catch((e: unknown) => setError(String(e)));
  };

  const handleSaveAs = async (): Promise<void> => {
    close();
    const dest = await saveDialog({ filters: LTW_SAVE_FILTERS });
    if (typeof dest !== 'string') return;
    setError('');
    try {
      await props.store.saveWorkspace(dest);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      class={styles.switcher}
      data-testid="workspace-switcher"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open()) return;
        event.stopPropagation();
        close();
      }}
    >
      <button
        type="button"
        class={styles.trigger}
        aria-expanded={open()}
        onClick={toggle}
        title={active() ? `${active()!.name}${props.store.dirty() ? ' (unsaved)' : ''}` : 'No workspace'}
      >
        <Show when={props.store.dirty()}>
          <span class={styles.dirtyDot} title="Unsaved changes" />
        </Show>
        <span class={styles.name}>{displayName()}</span>
        <span class={styles.chevron} aria-hidden="true">
          ▾
        </span>
      </button>

      <Show when={open()}>
        <button type="button" class={styles.backdrop} aria-label="Close" onClick={close} />
        <div class={styles.panel} role="menu" data-testid="workspace-switcher-panel">
          <Show when={props.store.list().length > 0}>
            <div class={styles.sectionLabel}>Workspaces</div>
            <For each={props.store.list()}>
              {(ws) => (
                <button
                  type="button"
                  class={styles.item}
                  classList={{ [styles.itemActive]: ws.id === props.store.activeId() }}
                  onClick={() => handleSwitch(ws.id)}
                >
                  <span class={styles.itemDot} classList={{ [styles.itemDotActive]: ws.id === props.store.activeId() }} />
                  <span class={styles.itemName}>{ws.name}</span>
                  <Show when={ws.dirty}>
                    <span class={styles.itemDirty}>*</span>
                  </Show>
                </button>
              )}
            </For>
            <div class={styles.separator} />
          </Show>
          <button type="button" class={styles.actionItem} onClick={handleSave}>
            Save
          </button>
          <button type="button" class={styles.actionItem} onClick={() => void handleSaveAs()}>
            Save As…
          </button>
        </div>
      </Show>

      <Show when={error()}>
        <div class={styles.error} role="alert">
          {error()}
        </div>
      </Show>
    </div>
  );
}
