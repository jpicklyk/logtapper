/** @jsxImportSource solid-js */
import { For, Show, createSignal, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { AnonymizerMode } from '@bridge/types';
import { save } from '@tauri-apps/plugin-dialog';
import type { ExportStore } from './exportStore';
import styles from './export.module.css';
export interface ExportDialogProps {
  store: ExportStore;
  /** The global anonymizer mode (`settingsStore.anonymizerMode`). The backend
   *  decides from it whether exported log lines are redacted; this only says so. */
  anonymizerMode: Accessor<AnonymizerMode>;
  /** Show the Analyzers panel, whose pinned PII card is the mode's one writer. */
  onChangeMode?: () => void;
}
/** What the `.lts` export does to log lines under each mode — the backend's
 *  External-pathway rule (`mode != None`), stated rather than re-decided. Under
 *  External the file and the viewer differ on purpose; the line says so. */
const EXPORT_MODE_STATUS: Record<AnonymizerMode, string> = {
  all: 'All — exported log lines are anonymized, as in the viewer',
  external: 'External — exported log lines are anonymized; the viewer shows raw text',
  none: 'None — exported raw; the anonymizer is off',
};
function defaultFileName(info: { sessions: { sourceFilename: string }[] }): string {
  const first = info.sessions[0]?.sourceFilename.replace(/\.[^.]+$/, '') ?? 'export';
  return info.sessions.length > 1 ? `${first}-and-${info.sessions.length - 1}-more.lts` : `${first}.lts`;
}
/** The `export` shell surface (W8): counts + toggles, mounted in the rail's
 *  drawer. `props.store.refresh()` runs on mount so reopening it stays current. */
export function ExportDialog(props: ExportDialogProps) {
  onMount(() => props.store.refresh());
  /** Destination of the last successful write — the dialog's only success signal;
   *  without it the button just slides back to "Export…" (L11). */
  const [savedTo, setSavedTo] = createSignal<string | null>(null);
  const pickDestination = async (): Promise<void> => {
    const info = props.store.info();
    if (!info || info.sessions.length === 0) return;
    setSavedTo(null);
    // A cancelled dialog resolves to `null`; a *failed* one rejects (or throws
    // outright when the dialog backend is unavailable). Neither is a user-facing
    // error — the user simply gets no file picker — but an unguarded call leaves
    // an unhandled rejection behind, since this runs from `void pickDestination()` (L11).
    let picked: string | null;
    try {
      picked = await save({ defaultPath: defaultFileName(info), filters: [{ name: 'LogTapper Session', extensions: ['lts'] }] });
    } catch {
      return;
    }
    if (typeof picked !== 'string') return;
    // `runExport` records its own rejection in `store.error()`, which is rendered
    // below; this catch only keeps it from also surfacing as an unhandled rejection.
    await props.store.runExport(picked).then(() => setSavedTo(picked)).catch(() => undefined);
  };
  const totalBookmarks = () => props.store.info()?.sessions.reduce((n, s) => n + s.bookmarkCount, 0) ?? 0;
  const totalAnalyses = () => props.store.info()?.sessions.reduce((n, s) => n + s.analysisCount, 0) ?? 0;
  return (
    <div class={styles.dialog} data-testid="export-dialog">
      <Show when={props.store.loading()}><p class={styles.hint}>Loading session info…</p></Show>
      <Show when={!props.store.loading() && props.store.info()}>
        {(info) => (
          <Show when={info().sessions.length > 0} fallback={<p class={styles.hint}>No sessions to export.</p>}>
            <ul class={styles.sessionList}>
              <For each={info().sessions}>{(s) => <li class={styles.sessionEntry}>{s.sourceFilename}</li>}</For>
            </ul>
            <div class={styles.section}>
              <label class={styles.checkboxRow}><input type="checkbox" checked={props.store.options().includeBookmarks} onChange={(e) => props.store.setOption('includeBookmarks', e.currentTarget.checked)} /> Bookmarks ({totalBookmarks()})</label>
              <label class={styles.checkboxRow}><input type="checkbox" checked={props.store.options().includeAnalyses} onChange={(e) => props.store.setOption('includeAnalyses', e.currentTarget.checked)} /> Analyses ({totalAnalyses()})</label>
              <label class={styles.checkboxRow}><input type="checkbox" checked={props.store.options().includeProcessors} onChange={(e) => props.store.setOption('includeProcessors', e.currentTarget.checked)} /> Processors ({info().totalProcessorCount} of {info().totalPipelineProcessorCount} enabled)</label>
            </div>
            <p class={styles.modeStatus} data-testid="export-anonymizer-status" data-mode={props.anonymizerMode()}>
              <span>{EXPORT_MODE_STATUS[props.anonymizerMode()]}</span>
              <Show when={props.onChangeMode}>
                {(onChange) => (
                  <button type="button" class={styles.linkButton} onClick={() => onChange()()}>Change</button>
                )}
              </Show>
            </p>
            <Show when={props.store.error()}><p class={styles.error} role="alert">{props.store.error()}</p></Show>
            <Show when={!props.store.error() && savedTo()}>
              {(dest) => <p class={styles.success} role="status" data-testid="export-success">Exported to {dest()}</p>}
            </Show>
            <div class={styles.actions}>
              <button type="button" class={styles.primaryButton} disabled={props.store.exporting()} onClick={() => void pickDestination()}>
                {props.store.exporting() ? 'Exporting…' : 'Export…'}
              </button>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}
