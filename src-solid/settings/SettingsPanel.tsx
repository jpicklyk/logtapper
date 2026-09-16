/** @jsxImportSource solid-js */
import { For, Show, createSignal } from 'solid-js';
import type { ThemeController } from '../theme';
import type { SettingsStore } from './settingsStore';
import { GeneralTab } from './GeneralTab';
import { PiiTab } from './PiiTab';
import { ThemesTab } from './ThemesTab';
import { SourcesTab } from './SourcesTab';
import { PacksPanel } from '../packs';
import type { PacksStore } from '../packs';
import styles from './settings.module.css';
export interface SettingsPanelProps {
  store: SettingsStore;
  /** P1's remote-marketplace store, backing the Packs tab below. Optional so
   *  existing callers/tests that don't need Packs keep compiling; the tab is
   *  simply omitted when absent. */
  packs?: PacksStore;
  theme?: ThemeController;
}
type SettingsTab = 'general' | 'pii' | 'themes' | 'packs';
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'pii', label: 'PII' },
  { id: 'themes', label: 'Themes' },
  { id: 'packs', label: 'Packs' },
];
const tabId = (id: SettingsTab): string => `settings-tab-${id}`;
const panelId = (id: SettingsTab): string => `settings-tabpanel-${id}`;
/**
 * The `settings` shell surface (W8): tab bar + the active tab's content,
 * mounted in the rail's overlay drawer (which already supplies the header,
 * close button, padding and scroll — see `shell/AppShell.tsx`).
 *
 * The former standalone "Sources" tab is gone (P1): brief §3 demotes
 * marketplace sources — along with the standalone-analyzer library and
 * update management — under the Packs tab's "Advanced" disclosure.
 * `SourcesTab` itself is unchanged; it is now mounted from here as a slot
 * handed to `PacksPanel` rather than as its own top-level tab. See
 * `packs/PacksPanel.tsx`'s doc comment for why it is a slot instead of a
 * direct cross-module import.
 *
 * The tab bar is a complete ARIA tab widget: one tab stop for the whole strip
 * (roving `tabindex`), arrow/Home/End to move between tabs, and every tab
 * `aria-controls`-paired with the `tabpanel` it reveals.
 */
export function SettingsPanel(props: SettingsPanelProps) {
  const [active, setActive] = createSignal<SettingsTab>('general');
  let stripRef: HTMLDivElement | undefined;
  const focusTab = (id: SettingsTab): void => {
    setActive(id);
    stripRef?.querySelector<HTMLButtonElement>(`#${tabId(id)}`)?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'Home') return focusTab(TABS[0].id);
    if (event.key === 'End') return focusTab(TABS[TABS.length - 1].id);
    const current = TABS.findIndex((t) => t.id === active());
    focusTab(TABS[(current + delta + TABS.length) % TABS.length].id);
  };
  return (
    <div class={styles.panel} data-testid="settings-panel">
      <Show when={props.store.error()}>
        {(message) => (
          <div class={styles.errorBanner} role="alert" data-testid="settings-error">
            <span class={styles.errorBannerText}>{message()}</span>
            <button type="button" class={styles.iconBtn} title="Dismiss" onClick={() => props.store.clearError()}>
              ×
            </button>
          </div>
        )}
      </Show>
      <div class={styles.tabs} role="tablist" ref={stripRef} onKeyDown={onTabKeyDown}>
        <For each={TABS}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-controls={panelId(tab.id)}
              tabindex={active() === tab.id ? 0 : -1}
              class={`${styles.tab} ${active() === tab.id ? styles.tabActive : ''}`}
              aria-selected={active() === tab.id}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <Show when={active() === 'general'}>
        <div role="tabpanel" id={panelId('general')} aria-labelledby={tabId('general')}>
          <GeneralTab store={props.store} theme={props.theme} />
        </div>
      </Show>
      <Show when={active() === 'pii'}>
        <div role="tabpanel" id={panelId('pii')} aria-labelledby={tabId('pii')}>
          <PiiTab store={props.store} />
        </div>
      </Show>
      <Show when={active() === 'themes'}>
        <div role="tabpanel" id={panelId('themes')} aria-labelledby={tabId('themes')}>
          <ThemesTab store={props.store} theme={props.theme} />
        </div>
      </Show>
      <Show when={active() === 'packs'}>
        <div role="tabpanel" id={panelId('packs')} aria-labelledby={tabId('packs')}>
          <Show
            when={props.packs}
            fallback={<div class={styles.labelHint}>Packs are unavailable in this build.</div>}
          >
            {(packs) => <PacksPanel store={packs()} sourcesPanel={<SourcesTab store={props.store} />} />}
          </Show>
        </div>
      </Show>
    </div>
  );
}
