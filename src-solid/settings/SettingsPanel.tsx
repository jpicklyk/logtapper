/** @jsxImportSource solid-js */
import { For, Show, createSignal } from 'solid-js';
import type { ThemeController } from '../theme/applyTheme';
import type { SettingsStore } from './settingsStore';
import { GeneralTab } from './GeneralTab';
import { PiiTab } from './PiiTab';
import { ThemesTab } from './ThemesTab';
import { SourcesTab } from './SourcesTab';
import styles from './settings.module.css';
export interface SettingsPanelProps {
  store: SettingsStore;
  theme?: ThemeController;
}
type SettingsTab = 'general' | 'pii' | 'themes' | 'sources';
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'pii', label: 'PII' },
  { id: 'themes', label: 'Themes' },
  { id: 'sources', label: 'Sources' },
];
/**
 * The `settings` shell surface (W8): tab bar + the active tab's content,
 * mounted in the rail's overlay drawer (which already supplies the header,
 * close button, padding and scroll — see `shell/AppShell.tsx`).
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
      <Show when={active() === 'sources'}>
        <SourcesTab store={props.store} />
      </Show>
    </div>
  );
}
