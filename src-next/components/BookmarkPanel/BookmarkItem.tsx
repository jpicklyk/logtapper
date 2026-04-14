import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, MessageSquare } from 'lucide-react';
import type { Bookmark } from '../../bridge/types';
import styles from './BookmarkPanel.module.css';

interface BookmarkItemProps {
  bookmark: Bookmark;
  accentColor: string;
  onJump: (lineNum: number) => void;
  onEdit: (id: string, label?: string, note?: string, category?: string) => void;
  onDelete: (id: string) => void;
}

function formatLineIndicator(bookmark: Bookmark): string {
  if (bookmark.lineNumberEnd != null && bookmark.lineNumberEnd > bookmark.lineNumber) {
    return `L:${bookmark.lineNumber + 1}-${bookmark.lineNumberEnd + 1}`;
  }
  return `L:${bookmark.lineNumber + 1}`;
}

function truncateSnippet(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '\u2026';
}

const BookmarkItem = React.memo(function BookmarkItem({
  bookmark,
  accentColor,
  onJump,
  onEdit,
  onDelete,
}: BookmarkItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const lineIndicator = formatLineIndicator(bookmark);
  const snippetLine = bookmark.snippet?.[0] ? truncateSnippet(bookmark.snippet[0]) : null;

  const handleCardClick = useCallback(() => {
    if (!editing) {
      onJump(bookmark.lineNumber);
    }
  }, [editing, bookmark.lineNumber, onJump]);

  const handleLabelDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(bookmark.label);
    setEditing(true);
  }, [bookmark.label]);

  // Select all text when entering edit mode (autoFocus handles focus)
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const handleEditSave = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== bookmark.label) {
      onEdit(bookmark.id, trimmed);
    }
    setEditing(false);
  }, [editValue, bookmark.label, bookmark.id, onEdit]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleEditSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  }, [handleEditSave]);

  const handleNoteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setNoteValue(bookmark.note ?? '');
    setEditingNote(true);
  }, [bookmark.note]);

  // Focus note textarea when entering note edit mode
  useEffect(() => {
    if (editingNote) noteRef.current?.focus();
  }, [editingNote]);

  const handleNoteSave = useCallback(() => {
    const trimmed = noteValue.trim();
    if (trimmed !== (bookmark.note ?? '')) {
      onEdit(bookmark.id, undefined, trimmed);
    }
    setEditingNote(false);
  }, [noteValue, bookmark.note, bookmark.id, onEdit]);

  const handleNoteKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditingNote(false);
    }
    // Ctrl+Enter to save
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleNoteSave();
    }
  }, [handleNoteSave]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(bookmark.id);
  }, [bookmark.id, onDelete]);

  return (
    <div
      className={styles.card}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
    >
      {/* Left accent bar */}
      <div className={styles.cardAccent} style={{ background: accentColor }} />

      {/* Card body */}
      <div className={styles.cardBody}>
        {/* Label row */}
        <div className={styles.labelRow}>
          {editing ? (
            <input
              ref={inputRef}
              className={styles.labelInput}
              value={editValue}
              autoFocus
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleEditSave}
              onKeyDown={handleEditKeyDown}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={styles.label}
              onDoubleClick={handleLabelDoubleClick}
              title="Double-click to edit"
            >
              {bookmark.label}
            </span>
          )}
          <button
            className={styles.deleteBtn}
            onClick={handleDeleteClick}
            type="button"
            title="Delete bookmark"
          >
            <Trash2 size={12} />
          </button>
        </div>

        {/* Meta row: line indicator + agent badge */}
        <div className={styles.metaRow}>
          <span className={styles.lineIndicator}>{lineIndicator}</span>
          {bookmark.createdBy === 'Agent' && (
            <span className={styles.agentBadge}>Agent</span>
          )}
        </div>

        {/* Snippet preview */}
        {snippetLine && (
          <div className={styles.snippet}>{snippetLine}</div>
        )}

        {/* Note / comment */}
        {editingNote ? (
          <div className={styles.noteEdit} onClick={(e) => e.stopPropagation()}>
            <textarea
              ref={noteRef}
              className={styles.noteTextarea}
              value={noteValue}
              onChange={(e) => setNoteValue(e.target.value)}
              onBlur={handleNoteSave}
              onKeyDown={handleNoteKeyDown}
              rows={3}
              placeholder="Add a note..."
            />
            <div className={styles.noteHint}>Ctrl+Enter to save, Escape to cancel</div>
          </div>
        ) : bookmark.note ? (
          <div
            className={styles.noteDisplay}
            onClick={handleNoteClick}
            title="Click to edit note"
          >
            <MessageSquare size={10} className={styles.noteIcon} />
            <span>{bookmark.note}</span>
          </div>
        ) : (
          <button
            className={styles.addNoteBtn}
            onClick={handleNoteClick}
            type="button"
          >
            <MessageSquare size={10} />
            <span>Add note</span>
          </button>
        )}

        {/* Tag pills */}
        {bookmark.tags && bookmark.tags.length > 0 && (
          <div className={styles.tags}>
            {bookmark.tags.map((tag) => (
              <span key={tag} className={styles.tagPill}>{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export default BookmarkItem;
