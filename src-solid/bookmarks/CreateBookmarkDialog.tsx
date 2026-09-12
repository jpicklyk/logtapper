/** @jsxImportSource solid-js */
import { For, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Bookmark } from '@bridge/types';
import { BOOKMARK_CATEGORIES } from './bookmarksStore';
import type { CreateBookmarkInput } from './bookmarksStore';
import styles from './bookmarks.module.css';

export interface CreateBookmarkDialogProps {
  /** From `store.cursorLine(sessionId)` at the call site — this component
   *  never touches `ViewerController` directly. */
  initialLine: number;
  onCreate: (input: CreateBookmarkInput) => Promise<Bookmark>;
  onClose: () => void;
}

/**
 * "Bookmark selection" — a fresh instance mounted (via `<Show>` at the call
 * site, the same pattern `AddAnalyzer` uses) each time the panel opens it, so
 * `initialLine` is read once at construction, not a race with a not-yet-
 * mounted consumer.
 *
 * `ViewerController` exposes only `{sessionId, line}` — no selection range —
 * so every bookmark created here is single-line (`endLine` stays unset). A
 * future controller range would plug into that field without changing this
 * component's shape.
 */
export function CreateBookmarkDialog(props: CreateBookmarkDialogProps): JSX.Element {
  const line = props.initialLine;

  const [label, setLabel] = createSignal('');
  const [category, setCategory] = createSignal<string>(BOOKMARK_CATEGORIES[0].id);
  const [note, setNote] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);

  const handleSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (submitting()) return;
    setSubmitting(true);
    const input = { line, label: label().trim() || undefined, category: category(), note: note().trim() };
    try {
      await props.onCreate(input);
      props.onClose();
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div class={styles.overlay} data-testid="create-bookmark-dialog">
      <form class={styles.dialog} onSubmit={handleSubmit}>
        <div class={styles.dialogHeader}>
          <span class={styles.dialogTitle}>Bookmark Line {line + 1}</span>
          <button type="button" class={styles.iconButton} onClick={() => props.onClose()} aria-label="Close">
            ×
          </button>
        </div>
        <label class={styles.field}>
          Label
          <input
            class={styles.input}
            type="text"
            value={label()}
            placeholder={`Line ${line + 1}`}
            autofocus
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
        </label>
        <label class={styles.field}>
          Category
          <select class={styles.select} value={category()} onChange={(e) => setCategory(e.currentTarget.value)}>
            <For each={BOOKMARK_CATEGORIES}>{(c) => <option value={c.id}>{c.label}</option>}</For>
          </select>
        </label>
        <label class={styles.field}>
          Note <span class={styles.optional}>(optional)</span>
          <textarea
            class={styles.textarea}
            rows={3}
            value={note()}
            placeholder="Add a note…"
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        </label>
        <div class={styles.actionsRow}>
          <button type="button" class={styles.button} onClick={() => props.onClose()} disabled={submitting()}>
            Cancel
          </button>
          <button type="submit" class={styles.primaryButton} disabled={submitting()}>
            {submitting() ? 'Saving…' : 'Save Bookmark'}
          </button>
        </div>
      </form>
    </div>
  );
}
