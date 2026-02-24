import React, { useRef } from 'react';
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
  value: string;
  onChange: (value: string) => void;
  matchCount?: number | null;
  totalLines?: number;
  parseError?: string | null;
  scanning?: boolean;
  onCopyAll?: () => void;
}

export const StreamFilterBar = React.memo<StreamFilterBarProps>(
  function StreamFilterBar({
    value,
    onChange,
    matchCount,
    totalLines = 0,
    parseError = null,
    scanning,
    onCopyAll,
  }) {
    const inputRef = useRef<HTMLInputElement>(null);

    const insertChip = (text: string) => {
      const input = inputRef.current;
      const start = input?.selectionStart ?? value.length;
      const prefix = start > 0 && value[start - 1] !== ' ' ? ' ' : '';
      const newVal = value.slice(0, start) + prefix + text + value.slice(start);
      onChange(newVal.trimStart());
      requestAnimationFrame(() => {
        if (!input) return;
        input.focus();
        const pos = start + prefix.length + text.length;
        input.setSelectionRange(pos, pos);
      });
    };

    const isFiltering = value.trim().length > 0;
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
          {isFiltering && !hasError && scanning && (
            <span className={clsx(styles.count, styles.countScanning)}>Scanning...</span>
          )}
          {isFiltering && !hasError && !scanning && matchCount != null && (
            <span className={styles.count}>
              {matchCount.toLocaleString()} / {totalLines.toLocaleString()} lines
              {onCopyAll && (
                <button className={styles.copyBtn} onClick={onCopyAll} title="Copy all matched lines to clipboard" tabIndex={-1}>
                  Copy all
                </button>
              )}
            </span>
          )}
          {isFiltering && !hasError && !scanning && matchCount == null && (
            <span className={styles.count}>{totalLines.toLocaleString()} lines</span>
          )}
        </div>

        <div className={clsx(styles.inputRow, hasError && styles.inputRowError)}>
          <Search size={13} className={styles.icon} />
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="package:com.example  tag:MyTag  level:E | message:crash"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          {isFiltering && (
            <button
              className={styles.clearBtn}
              onClick={() => onChange('')}
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
