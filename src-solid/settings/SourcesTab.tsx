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
  // Two-step remove: the first click arms the row, the second confirms. Every
  // other destructive action in these modules is confirm-gated; a marketplace
  // source is no cheaper to re-create than a theme (L9).
  const [confirmingRemove, setConfirmingRemove] = createSignal<string | null>(null);
  const handleAdd = (): void => {
    const f = form();
    const name = f.name.trim();
    if (!name) { setError('name is required'); return; }
    // A source missing its location is accepted by the backend and then fails on
    // every fetch — reject it here where the user can still fix it (L9).
    const repo = f.repo.trim();
    const path = f.path.trim();
    if (f.type === 'github' && !repo) { setError('repo is required for a github source (owner/repo)'); return; }
    if (f.type === 'github' && !/^[^/\s]+\/[^/\s]+$/.test(repo)) { setError('repo must be in owner/repo form'); return; }
    if (f.type === 'local' && !path) { setError('path is required for a local source'); return; }
    const source: Source = f.type === 'github'
      ? { name, type: 'github', repo, enabled: true, autoUpdate: true }
      : { name, type: 'local', path, enabled: true, autoUpdate: false };
    setError(null);
    props.store.addSource(source).then(() => setForm(EMPTY_FORM)).catch((e: unknown) => setError(String(e)));
  };
  const handleRemove = (name: string): void => {
    setConfirmingRemove(null);
    props.store.removeSource(name).catch((e: unknown) => setError(String(e)));
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
                <Show
                  when={confirmingRemove() === source.name}
                  fallback={<button type="button" class={styles.iconBtn} title="Remove source" onClick={() => setConfirmingRemove(source.name)}>×</button>}
                >
                  <button type="button" class={styles.linkBtn} onClick={() => handleRemove(source.name)}>Remove?</button>
                  <button type="button" class={styles.iconBtn} title="Keep source" onClick={() => setConfirmingRemove(null)}>Cancel</button>
                </Show>
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
