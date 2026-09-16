/** @jsxImportSource solid-js */
import { Show, createEffect, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@bridge/commands';
import { createTextEditor } from './createTextEditor';
import type { EditorMode, TextEditorHandle } from './createTextEditor';
import { Markdown } from './Markdown';
import type { LineRefTarget } from './lineRefs';
import styles from './editor.module.css';

/**
 * The demo editor tab: the framework-free core of the React `components/EditorTab`
 * with the React-only parts left out.
 *
 * What is deliberately **not** ported here: the per-tab `localStorage` mirror
 * (`logtapper_scratchpad_*`), the bus `file:save-request` / `file:save-as-request`
 * subscription, and tab-switch flushing. Those belong to the tab manager, which
 * is a parity-phase surface; this component owns one document.
 *
 * Save / Save As reuse exactly what the React tab uses — `save()` from
 * `@tauri-apps/plugin-dialog` and the `write_text_file` command via
 * `@bridge/commands`' `writeTextFile`. No new bridge route, no agent-reachable
 * write path: the native save dialog is the `Ui` consent step.
 *
 * ## W9 additions (additive, backward compatible)
 *
 * `EditorTabs.tsx` (the W9 tab manager) owns multiple documents and their
 * saved/dirty bookkeeping in `editorStore.ts`, and drives this single-document
 * component as a thin view rather than reimplementing it. Four optional props
 * bridge that, none of which change behaviour for a caller that omits them:
 * - `onContentChanged` mirrors every keystroke out (the store's own
 *   `content`/`savedContent` compare needs the live text; the CM6
 *   `updateListener` already materialises it once per change).
 * - `viewMode`/`onViewModeChanged` make the preview toggle controlled, so the
 *   store can persist the choice into `LtwEditorTab.viewMode`.
 * - `showSaveButtons={false}` hides this header's own Save/Save As — W9's
 *   toolbar owns those so there is one save path, not two disagreeing ones.
 * - `dirty` overrides the header's own dot with the store's dirty flag, which
 *   is what stays correct after a store-driven save (this component's
 *   internal CM6 dirty tracking never learns about a save that happened
 *   through `editorStore.save()` rather than its own hidden button).
 */

/** Last path segment, for the tab title. The React `utils`' `basename` is not alias-reachable. */
export function basename(path: string): string {
  const match = /[^\\/]+$/.exec(path);
  return match ? match[0] : path;
}

/** `.md` / `.markdown` open in markdown mode; everything else in plain. */
export function modeForPath(path: string | null | undefined): EditorMode {
  return path && /\.(md|markdown)$/i.test(path) ? 'markdown' : 'plain';
}

export const SAVE_FILTERS = [
  { name: 'Text Files', extensions: ['yaml', 'yml', 'md', 'txt'] },
  { name: 'All Files', extensions: ['*'] },
];

/** The two preview states this component can actually render (see the W9
 *  note above — there is no editor-hidden "preview only" layout here). */
export type EditorPreviewMode = 'editor' | 'split';

export interface EditorTabProps {
  /** Path the content came from; `null` for an unsaved scratch document. */
  filePath?: string | null;
  /** Initial document. Changing it reloads the editor and resets dirty state. */
  content?: string;
  /** Falls back to `modeForPath(filePath)` when omitted. */
  mode?: EditorMode;
  onFilePathChanged?: (path: string) => void;
  onDirtyChanged?: (dirty: boolean) => void;
  /** Fires on every edit with the current buffer text (W9's content mirror). */
  onContentChanged?: (text: string) => void;
  /** Controls the preview split; omit to keep the internal toggle button. */
  viewMode?: EditorPreviewMode;
  onViewModeChanged?: (mode: EditorPreviewMode) => void;
  /** The language mode picked in the toolbar select, so a controlling caller
   *  (W9's tab manager) can persist it per document. */
  onModeChanged?: (mode: EditorMode) => void;
  /** Hides this header's own Save/Save As — a caller with its own save path
   *  (W9's toolbar) sets this `false` so there is a single save path. */
  showSaveButtons?: boolean;
  /** Overrides the header's dirty dot with an externally tracked value. */
  dirty?: boolean;
  /** A line reference clicked in the markdown preview. */
  onLineRef?: (target: LineRefTarget) => void;
}

export function EditorTab(props: EditorTabProps) {
  let host!: HTMLDivElement;
  let editor: TextEditorHandle | undefined;

  // Read once: later changes arrive through the `on([content, filePath])` effect
  // below, so tracking them here would only duplicate that path.
  const initial = untrack(() => ({
    content: props.content ?? '',
    filePath: props.filePath ?? null,
    mode: props.mode ?? modeForPath(props.filePath),
  }));

  const [value, setValue] = createSignal(initial.content);
  let lastPath: string | null = initial.filePath;
  const [dirty, setDirty] = createSignal(false);
  const [filePath, setFilePath] = createSignal<string | null>(initial.filePath);
  const [mode, setMode] = createSignal<EditorMode>(initial.mode);
  const [internalShowPreview, setInternalShowPreview] = createSignal(true);

  const title = () => {
    const path = filePath();
    return path ? basename(path) : 'Untitled';
  };

  // Controlled when the caller passes `viewMode`/`dirty` (W9's tab manager);
  // otherwise the pre-existing internal signals, unchanged for any other caller.
  const showPreview = () => (props.viewMode !== undefined ? props.viewMode === 'split' : internalShowPreview());
  const isDirty = () => (props.dirty !== undefined ? props.dirty : dirty());

  const togglePreview = (): void => {
    if (props.viewMode !== undefined) props.onViewModeChanged?.(showPreview() ? 'editor' : 'split');
    else setInternalShowPreview((prev) => !prev);
  };

  const syncDirty = () => {
    const next = editor?.isDirty() ?? false;
    setDirty(next);
    props.onDirtyChanged?.(next);
  };

  onMount(() => {
    editor = createTextEditor({
      parent: host,
      doc: initial.content,
      mode: mode(),
      placeholder: 'Start typing...',
      onChange: (next) => {
        setValue(next);
        syncDirty();
        props.onContentChanged?.(next);
      },
    });
  });

  onCleanup(() => editor?.dispose());

  // A new document (the App opened another file) replaces the buffer and is
  // clean by definition. `defer` keeps it from firing for the mount value.
  createEffect(
    on(
      () => [props.content, props.filePath] as const,
      ([content, path]) => {
        setFilePath(path ?? null);
        // Only a path change re-derives the language: the content echo a
        // controlling store sends back after each keystroke must not undo a
        // mode the user picked in the select (phase 2b smoke finding). Tracked
        // by hand because a deferred `on` reports no previous input on its
        // first run.
        const pathChanged = (path ?? null) !== lastPath;
        if (pathChanged) {
          lastPath = path ?? null;
          setMode(props.mode ?? modeForPath(path));
        }
        editor?.setValue(content ?? '');
        // A different document is clean by definition. `setValue` only
        // re-baselines when the text actually changed (review B-M8), so the
        // corner where the incoming file happens to be byte-identical to the
        // buffer it replaces needs the baseline stated explicitly — otherwise
        // the new document inherits the old one's dirty flag.
        if (pathChanged) editor?.markSaved();
        setValue(content ?? '');
        syncDirty();
      },
      { defer: true },
    ),
  );

  createEffect(on(mode, (next) => editor?.setMode(next), { defer: true }));
  createEffect(on(() => props.mode, (next) => { if (next !== undefined) setMode(next); }, { defer: true }));

  const saveAs = async () => {
    const path = await save({ defaultPath: filePath() ?? title(), filters: SAVE_FILTERS });
    if (typeof path !== 'string') return;
    await writeTextFile(path, editor?.getValue() ?? value());
    editor?.markSaved();
    setFilePath(path);
    syncDirty();
    props.onFilePathChanged?.(path);
  };

  const saveFile = async () => {
    const path = filePath();
    if (!path) {
      await saveAs();
      return;
    }
    await writeTextFile(path, editor?.getValue() ?? value());
    editor?.markSaved();
    syncDirty();
  };

  const isMarkdown = () => mode() === 'markdown';

  return (
    <section class={styles.tab} aria-label={`Editor — ${title()}`} data-testid="editor-tab">
      <header class={styles.toolbar}>
        <span class={styles.title}>
          {title()}
          <Show when={isDirty()}>
            <span class={styles.dirty} aria-label="Unsaved changes" title="Unsaved changes">
              ●
            </span>
          </Show>
        </span>
        <label class={styles.control}>
          Mode
          <select
            class={styles.select}
            value={mode()}
            onChange={(event) => {
              const next = event.currentTarget.value as EditorMode;
              setMode(next);
              props.onModeChanged?.(next);
            }}
          >
            <option value="plain">plain</option>
            <option value="markdown">markdown</option>
          </select>
        </label>
        <Show when={isMarkdown()}>
          <button type="button" class={styles.button} aria-pressed={showPreview()} onClick={togglePreview}>
            Preview
          </button>
        </Show>
        <span class={styles.spacer} />
        <Show when={props.showSaveButtons ?? true}>
          <button type="button" class={styles.button} onClick={() => void saveFile()}>
            Save
          </button>
          <button type="button" class={styles.button} onClick={() => void saveAs()}>
            Save As…
          </button>
        </Show>
      </header>

      <div class={styles.body} data-split={isMarkdown() && showPreview() ? 'true' : 'false'}>
        <div class={styles.editorPane} ref={host} data-testid="editor-host" />
        <Show when={isMarkdown() && showPreview()}>
          <div class={styles.previewPane}>
            <Markdown content={value()} onLineRef={props.onLineRef} />
          </div>
        </Show>
      </div>
    </section>
  );
}
