import { useRef } from 'react';

interface Props {
  value: string;
  onChange: (expr: string) => void;
  /** Number of filtered lines, or null when no filter is active */
  matchCount: number | null;
  /** Total unfiltered line count */
  totalCount: number;
  /** Parse error from the last expression, or null if valid */
  parseError: string | null;
}

const CHIPS: { label: string; hint: string }[] = [
  { label: 'package:', hint: 'Filter by app package name (resolves to PIDs)' },
  { label: 'tag:', hint: 'Filter by logcat tag (substring)' },
  { label: 'level:E', hint: 'Filter by level: V D I W E F' },
  { label: 'message:', hint: 'Filter by message text (substring)' },
];

export default function StreamFilterBar({
  value,
  onChange,
  matchCount,
  totalCount,
  parseError,
}: Props) {
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
    <div className="stream-filter-bar">
      <div className="filter-chips">
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            className="filter-chip"
            title={chip.hint}
            onClick={() => insertChip(chip.label)}
            tabIndex={-1}
          >
            {chip.label}
          </button>
        ))}
        {isFiltering && !hasError && matchCount !== null && (
          <span className="filter-count">
            {matchCount.toLocaleString()} / {totalCount.toLocaleString()} lines
          </span>
        )}
        {isFiltering && !hasError && matchCount === null && (
          <span className="filter-count">
            {totalCount.toLocaleString()} lines
          </span>
        )}
      </div>

      <div className={`filter-input-row${hasError ? ' filter-input-row--error' : ''}`}>
        <svg className="filter-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.242 1.156a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"/>
        </svg>
        <input
          ref={inputRef}
          type="text"
          className="filter-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="package:com.example  tag:MyTag  level:E | message:crash"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        {isFiltering && (
          <button
            className="filter-clear"
            onClick={() => onChange('')}
            title="Clear filter"
            tabIndex={-1}
          >
            ×
          </button>
        )}
      </div>

      {hasError && (
        <div className="filter-parse-error">
          <span className="filter-parse-error-icon">⚠</span> {parseError}
        </div>
      )}
    </div>
  );
}
