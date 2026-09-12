/** @jsxImportSource solid-js */
import { For, Show, createSignal, onMount } from 'solid-js';
import type { Source } from '@bridge/types';
import type { SettingsStore } from './settingsStore';
import styles from './settings.module.css';
export interface SourcesTabProps { store: SettingsStore }
const EMPTY_FORM = { name: '', type: 'github' as Source['type'], repo: '', path: '' };
export function SourcesTab(props: SourcesTabProps) {
  const [form, setForm] = createSignal(EMPTY_FORM);
  const [error, setError] = createSignal<string | null>(null);
  onMount(() => props.store.refreshSources());
  const handleAdd = (): void => {
    const f = form();
    const name = f.name.trim();
    if (!name) { setError('name is required'); return; }
    const source: Source = f.type === 'github'
      ? { name, type: 'github', repo: f.repo.trim(), enabled: true, autoUpdate: true }
      : { name, type: 'local', path: f.path.trim(), enabled: true, autoUpdate: false };
    setError(null);
    props.store.addSource(source).then(() => setForm(EMPTY_FORM)).catch((e: unknown) => setError(String(e)));
  };
  return (
    <div class={styles.panel} data-testid="sources-tab">
      <div class={styles.section}>
        <div class={styles.sectionTitle}>Marketplace Sources</div>
        <div class={styles.list}>
          <For each={props.store.sources()}>
            {(source) => (
              <div class={styles.listRow}>
                <span class={styles.listRowPath}>{source.name} ({source.type}: {source.type === 'github' ? source.repo : source.path})</span>
                <button type="button" class={styles.iconBtn} title="Remove source" onClick={() => void props.store.removeSource(source.name)}>×</button>
              </div>
            )}
          </For>
          <Show when={props.store.sources().length === 0}><span class={styles.labelHint}>No marketplace sources configured.</span></Show>
        </div>
      </div>
      <div class={styles.section}>
        <div class={styles.sectionTitle}>Add Source</div>
        <div class={styles.row}>
          <span>Name</span>
          <input class={styles.input} type="text" value={form().name} onInput={(e) => setForm((p) => ({ ...p, name: e.currentTarget.value }))} />
        </div>
        <div class={styles.row}>
          <span>Type</span>
          <select class={styles.select} value={form().type} onChange={(e) => setForm((p) => ({ ...p, type: e.currentTarget.value as Source['type'] }))}>
            <option value="github">github</option>
            <option value="local">local</option>
          </select>
        </div>
        <Show when={form().type === 'github'}>
          <div class={styles.row}><span>Repo</span><input class={styles.input} type="text" placeholder="owner/repo" value={form().repo} onInput={(e) => setForm((p) => ({ ...p, repo: e.currentTarget.value }))} /></div>
        </Show>
        <Show when={form().type === 'local'}>
          <div class={styles.row}><span>Path</span><input class={styles.input} type="text" value={form().path} onInput={(e) => setForm((p) => ({ ...p, path: e.currentTarget.value }))} /></div>
        </Show>
        <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
        <button type="button" class={styles.primaryButton} onClick={handleAdd}>Add source</button>
      </div>
    </div>
  );
}
