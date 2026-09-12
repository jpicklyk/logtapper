/** @jsxImportSource solid-js */
import { For, Show, createSignal, onMount, untrack } from 'solid-js';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { BASE_THEMES } from '../theme/applyTheme';
import type { ThemeBase } from '../theme/applyTheme';
import { AA_NORMAL_TEXT, contrastRatio } from '../theme/contrast';
import { validateUserTheme } from '../theme/userTheme';
import type { SettingsStore } from './settingsStore';
import styles from './settings.module.css';
export interface ThemesTabProps { store: SettingsStore }
/** Curated tokens the editor exposes (the live AA check applies to these);
 *  `userTheme.ts`'s `KNOWN_TOKENS` covers ~70 more, which an imported file
 *  round-trips untouched even though this form only edits the subset. */
const EDITABLE_TOKENS = ['--surface', '--text', '--text-subtle', '--accent', '--border', '--danger'] as const;
interface Draft { slug: string; isNew: boolean; name: string; base: ThemeBase; tokens: Record<string, string> }
const EMPTY_DRAFT: Draft = { slug: '', isNew: true, name: '', base: 'dark', tokens: {} };
/** The live half of the AA check: judged against what is actually painted. */
function liveTokenValue(token: string): string {
  if (typeof document === 'undefined') return '#000000';
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#000000';
}
/** AA contrast against a token's natural counterpart; `null` if it has none. */
function contrastFor(token: string, value: string): { ratio: number; passes: boolean } | null {
  try {
    const other = token.startsWith('--text') ? liveTokenValue('--surface') : token === '--surface' ? liveTokenValue('--text') : null;
    if (other === null) return null;
    const ratio = token === '--surface' ? contrastRatio(other, value) : contrastRatio(value, other);
    return { ratio, passes: ratio >= AA_NORMAL_TEXT };
  } catch {
    return null;
  }
}
function deriveSlug(path: string): string {
  return (path.split(/[\\/]/).pop() ?? 'theme').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}
export function ThemesTab(props: ThemesTabProps) {
  const [draft, setDraft] = createSignal<Draft>(EMPTY_DRAFT);
  const [error, setError] = createSignal<string | null>(null);
  onMount(() => props.store.refreshThemes());
  const startNew = (): void => {
    setError(null);
    setDraft(EMPTY_DRAFT);
  };
  const startEdit = (slug: string): void => {
    setError(null);
    props.store.readTheme(slug)
      .then((theme) => setDraft({ slug, isNew: false, name: theme.name, base: theme.base, tokens: { ...theme.tokens } }))
      .catch((e: unknown) => setError(String(e)));
  };
  const setToken = (key: string, value: string): void => {
    setDraft((prev) => {
      const tokens = { ...prev.tokens };
      if (value.trim()) tokens[key] = value;
      else delete tokens[key];
      return { ...prev, tokens };
    });
  };
  const buildTheme = () => validateUserTheme({ name: draft().name, base: draft().base, tokens: draft().tokens });
  const handleSave = (): void => {
    const slug = draft().slug.trim();
    if (!slug) { setError('slug is required'); return; }
    const result = buildTheme();
    if (!result.valid || !result.theme) { setError(result.errors.join('; ')); return; }
    setError(null);
    props.store.saveTheme(slug, result.theme).then(() => setDraft((prev) => ({ ...prev, slug, isNew: false }))).catch((e: unknown) => setError(String(e)));
  };
  const handleDelete = (slug: string): void => {
    // Untracked: this runs outside any Solid computation (a promise callback), so the read is a one-time check.
    props.store.deleteTheme(slug).then(() => { if (untrack(draft).slug === slug) startNew(); }).catch((e: unknown) => setError(String(e)));
  };
  const handleImport = async (): Promise<void> => {
    const path = await openFileDialog({ multiple: false, filters: [{ name: 'Theme', extensions: ['json'] }] }).catch(() => null);
    if (typeof path !== 'string') return;
    const slug = deriveSlug(path);
    props.store.importThemeFromFile(path, slug)
      .then((theme) => setDraft({ slug, isNew: false, name: theme.name, base: theme.base, tokens: { ...theme.tokens } }))
      .catch((e: unknown) => setError(String(e)));
  };
  const handleExport = async (): Promise<void> => {
    const result = buildTheme();
    if (!result.valid || !result.theme) { setError(result.errors.join('; ')); return; }
    const dest = await saveFileDialog({ defaultPath: `${draft().slug || 'theme'}.json`, filters: [{ name: 'Theme', extensions: ['json'] }] }).catch(() => null);
    if (typeof dest === 'string') props.store.exportThemeToFile(dest, result.theme).catch((e: unknown) => setError(String(e)));
  };
  return (
    <div class={styles.panel} data-testid="themes-tab">
      <div class={styles.section}>
        <div class={styles.sectionTitle}>User Themes</div>
        <div class={styles.list}>
          <For each={props.store.themes()}>
            {(summary) => (
              <div class={styles.listRow}>
                <span class={styles.listRowPath}>{summary.name} ({summary.base})</span>
                <button type="button" class={styles.linkBtn} onClick={() => startEdit(summary.slug)}>Edit</button>
                <button type="button" class={styles.iconBtn} title="Delete theme" onClick={() => handleDelete(summary.slug)}>×</button>
              </div>
            )}
          </For>
        </div>
        <div class={styles.addRow}>
          <button type="button" class={styles.button} onClick={startNew}>New theme</button>
          <button type="button" class={styles.button} onClick={() => void handleImport()}>Import from file…</button>
        </div>
      </div>
      <div class={styles.section}>
        <div class={styles.sectionTitle}>{draft().isNew ? 'New theme' : `Editing "${draft().slug}"`}</div>
        <div class={styles.row}><span>Slug</span><input class={styles.input} type="text" disabled={!draft().isNew} value={draft().slug} onInput={(e) => setDraft((p) => ({ ...p, slug: e.currentTarget.value }))} /></div>
        <div class={styles.row}><span>Name</span><input class={styles.input} type="text" value={draft().name} onInput={(e) => setDraft((p) => ({ ...p, name: e.currentTarget.value }))} /></div>
        <div class={styles.row}>
          <span>Base</span>
          <select class={styles.select} value={draft().base} onChange={(e) => setDraft((p) => ({ ...p, base: e.currentTarget.value as ThemeBase }))}>
            <For each={BASE_THEMES}>{(b) => <option value={b}>{b}</option>}</For>
          </select>
        </div>
        <For each={EDITABLE_TOKENS}>
          {(key) => {
            const value = () => draft().tokens[key] ?? '';
            const check = () => (value() ? contrastFor(key, value()) : null);
            return (
              <div class={styles.tokenRow}>
                <span class={styles.tokenName}>{key}</span>
                <input class={`${styles.input} ${styles.tokenValue}`} type="text" placeholder="inherit base theme" value={value()} onInput={(e) => setToken(key, e.currentTarget.value)} />
                <Show when={check()}>
                  {(c) => <span class={`${styles.contrastBadge} ${c().passes ? styles.contrastPass : styles.contrastFail}`}>{c().ratio.toFixed(1)}:1 {c().passes ? 'AA' : 'fail'}</span>}
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
        <div class={styles.addRow}>
          <button type="button" class={styles.primaryButton} onClick={handleSave}>Save</button>
          <button type="button" class={styles.button} onClick={() => void handleExport()}>Export to file…</button>
        </div>
      </div>
    </div>
  );
}
