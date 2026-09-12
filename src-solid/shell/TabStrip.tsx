/** @jsxImportSource solid-js */
import { For, Show, onCleanup, onMount } from 'solid-js';
import styles from './tabstrip.module.css';

/**
 * What a tab points at. Session tabs come first, editor tabs after — the strip
 * renders `tabs` in the order given and does not sort, so the caller owns that
 * grouping (W9 appends its editor tabs to the session list).
 */
export type TabKind = 'session' | 'editor';

export interface TabDescriptor {
  /** Unique within the strip. For a session tab this is the `sessionId`. */
  key: string;
  label: string;
  kind: TabKind;
  /** Editor tabs with unsaved changes show a dot. */
  dirty?: boolean;
  closable: boolean;
}

export interface TabStripProps {
  tabs: readonly TabDescriptor[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}

/**
 * The tab strip above the viewer.
 *
 * Props only — it owns no session state and never calls the store. That is what
 * lets the same strip carry session tabs (W0b) and editor tabs (W9) without
 * knowing the difference between them.
 *
 * Ctrl+Tab / Ctrl+Shift+Tab cycle through the tabs and wrap. The listener is on
 * `window` because the shortcut has to work while focus is in the log viewer,
 * which is where it always is.
 */
export function TabStrip(props: TabStripProps) {
  const cycle = (delta: number): void => {
    const tabs = props.tabs;
    if (tabs.length < 2) return;
    const current = tabs.findIndex((tab) => tab.key === props.activeKey);
    const from = current === -1 ? 0 : current;
    const next = (from + delta + tabs.length) % tabs.length;
    props.onSelect(tabs[next].key);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || !event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    cycle(event.shiftKey ? -1 : 1);
  };

  onMount(() => {
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  const close = (tab: TabDescriptor): void => {
    if (tab.closable) props.onClose(tab.key);
  };

  return (
    <div class={styles.strip} role="tablist" aria-label="Open tabs">
      <For each={props.tabs}>
        {(tab) => (
          <div
            class={styles.tab}
            classList={{ [styles.tabActive]: tab.key === props.activeKey }}
            role="tab"
            tabIndex={tab.key === props.activeKey ? 0 : -1}
            aria-selected={tab.key === props.activeKey}
            data-kind={tab.kind}
            data-key={tab.key}
            onClick={() => props.onSelect(tab.key)}
            // Middle-click closes, the way every editor's tab strip does.
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              close(tab);
            }}
          >
            <span class={styles.label}>{tab.label}</span>
            <Show when={tab.dirty}>
              <span class={styles.dirty} aria-label="Unsaved changes" title="Unsaved changes">
                ●
              </span>
            </Show>
            <Show when={tab.closable}>
              <button
                type="button"
                class={styles.close}
                aria-label={`Close ${tab.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  close(tab);
                }}
              >
                ×
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
