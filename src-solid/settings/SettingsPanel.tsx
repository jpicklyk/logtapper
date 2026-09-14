/** @jsxImportSource solid-js */
import { For, Show, createSignal } from 'solid-js';
import type { ThemeController } from '../theme/applyTheme';
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
 */
export function SettingsPanel(props: SettingsPanelProps) {
  const [active, setActive] = createSignal<SettingsTab>('general');
  return (
    <div class={styles.panel} data-testid="settings-panel">
      <div class={styles.tabs} role="tablist">
        <For each={TABS}>
          {(tab) => (
            <button
              type="button"
              role="tab"
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
        <GeneralTab store={props.store} theme={props.theme} />
      </Show>
      <Show when={active() === 'pii'}>
        <PiiTab store={props.store} />
      </Show>
      <Show when={active() === 'themes'}>
        <ThemesTab store={props.store} />
      </Show>
      <Show when={active() === 'packs'}>
        <Show
          when={props.packs}
          fallback={<div class={styles.labelHint}>Packs are unavailable in this build.</div>}
        >
          {(packs) => <PacksPanel store={packs()} sourcesPanel={<SourcesTab store={props.store} />} />}
        </Show>
      </Show>
    </div>
  );
}
