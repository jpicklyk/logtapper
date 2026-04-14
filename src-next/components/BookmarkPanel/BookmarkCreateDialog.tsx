import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getLines } from '../../bridge/commands';
import { useSessionBookmarkActions } from '../../context';
import { useSettings } from '../../hooks';
import { Modal } from '../../ui';
import styles from './BookmarkCreateDialog.module.css';

export interface BookmarkCreateRequest {
  paneId: string;
  sessionId: string;
  lineNumber: number;
  lineNumberEnd?: number;
  defaultLabel?: string;
  position?: { x: number; y: number };
}

interface Props {
  request: BookmarkCreateRequest | null;
  onClose: () => void;
}

const BookmarkCreateDialog = React.memo(function BookmarkCreateDialog({
  request,
  onClose,
}: Props) {
  const { settings } = useSettings();
  const { addBookmark } = useSessionBookmarkActions();
  const categories = settings.bookmarkCategories;
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<string>(() => categories[0]?.id ?? 'custom');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const labelRef = useRef<HTMLInputElement>(null);
  const labelFetchedRef = useRef<string | null>(null);

  // When a new request arrives, reset the form and auto-fetch the default label
  useEffect(() => {
    if (!request) return;

    setLabel(request.defaultLabel ?? '');
    setCategory('observation');
    setNote('');
    setSubmitting(false);
    labelFetchedRef.current = null;

    // Auto-generate a label from the log line if none provided
    if (!request.defaultLabel) {
      const { sessionId, lineNumber } = request;
      getLines({
        sessionId,
        mode: { mode: 'Full' },
        offset: lineNumber,
        count: 1,
        context: 0,
      })
        .then((result) => {
          if (labelFetchedRef.current !== null) return; // request changed
          const line = result.lines[0];
          if (line) {
            const generated = line.tag
              ? `${line.tag}: ${line.message.slice(0, 40)}${line.message.length > 40 ? '\u2026' : ''}`
              : `Line ${lineNumber + 1}`;
            setLabel((prev) => (prev === '' ? generated : prev));
          } else {
            setLabel((prev) => (prev === '' ? `Line ${lineNumber + 1}` : prev));
          }
        })
        .catch(() => {
          setLabel((prev) => (prev === '' ? `Line ${lineNumber + 1}` : prev));
        });
    }

    // Focus the label input after next paint
    requestAnimationFrame(() => labelRef.current?.select());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!request || submitting) return;

      const trimmedLabel = label.trim() || `Line ${request.lineNumber + 1}`;
      setSubmitting(true);

      try {
        let snippet: string[] | undefined;
        const { sessionId, lineNumber, lineNumberEnd } = request;

        try {
          const count = lineNumberEnd != null && lineNumberEnd > lineNumber
            ? lineNumberEnd - lineNumber + 1
            : 1;
          const result = await getLines({
            sessionId,
            mode: { mode: 'Full' },
            offset: lineNumber,
            count,
            context: 0,
          });
          snippet = result.lines.map((l) => l.raw);
        } catch {
          // proceed without snippet
        }

        await addBookmark(
          lineNumber,
          trimmedLabel,
          note.trim(),
          'User',
          lineNumberEnd,
          snippet,
          category,
        );

        onClose();
      } catch (err) {
        console.error('[BookmarkCreateDialog] createBookmark failed:', err);
        setSubmitting(false);
      }
    },
    [request, submitting, label, note, category, onClose, addBookmark],
  );

  const isRange =
    request != null &&
    request.lineNumberEnd != null &&
    request.lineNumberEnd > request.lineNumber;

  const dialogTitle = request
    ? isRange
      ? `Bookmark Lines ${request.lineNumber + 1}–${request.lineNumberEnd! + 1}`
      : `Bookmark Line ${request.lineNumber + 1}`
    : '';

  return (
    <Modal open={request !== null} onClose={onClose} width={420} noPadding>
      <div className={styles.header}>
        <span className={styles.title}>{dialogTitle}</span>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      {request && (
        <form className={styles.body} onSubmit={handleSubmit}>
          {/* Label */}
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="bm-label">
              Label
            </label>
            <input
              id="bm-label"
              ref={labelRef}
              className={styles.input}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`Line ${request.lineNumber + 1}`}
              autoComplete="off"
            />
          </div>

          {/* Category */}
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="bm-category">
              Category
            </label>
            <select
              id="bm-category"
              className={styles.select}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* Note */}
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="bm-note">
              Note <span className={styles.optional}>(optional)</span>
            </label>
            <textarea
              id="bm-note"
              className={styles.textarea}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Add a note…"
            />
          </div>

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Save Bookmark'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
});

export default BookmarkCreateDialog;
