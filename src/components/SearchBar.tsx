import { useState, useRef, useCallback, useEffect } from 'react';
import type { SearchQuery, SearchSummary } from '../bridge/types';

interface Props {
  onSearch: (query: SearchQuery | null) => void;
  summary: SearchSummary | null;
  onJumpToMatch: (direction: 1 | -1) => void;
  currentMatchIndex: number;
  disabled?: boolean;
  /** Called when the time range filter changes */
  onTimeFilter?: (start: string, end: string) => void;
  /** Current time range start value ("HH:MM") from parent state */
  timeStart?: string;
  /** Current time range end value ("HH:MM") from parent state */
  timeEnd?: string;
  /** Number of lines matching the time filter, or null when filter is not active */
  timeFilterCount?: number | null;
}

export default function SearchBar({
  onSearch,
  summary,
  onJumpToMatch,
  currentMatchIndex,
  disabled,
  onTimeFilter,
  timeStart = '',
  timeEnd = '',
  timeFilterCount,
}: Props) {
  const [text, setText] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  // Local state for time inputs — updated immediately on keystroke for responsiveness.
  // The parent's timeStart/timeEnd values are only used for detecting external resets.
  const [localStart, setLocalStart] = useState(timeStart);
  const [localEnd, setLocalEnd] = useState(timeEnd);
  // Refs mirror state so debounce callbacks always read the latest values.
  const localStartRef = useRef(timeStart);
  const localEndRef = useRef(timeEnd);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when the parent resets the filter externally (e.g., new file load)
  useEffect(() => {
    if (timeStart === '' && timeEnd === '') {
      setLocalStart('');
      setLocalEnd('');
      localStartRef.current = '';
      localEndRef.current = '';
    }
  }, [timeStart, timeEnd]);

  const triggerSearch = useCallback(
    (value: string, regex: boolean, cs: boolean) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (!value.trim()) {
          onSearch(null);
        } else {
          onSearch({ text: value, isRegex: regex, caseSensitive: cs });
        }
      }, 250);
    },
    [onSearch],
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setText(v);
    triggerSearch(v, isRegex, caseSensitive);
  };

  const handleRegexToggle = () => {
    const v = !isRegex;
    setIsRegex(v);
    triggerSearch(text, v, caseSensitive);
  };

  const handleCaseToggle = () => {
    const v = !caseSensitive;
    setCaseSensitive(v);
    triggerSearch(text, isRegex, v);
  };

  const handleClear = () => {
    setText('');
    onSearch(null);
    inputRef.current?.focus();
  };

  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocalStart(v);
    localStartRef.current = v;
    if (timeDebounceRef.current) clearTimeout(timeDebounceRef.current);
    timeDebounceRef.current = setTimeout(() => {
      onTimeFilter?.(localStartRef.current, localEndRef.current);
    }, 400);
  };

  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocalEnd(v);
    localEndRef.current = v;
    if (timeDebounceRef.current) clearTimeout(timeDebounceRef.current);
    timeDebounceRef.current = setTimeout(() => {
      onTimeFilter?.(localStartRef.current, localEndRef.current);
    }, 400);
  };

  const handleClearTime = () => {
    setLocalStart('');
    setLocalEnd('');
    localStartRef.current = '';
    localEndRef.current = '';
    onTimeFilter?.('', '');
  };

  const hasTimeFilter = localStart !== '' || localEnd !== '';

  // Global Ctrl+F handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        handleClear();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const matchLabel =
    summary && summary.totalMatches > 0
      ? `${currentMatchIndex + 1} / ${summary.totalMatches}`
      : summary?.totalMatches === 0
        ? 'No matches'
        : '';

  return (
    <div className="search-bar">
      <div className="search-input-wrap">
        <span className="search-icon">⌕</span>
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="Search logs… (Ctrl+F)"
          value={text}
          onChange={handleTextChange}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onJumpToMatch(e.shiftKey ? -1 : 1);
              e.preventDefault();
            }
          }}
        />
        {text && (
          <button className="search-clear" onClick={handleClear} title="Clear (Esc)">
            ×
          </button>
        )}
      </div>

      <button
        className={`search-toggle ${isRegex ? 'active' : ''}`}
        onClick={handleRegexToggle}
        title="Regular expression"
        disabled={disabled}
      >
        .*
      </button>

      <button
        className={`search-toggle ${caseSensitive ? 'active' : ''}`}
        onClick={handleCaseToggle}
        title="Case sensitive"
        disabled={disabled}
      >
        Aa
      </button>

      {onTimeFilter && (
        <div className="time-filter-wrap">
          <span className="time-filter-label">⏱</span>
          <input
            className="time-input"
            type="text"
            placeholder="HH:MM"
            value={localStart}
            onChange={handleStartChange}
            disabled={disabled}
            title="Start time (HH:MM)"
            maxLength={8}
          />
          <span className="time-filter-sep">–</span>
          <input
            className="time-input"
            type="text"
            placeholder="HH:MM"
            value={localEnd}
            onChange={handleEndChange}
            disabled={disabled}
            title="End time (HH:MM)"
            maxLength={8}
          />
          {hasTimeFilter && (
            <button className="search-clear" onClick={handleClearTime} title="Clear time filter">
              ×
            </button>
          )}
          {hasTimeFilter && timeFilterCount !== null && timeFilterCount !== undefined && (
            <span className="time-filter-count">{timeFilterCount.toLocaleString()} lines</span>
          )}
        </div>
      )}

      {summary && (
        <>
          <span className="search-count">{matchLabel}</span>
          <button
            className="search-nav"
            onClick={() => onJumpToMatch(-1)}
            disabled={!summary.totalMatches}
            title="Previous match (Shift+Enter)"
          >
            ▲
          </button>
          <button
            className="search-nav"
            onClick={() => onJumpToMatch(1)}
            disabled={!summary.totalMatches}
            title="Next match (Enter)"
          >
            ▼
          </button>
        </>
      )}
    </div>
  );
}
