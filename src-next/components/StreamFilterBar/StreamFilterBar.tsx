import React, { useRef, useState, useEffect } from 'react';
import clsx from 'clsx';
import { Search, X, AlertTriangle } from 'lucide-react';
import styles from './StreamFilterBar.module.css';

const CHIPS: { label: string; hint: string }[] = [
  { label: 'package:', hint: 'Filter by app package name (resolves to PIDs)' },
  { label: 'tag:', hint: 'Filter by logcat tag (substring)' },
  { label: 'level:E', hint: 'Filter by level: V D I W E F' },
  { label: 'message:', hint: 'Filter by message text (substring)' },
];

interface StreamFilterBarProps {
  /** The last committed (applied) filter expression. */
  value: string;
  /** Called when the user presses Enter or clicks a chip — triggers a scan. */
  onCommit: (value: string) => void;
  /** Called when the user edits the input — cancels any active scan. */
  onCancel: () => void;
  matchCount?: number | null;
  totalLines?: number;
  parseError?: string | null;
  scanning?: boolean;
  onCopyAll?: () => void;
}

export const StreamFilterBar = React.memo<StreamFilterBarProps>(
  function StreamFilterBar({
    value,
    onCommit,
    onCancel,
    matchCount,
    totalLines = 0,
    parseError = null,
    scanning,
    onCopyAll,
  }) {
    const inputRef = useRef<HTMLInputElement>(null);
    // Local draft — tracks what the user is currently typing before committing.
    const [draft, setDraft] = useState(value);

    // Sync draft when the committed value changes from outside (session switch,
    // external clear, etc.) but only when the input isn't focused.
    useEffect(() => {
      if (document.activeElement !== inputRef.current) {
        setDraft(value);
      }
    }, [value]);

    const handleChange = (newDraft: string) => {
      setDraft(newDraft);
      onCancel();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onCommit(draft);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDraft('');
        onCommit('');
        inputRef.current?.blur();
      }
    };

    const handleClear = () => {
      setDraft('');
      onCommit('');
    };

    const insertChip = (text: string) => {
      const input = inputRef.current;
      const start = input?.selectionStart ?? draft.length;
      const prefix = start > 0 && draft[start - 1] !== ' ' ? ' ' : '';
      const newDraft = draft.slice(0, start) + prefix + text + draft.slice(start);
      setDraft(newDraft.trimStart());
      onCancel();
      requestAnimationFrame(() => {
        if (!input) return;
        input.focus();
        const pos = start + prefix.length + text.length;
        input.setSelectionRange(pos, pos);
      });
    };

    // Show filter status based on the committed value, not the draft.
    const isCommitted = value.trim().length > 0;
    const isDirty = draft !== value;
    const hasError = parseError !== null;

    return (
      <div className={styles.bar}>
        <div className={styles.chips}>
          {CHIPS.map((chip) => (
            <button
              key={chip.label}
              className={styles.chip}
              title={chip.hint}
              onClick={() => insertChip(chip.label)}
              tabIndex={-1}
            >
              {chip.label}
            </button>
          ))}
          {isDirty && draft.trim().length > 0 && (
            <span className={clsx(styles.count, styles.countScanning)}>Press Enter to apply</span>
          )}
          {!isDirty && isCommitted && !hasError && scanning && (
            <span className={clsx(styles.count, styles.countScanning)}>Scanning...</span>
          )}
          {!isDirty && isCommitted && !hasError && !scanning && matchCount != null && (
            <span className={styles.count}>
              {matchCount.toLocaleString()} / {totalLines.toLocaleString()} lines
              {onCopyAll && (
                <button className={styles.copyBtn} onClick={onCopyAll} title="Copy all matched lines to clipboard" tabIndex={-1}>
                  Copy all
                </button>
              )}
            </span>
          )}
          {!isDirty && isCommitted && !hasError && !scanning && matchCount == null && (
            <span className={styles.count}>{totalLines.toLocaleString()} lines</span>
          )}
        </div>

        <div className={clsx(styles.inputRow, hasError && styles.inputRowError)}>
          <Search size={13} className={styles.icon} />
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            value={draft}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="package:com.example  tag:MyTag  level:E | message:crash"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          {(draft.trim().length > 0) && (
            <button
              className={styles.clearBtn}
              onClick={handleClear}
              title="Clear filter"
              tabIndex={-1}
            >
              <X size={12} />
            </button>
          )}
        </div>

        {hasError && (
          <div className={styles.parseError}>
            <AlertTriangle size={12} className={styles.errorIcon} /> {parseError}
          </div>
        )}
      </div>
    );
  },
);
