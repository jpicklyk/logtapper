/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Bookmark } from '@bridge/types';
import { CallerBadge } from '../ui';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { SessionStore } from '../app/index';
import { writeClipboard } from '../viewer';
import { CreateBookmarkDialog } from './CreateBookmarkDialog';
import { categoryAccentVar, formatLineRange } from './bookmarksStore';
import type { BookmarksStore } from './bookmarksStore';
import styles from './bookmarks.module.css';

export interface BookmarksPanelProps {
  store: BookmarksStore;
  sessions: SessionStore;
}

/** How long the "Copied!" acknowledgement stays up. */
const COPIED_MS = 2_000;

interface RowProps {
  bookmark: Bookmark;
  onJump: () => void;
  onEdit: (patch: { label?: string; note?: string }) => void;
  onDelete: () => void;
}

function BookmarkRow(props: RowProps): JSX.Element {
  const [editingLabel, setEditingLabel] = createSignal(false);
  const [labelDraft, setLabelDraft] = createSignal('');
  const [editingNote, setEditingNote] = createSignal(false);
  const [noteDraft, setNoteDraft] = createSignal('');
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);

  const startEditLabel = (e: Event): void => {
    e.stopPropagation();
    setLabelDraft(props.bookmark.label);
    setEditingLabel(true);
  };

  const saveLabel = (): void => {
    const trimmed = labelDraft().trim();
    if (trimmed && trimmed !== props.bookmark.label) props.onEdit({ label: trimmed });
    setEditingLabel(false);
  };

  const startEditNote = (e: Event): void => {
    e.stopPropagation();
    setNoteDraft(props.bookmark.note ?? '');
    setEditingNote(true);
  };

  const saveNote = (): void => {
    const trimmed = noteDraft().trim();
    if (trimmed !== (props.bookmark.note ?? '')) props.onEdit({ note: trimmed });
    setEditingNote(false);
  };

  // The row itself is NOT `role="button"` any more: it contains buttons, an
  // input and a textarea, which may not live inside a button role, and it had
  // no key handler, so a keyboard user could focus every row and jump to none.
  // Clicking the row is kept as a mouse convenience; the keyboard/AT path is
  // the real `<button>` on the line reference.
  return (
    <div
      class={styles.row}
      style={{ '--row-accent': categoryAccentVar(props.bookmark.category ?? 'custom') } as JSX.CSSProperties}
      data-testid="bookmark-row"
      onClick={() => { if (!editingLabel() && !editingNote()) props.onJump(); }}
    >
      <div class={styles.rowHeader}>
        <Show
          when={editingLabel()}
          fallback={
            <span class={styles.label} onDblClick={startEditLabel} title="Double-click to edit">
              {props.bookmark.label}
            </span>
          }
        >
          <input
            class={styles.labelInput}
            value={labelDraft()}
            autofocus
            onInput={(e) => setLabelDraft(e.currentTarget.value)}
            onBlur={saveLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveLabel();
              else if (e.key === 'Escape') setEditingLabel(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </Show>
        <CallerBadge caller={props.bookmark.createdBy} />
        <Show when={!editingLabel()}>
          <button
            type="button"
            class={styles.iconButton}
            title="Rename bookmark"
            aria-label={`Rename ${props.bookmark.label}`}
            onClick={startEditLabel}
          >
            {'✎'}
          </button>
        </Show>
        <Show
          when={confirmingDelete()}
          fallback={
            <button
              type="button"
              class={styles.iconButton}
              title="Delete bookmark"
              onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
            >
              ×
            </button>
          }
        >
          <button
            type="button"
            class={styles.dangerButton}
            onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); props.onDelete(); }}
          >
            Confirm
          </button>
          <button type="button" class={styles.iconButton} onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); }}>
            Cancel
          </button>
        </Show>
      </div>
      <div class={styles.metaRow}>
        <button
          type="button"
          class={styles.lineRef}
          title="Jump to this line"
          onClick={(e) => { e.stopPropagation(); props.onJump(); }}
        >
          {formatLineRange(props.bookmark.lineNumber, props.bookmark.lineNumberEnd)}
        </button>
      </div>
      <Show when={props.bookmark.snippet?.[0]}>
        <div class={styles.snippet}>{props.bookmark.snippet![0]}</div>
      </Show>
      <Show
        when={editingNote()}
        fallback={
          <Show
            when={props.bookmark.note}
            fallback={
              <button type="button" class={styles.addNoteButton} onClick={startEditNote}>
                Add note
              </button>
            }
          >
            <button type="button" class={styles.note} onClick={startEditNote} title="Click to edit note">
              {props.bookmark.note}
            </button>
          </Show>
        }
      >
        <textarea
          class={styles.noteTextarea}
          value={noteDraft()}
          rows={2}
          onInput={(e) => setNoteDraft(e.currentTarget.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditingNote(false);
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </Show>
    </div>
  );
}

/** The `bookmarks` shell surface (rail placement): categorised list for the
 *  focused session, "Bookmark selection" launches `CreateBookmarkDialog`. */
export function BookmarksPanel(props: BookmarksPanelProps): JSX.Element {
  /** The session + line the open create dialog belongs to, captured when it
   *  opens. Resolving the session at *submit* time let a tab switch write the
   *  bookmark into the newly focused session, at the old session's line. */
  const [createFor, setCreateFor] = createSignal<{ sessionId: string; line: number } | null>(null);
  const [exportStatus, setExportStatus] = createSignal<'idle' | 'copied'>('idle');
  const [actionError, setActionError] = createSignal<string | null>(null);

  const sessionId = createMemo(() => props.sessions.focusedId());
  const cursorLine = createMemo(() => {
    const sid = sessionId();
    return sid ? props.store.cursorLine(sid) : null;
  });
  const groups = createMemo(() => {
    const sid = sessionId();
    return sid ? props.store.categories(sid) : [];
  });
  const total = createMemo(() => groups().reduce((sum, g) => sum + g.count, 0));
  const fetchError = createMemo(() => {
    const sid = sessionId();
    return sid ? props.store.error(sid) : null;
  });

  // Belt and braces with the captured session id above: a dialog for a session
  // that is no longer focused has no visible context, so close it outright.
  createEffect(on(sessionId, () => setCreateFor(null), { defer: true }));

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => { if (copiedTimer !== undefined) clearTimeout(copiedTimer); });

  const handleExport = (): void => {
    const sid = sessionId();
    if (!sid) return;
    const markdown = props.store.exportMarkdown(sid);
    writeClipboard(markdown);
    setExportStatus('copied');
    // Without the cleanup above, closing the drawer inside the window left this
    // timer writing into a disposed signal.
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setExportStatus('idle'), COPIED_MS);
  };

  const openCreate = (): void => {
    const sid = sessionId();
    const line = cursorLine();
    if (!sid || line === null) return;
    setCreateFor({ sessionId: sid, line });
  };

  /** Every store call from this panel is a promise; an unhandled rejection
   *  used to leave the row on screen with no explanation. */
  const surface = (p: Promise<unknown>): void => {
    void p.then(
      () => setActionError(null),
      (e: unknown) => setActionError(String(e)),
    );
  };

  return (
    <div class={styles.panel} data-testid="bookmarks-panel">
      <Show when={sessionId()} fallback={<div class={styles.empty}>No session loaded.</div>}>
        {(sid) => (
          <>
            <header class={styles.header}>
              <span class={styles.headerLabel}>Bookmarks</span>
              <Show when={total() > 0}>
                <span class={styles.headerCount}>{total()}</span>
              </Show>
              <Show when={total() > 0}>
                <button type="button" class={styles.iconButton} title="Copy bookmarks as Markdown" onClick={handleExport}>
                  {exportStatus() === 'copied' ? 'Copied!' : 'Export'}
                </button>
              </Show>
              <button
                type="button"
                class={styles.newButton}
                // With no cursor the dialog silently offered "Bookmark Line 1"
                // as though the user had picked line 1.
                disabled={cursorLine() === null}
                title={cursorLine() === null ? 'Select a line in the viewer first' : undefined}
                onClick={openCreate}
              >
                Bookmark selection
              </button>
            </header>

            <Show when={fetchError()}>
              {(message) => (
                <div class={styles.error} role="alert" data-testid="bookmarks-error">
                  <span class={styles.errorText}>Could not load bookmarks: {message()}</span>
                  <button type="button" class={styles.retryButton} onClick={() => props.store.retry(sid())}>
                    Retry
                  </button>
                </div>
              )}
            </Show>
            <Show when={actionError()}>
              {(message) => (
                <div class={styles.error} role="alert" data-testid="bookmarks-action-error">
                  <span class={styles.errorText}>{message()}</span>
                  <button type="button" class={styles.retryButton} onClick={() => setActionError(null)}>
                    Dismiss
                  </button>
                </div>
              )}
            </Show>

            <Show when={props.store.loading(sid()) && total() === 0}>
              <div class={styles.empty}>Loading{'…'}</div>
            </Show>
            <Show when={!props.store.loading(sid()) && total() === 0 && !fetchError()}>
              <div class={styles.empty}>No bookmarks yet.</div>
            </Show>

            <div class={styles.groups}>
              <For each={groups()}>
                {(group) => (
                  <section class={styles.group}>
                    <h5 class={styles.groupLabel}>
                      {group.label} <span class={styles.groupCount}>{group.count}</span>
                    </h5>
                    <For each={group.bookmarks}>
                      {(b) => (
                        <BookmarkRow
                          bookmark={b}
                          onJump={() => props.store.jumpTo(b)}
                          onEdit={(patch) => surface(props.store.update(b.id, patch))}
                          onDelete={() => surface(props.store.remove(b.id))}
                        />
                      )}
                    </For>
                  </section>
                )}
              </For>
            </div>

            <Show when={createFor()}>
              {(target) => (
                <CreateBookmarkDialog
                  initialLine={target().line}
                  onCreate={(input) => props.store.create(target().sessionId, input)}
                  onClose={() => setCreateFor(null)}
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
