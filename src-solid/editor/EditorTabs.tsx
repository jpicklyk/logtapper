/** @jsxImportSource solid-js */
import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { EditorTab, SAVE_FILTERS } from './EditorTab';
import type { EditorStore } from './editorStore';
import type { LineRefTarget } from './lineRefs';
import styles from './editor.module.css';

export interface EditorTabsProps {
  store: EditorStore;
  /** A line reference clicked in the active document's markdown preview. */
  onLineRef?: (target: LineRefTarget) => void;
  /** Surfaces a write/open failure (Ctrl+S, toolbar Save/Save As, "Open in
   *  editor…") to the top bar, the same way `Switcher.tsx`'s save errors do.
   *  This component also shows the same message inline (see the `role="alert"`
   *  line below) — this prop does not gate that, it only mirrors it upward. */
  onError?: (message: string) => void;
}

/**
 * The editor surface shown in the viewer region in place of `LogViewer` when
 * an editor tab is active. The tab strip itself lives in `App.tsx` (it is the
 * same `TabStrip` the session tabs use — see `editorStore.ts`'s module doc);
 * this component is the small toolbar plus the active document.
 *
 * "New document" / "Open in editor…" moved here from the top-bar demo. Save /
 * Save As are both a toolbar button and Ctrl+S — the shortcut listens on
 * `window` because focus is usually inside the CodeMirror instance, not on
 * this toolbar.
 */
export function EditorTabs(props: EditorTabsProps) {
  const activeDoc = () => props.store.active();
  // Surfaced inline, right in the editor surface — same pattern as
  // `Switcher.tsx`'s own error line — plus forwarded through the existing
  // `onError` prop so the top-bar banner (already wired by `App.tsx` to
  // `actions.reportError`) shows it too. No second error channel: every
  // write path below (Ctrl+S, toolbar Save, toolbar Save As, and
  // "Open in editor…") funnels through this one `reportError`.
  const [error, setError] = createSignal('');
  const reportError = (e: unknown): void => {
    const message = String(e);
    setError(message);
    props.onError?.(message);
  };

  const openInEditor = async (): Promise<void> => {
    const selected = await openDialog({ multiple: false, filters: SAVE_FILTERS });
    if (typeof selected !== 'string') return;
    setError('');
    try {
      await props.store.open(selected);
    } catch (e) {
      reportError(e);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    const id = props.store.activeId();
    if (!id) return;
    event.preventDefault();
    setError('');
    void props.store.save(id).catch(reportError);
  };

  onMount(() => {
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  return (
    <div class={styles.tab} data-testid="editor-tabs">
      <header class={styles.toolbar}>
        <button type="button" class={styles.button} onClick={() => props.store.newDoc()}>
          New document
        </button>
        <button type="button" class={styles.button} onClick={() => void openInEditor()}>
          Open in editor…
        </button>
        <span class={styles.spacer} />
        <Show when={activeDoc()}>
          {(doc) => (
            <>
              <button
                type="button"
                class={styles.button}
                onClick={() => {
                  setError('');
                  void props.store.save(doc().id).catch(reportError);
                }}
              >
                Save
              </button>
              <button
                type="button"
                class={styles.button}
                onClick={() => {
                  setError('');
                  void props.store.saveAs(doc().id).catch(reportError);
                }}
              >
                Save As…
              </button>
            </>
          )}
        </Show>
      </header>
      <Show when={error()}>
        <div class={styles.error} role="alert">
          {error()}
        </div>
      </Show>
      <Show
        when={activeDoc()}
        fallback={<div class={styles.empty}>No document open. Choose "New document" or "Open in editor…".</div>}
      >
        {(doc) => (
          <EditorTab
            filePath={doc().filePath}
            content={doc().content}
            mode={doc().mode}
            onModeChanged={(mode) => props.store.setMode(doc().id, mode)}
            showSaveButtons={false}
            dirty={props.store.isDirty(doc().id)}
            viewMode={doc().viewMode === 'split' ? 'split' : 'editor'}
            onViewModeChanged={(mode) => props.store.setViewMode(doc().id, mode)}
            onContentChanged={(text) => props.store.setContent(doc().id, text)}
            onLineRef={props.onLineRef}
          />
        )}
      </Show>
    </div>
  );
}
