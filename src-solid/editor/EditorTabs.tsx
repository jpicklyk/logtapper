/** @jsxImportSource solid-js */
import { Show, onCleanup, onMount } from 'solid-js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { EditorTab, SAVE_FILTERS, modeForPath } from './EditorTab';
import type { EditorStore } from './editorStore';
import type { LineRefTarget } from './lineRefs';
import styles from './editor.module.css';

export interface EditorTabsProps {
  store: EditorStore;
  /** A line reference clicked in the active document's markdown preview. */
  onLineRef?: (target: LineRefTarget) => void;
  /** Surfaces a failure from "Open in editor…" the same way the top bar does. */
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

  const openInEditor = async (): Promise<void> => {
    const selected = await openDialog({ multiple: false, filters: SAVE_FILTERS });
    if (typeof selected !== 'string') return;
    try {
      await props.store.open(selected);
    } catch (e) {
      props.onError?.(String(e));
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    const id = props.store.activeId();
    if (!id) return;
    event.preventDefault();
    void props.store.save(id);
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
              <button type="button" class={styles.button} onClick={() => void props.store.save(doc().id)}>
                Save
              </button>
              <button type="button" class={styles.button} onClick={() => void props.store.saveAs(doc().id)}>
                Save As…
              </button>
            </>
          )}
        </Show>
      </header>
      <Show
        when={activeDoc()}
        fallback={<div class={styles.empty}>No document open. Choose "New document" or "Open in editor…".</div>}
      >
        {(doc) => (
          <EditorTab
            filePath={doc().filePath}
            content={doc().content}
            mode={modeForPath(doc().filePath)}
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
