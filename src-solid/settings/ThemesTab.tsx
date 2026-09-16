/** @jsxImportSource solid-js */
import { For, Show, createSignal, onMount, untrack } from 'solid-js';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { AA_NORMAL_TEXT, BASE_THEMES, contrastRatio, effectiveTokenValue, validateUserTheme } from '../theme';
import type { ThemeBase, ThemeController, UserTheme } from '../theme';
import type { SettingsStore } from './settingsStore';
import styles from './settings.module.css';
export interface ThemesTabProps {
  store: SettingsStore;
  /** Optional so a host without a live theme controller (tests) still mounts;
   *  without it the "Use" action is hidden rather than dead. */
  theme?: ThemeController;
}
/** Curated tokens the editor exposes (the live AA check applies to these);
 *  `userTheme.ts`'s `KNOWN_TOKENS` covers ~70 more, which an imported file
 *  round-trips untouched even though this form only edits the subset. */
const EDITABLE_TOKENS = ['--surface', '--text', '--text-subtle', '--accent', '--border', '--danger'] as const;
interface Draft { slug: string; isNew: boolean; name: string; base: ThemeBase; tokens: Record<string, string> }
const EMPTY_DRAFT: Draft = { slug: '', isNew: true, name: '', base: 'dark', tokens: {} };
/**
 * AA contrast against a token's natural counterpart, resolved from the *draft*
 * — its own `--surface`/`--text` when it declares one, otherwise the value the
 * draft's own `base` would paint (`BASE_THEME_TOKENS`). Never
 * `getComputedStyle`: the painted theme is a different theme from the one being
 * authored, and reading the live root is external mutable state that no
 * derivation can track. `null` when the token has no counterpart to score
 * against.
 */
export function contrastFor(
  token: string,
  value: string,
  base: ThemeBase,
  tokens: Readonly<Record<string, string>>,
): { ratio: number; passes: boolean } | null {
  try {
    const counterpart = token.startsWith('--text')
      ? effectiveTokenValue(base, tokens, '--surface')
      : token === '--surface'
        ? effectiveTokenValue(base, tokens, '--text')
        : null;
    if (counterpart === null) return null;
    const ratio = token === '--surface' ? contrastRatio(counterpart, value) : contrastRatio(value, counterpart);
    return { ratio, passes: ratio >= AA_NORMAL_TEXT };
  } catch {
    return null;
  }
}
/** Filename → slug, or `''` when the name has nothing slug-worthy in it
 *  (`"___.json"`), so the caller rejects it instead of storing a theme at `"-"`. */
export function deriveSlug(path: string): string {
  const stem = (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '');
  return stem.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
export function ThemesTab(props: ThemesTabProps) {
  const [draft, setDraft] = createSignal<Draft>(EMPTY_DRAFT);
  const [error, setError] = createSignal<string | null>(null);
  /** Slug the next Save would overwrite, armed by the first click and cleared by
   *  the second (or by starting a different draft). Same two-step shape as delete. */
  const [confirmingOverwrite, setConfirmingOverwrite] = createSignal<string | null>(null);
  onMount(() => props.store.refreshThemes());
  const startNew = (): void => {
    setError(null);
    setConfirmingOverwrite(null);
    setDraft(EMPTY_DRAFT);
  };
  const startEdit = (slug: string): void => {
    setError(null);
    setConfirmingOverwrite(null);
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
  const slugExists = (slug: string): boolean => props.store.themes().some((t) => t.slug === slug);
  const commitTheme = (slug: string, theme: UserTheme): void => {
    props.store.saveTheme(slug, theme)
      .then(() => setDraft((prev) => ({ ...prev, slug, isNew: false })))
      .catch((e: unknown) => setError(String(e)));
  };
  const handleSave = (): void => {
    const slug = draft().slug.trim();
    if (!slug) { setError('slug is required'); return; }
    const result = buildTheme();
    if (!result.valid || !result.theme) { setError(result.errors.join('; ')); return; }
    // A new draft whose slug is already taken would silently replace the stored
    // theme — require an explicit second click (M13). Editing an existing theme
    // is itself the confirmation, so `isNew: false` saves straight through.
    if (draft().isNew && slugExists(slug) && confirmingOverwrite() !== slug) {
      setConfirmingOverwrite(slug);
      setError(`"${slug}" already exists — Save again to overwrite it.`);
      return;
    }
    setConfirmingOverwrite(null);
    setError(null);
    commitTheme(slug, result.theme);
  };
  /** "Use this theme": switch to its own base and paint its tokens (B-M5).
   *  The controller persists the slug, so the choice survives a restart. */
  const applyTheme = (slug: string, theme: UserTheme): void => {
    props.theme?.applyUserTheme(slug, { base: theme.base, tokens: theme.tokens });
  };
  const handleUse = (slug: string): void => {
    setError(null);
    // Untracked: a promise callback runs outside any computation, so reading
    // `props.theme` here is a one-time lookup, not a subscription.
    props.store.readTheme(slug)
      .then((theme) => untrack(() => applyTheme(slug, theme)))
      .catch((e: unknown) => setError(String(e)));
  };
  const handleUseDraft = (): void => {
    const slug = draft().slug.trim();
    if (!slug || draft().isNew) { setError('save the theme before using it'); return; }
    const result = buildTheme();
    if (!result.valid || !result.theme) { setError(result.errors.join('; ')); return; }
    setError(null);
    applyTheme(slug, result.theme);
  };
  // Two-step delete: the first click arms the row, the second confirms.
  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(null);
  const handleDelete = (slug: string): void => {
    setConfirmingDelete(null);
    // Untracked: this runs outside any Solid computation (a promise callback), so the read is a one-time check.
    props.store.deleteTheme(slug).then(() => untrack(() => {
      // The theme in use just stopped existing — drop its overrides rather than
      // leave a theme painted that nothing can edit or restore next launch.
      if (props.theme?.appliedThemeSlug() === slug) props.theme.clearUserTheme();
      if (draft().slug === slug) startNew();
    })).catch((e: unknown) => setError(String(e)));
  };
  /** Import, armed for overwrite: the file's slug already existing means a
   *  second click is needed, exactly as a typed duplicate slug does (M13). */
  const [confirmingImport, setConfirmingImport] = createSignal<string | null>(null);
  const handleImport = async (): Promise<void> => {
    const path = await openFileDialog({ multiple: false, filters: [{ name: 'Theme', extensions: ['json'] }] }).catch(() => null);
    if (typeof path !== 'string') return;
    const slug = deriveSlug(path);
    if (!slug) { setError('could not derive a theme slug from that file name'); return; }
    if (slugExists(slug) && confirmingImport() !== slug) {
      setConfirmingImport(slug);
      setError(`"${slug}" already exists — Import again to overwrite it.`);
      return;
    }
    setConfirmingImport(null);
    setError(null);
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
                <Show when={props.theme?.appliedThemeSlug() === summary.slug}>
                  <span class={styles.appliedBadge} data-testid="applied-theme">in use</span>
                </Show>
                <Show
                  when={confirmingDelete() === summary.slug}
                  fallback={
                    <>
                      <Show when={props.theme}>
                        <button type="button" class={styles.linkBtn} title={`Use "${summary.name}"`} onClick={() => handleUse(summary.slug)}>Use</button>
                      </Show>
                      <button type="button" class={styles.linkBtn} onClick={() => startEdit(summary.slug)}>Edit</button>
                      <button type="button" class={styles.iconBtn} title="Delete theme" onClick={() => setConfirmingDelete(summary.slug)}>×</button>
                    </>
                  }
                >
                  <button type="button" class={styles.linkBtn} onClick={() => handleDelete(summary.slug)}>Delete?</button>
                  <button type="button" class={styles.iconBtn} title="Keep theme" onClick={() => setConfirmingDelete(null)}>Cancel</button>
                </Show>
              </div>
            )}
          </For>
        </div>
        <div class={styles.addRow}>
          <button type="button" class={styles.button} onClick={startNew}>New theme</button>
          <button type="button" class={styles.button} onClick={() => void handleImport()}>
            {confirmingImport() ? 'Import and overwrite?' : 'Import from file…'}
          </button>
          <Show when={props.theme?.appliedThemeSlug()}>
            <button type="button" class={styles.linkBtn} onClick={() => props.theme?.clearUserTheme()}>Use built-in theme</button>
          </Show>
        </div>
      </div>
      <div class={styles.section}>
        <div class={styles.sectionTitle}>{draft().isNew ? 'New theme' : `Editing "${draft().slug}"`}</div>
        <div class={styles.row}><span>Slug</span><input class={styles.input} type="text" disabled={!draft().isNew} value={draft().slug} onInput={(e) => { setConfirmingOverwrite(null); setDraft((p) => ({ ...p, slug: e.currentTarget.value })); }} /></div>
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
            const check = () => (value() ? contrastFor(key, value(), draft().base, draft().tokens) : null);
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
          <button type="button" class={styles.primaryButton} onClick={handleSave}>
            {confirmingOverwrite() ? 'Overwrite?' : 'Save'}
          </button>
          <Show when={props.theme && !draft().isNew}>
            <button type="button" class={styles.button} onClick={handleUseDraft}>Use this theme</button>
          </Show>
          <button type="button" class={styles.button} onClick={() => void handleExport()}>Export to file…</button>
        </div>
      </div>
    </div>
  );
}
