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
 * The demo editor tab: the framework-free core of `src-next/components/EditorTab`
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
 */

/** Last path segment, for the tab title. `src-next/utils`' `basename` is not alias-reachable. */
export function basename(path: string): string {
  const match = /[^\\/]+$/.exec(path);
  return match ? match[0] : path;
}

/** `.md` / `.markdown` open in markdown mode; everything else in plain. */
export function modeForPath(path: string | null | undefined): EditorMode {
  return path && /\.(md|markdown)$/i.test(path) ? 'markdown' : 'plain';
}

const SAVE_FILTERS = [
  { name: 'Text Files', extensions: ['yaml', 'yml', 'md', 'txt'] },
  { name: 'All Files', extensions: ['*'] },
];

export interface EditorTabProps {
  /** Path the content came from; `null` for an unsaved scratch document. */
  filePath?: string | null;
  /** Initial document. Changing it reloads the editor and resets dirty state. */
  content?: string;
  /** Falls back to `modeForPath(filePath)` when omitted. */
  mode?: EditorMode;
  onFilePathChanged?: (path: string) => void;
  onDirtyChanged?: (dirty: boolean) => void;
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
  const [dirty, setDirty] = createSignal(false);
  const [filePath, setFilePath] = createSignal<string | null>(initial.filePath);
  const [mode, setMode] = createSignal<EditorMode>(initial.mode);
  const [showPreview, setShowPreview] = createSignal(true);

  const title = () => {
    const path = filePath();
    return path ? basename(path) : 'Untitled';
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
        setMode(props.mode ?? modeForPath(path));
        editor?.setValue(content ?? '');
        setValue(content ?? '');
        syncDirty();
      },
      { defer: true },
    ),
  );

  createEffect(on(mode, (next) => editor?.setMode(next), { defer: true }));

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
          <Show when={dirty()}>
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
            onChange={(event) => setMode(event.currentTarget.value as EditorMode)}
          >
            <option value="plain">plain</option>
            <option value="markdown">markdown</option>
          </select>
        </label>
        <Show when={isMarkdown()}>
          <button
            type="button"
            class={styles.button}
            aria-pressed={showPreview()}
            onClick={() => setShowPreview((on_) => !on_)}
          >
            Preview
          </button>
        </Show>
        <span class={styles.spacer} />
        <button type="button" class={styles.button} onClick={() => void saveFile()}>
          Save
        </button>
        <button type="button" class={styles.button} onClick={() => void saveAs()}>
          Save As…
        </button>
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
