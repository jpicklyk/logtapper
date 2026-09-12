/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Bookmark } from '@bridge/types';
import { CallerBadge } from '../ui';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { SessionStore } from '../app/index';
import { writeClipboard } from '../viewer';
import { CreateBookmarkDialog } from './CreateBookmarkDialog';
import { categoryAccentVar } from './bookmarksStore';
import type { BookmarksStore } from './bookmarksStore';
import styles from './bookmarks.module.css';

export interface BookmarksPanelProps {
  store: BookmarksStore;
  sessions: SessionStore;
}

function formatLineRef(b: Bookmark): string {
  return b.lineNumberEnd != null && b.lineNumberEnd > b.lineNumber
    ? `L${b.lineNumber + 1}–${b.lineNumberEnd + 1}`
    : `L${b.lineNumber + 1}`;
}

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

  const startEditLabel = (e: MouseEvent): void => {
    e.stopPropagation();
    setLabelDraft(props.bookmark.label);
    setEditingLabel(true);
  };

  const saveLabel = (): void => {
    const trimmed = labelDraft().trim();
    if (trimmed && trimmed !== props.bookmark.label) props.onEdit({ label: trimmed });
    setEditingLabel(false);
  };

  const startEditNote = (e: MouseEvent): void => {
    e.stopPropagation();
    setNoteDraft(props.bookmark.note ?? '');
    setEditingNote(true);
  };

  const saveNote = (): void => {
    const trimmed = noteDraft().trim();
    if (trimmed !== (props.bookmark.note ?? '')) props.onEdit({ note: trimmed });
    setEditingNote(false);
  };

  return (
    <div
      class={styles.row}
      style={{ '--row-accent': categoryAccentVar(props.bookmark.category ?? 'custom') } as JSX.CSSProperties}
      role="button"
      tabIndex={0}
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
        <span class={styles.lineRef}>{formatLineRef(props.bookmark)}</span>
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
            <div class={styles.note} onClick={startEditNote} title="Click to edit note">
              {props.bookmark.note}
            </div>
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
  const [createOpen, setCreateOpen] = createSignal(false);
  const [exportStatus, setExportStatus] = createSignal<'idle' | 'copied'>('idle');

  const sessionId = createMemo(() => props.sessions.focusedId());
  const groups = createMemo(() => {
    const sid = sessionId();
    return sid ? props.store.categories(sid) : [];
  });
  const total = createMemo(() => groups().reduce((sum, g) => sum + g.count, 0));

  const handleExport = (): void => {
    const sid = sessionId();
    if (!sid) return;
    const markdown = props.store.exportMarkdown(sid);
    writeClipboard(markdown);
    setExportStatus('copied');
    setTimeout(() => setExportStatus('idle'), 2000);
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
              <button type="button" class={styles.newButton} onClick={() => setCreateOpen(true)}>
                Bookmark selection
              </button>
            </header>

            <Show when={props.store.loading(sid()) && total() === 0}>
              <div class={styles.empty}>Loading{'…'}</div>
            </Show>
            <Show when={!props.store.loading(sid()) && total() === 0}>
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
                          onEdit={(patch) => void props.store.update(b.id, patch)}
                          onDelete={() => void props.store.remove(b.id)}
                        />
                      )}
                    </For>
                  </section>
                )}
              </For>
            </div>

            <Show when={createOpen()}>
              <CreateBookmarkDialog
                initialLine={props.store.cursorLine(sid()) ?? 0}
                onCreate={(input) => props.store.create(sid(), input)}
                onClose={() => setCreateOpen(false)}
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
