import React, { useState, useRef, useCallback, useEffect } from 'react';
import clsx from 'clsx';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { useSearch, useViewerActions } from '../../context';
import styles from './SearchBar.module.css';

interface SearchBarProps {
  disabled?: boolean;
  onTimeFilter?: (start: string, end: string) => void;
  timeStart?: string;
  timeEnd?: string;
  timeFilterCount?: number | null;
}

export const SearchBar = React.memo<SearchBarProps>(function SearchBar({
  disabled,
  onTimeFilter,
  timeStart = '',
  timeEnd = '',
  timeFilterCount,
}) {
  const { summary, matchIndex } = useSearch();
  const { setSearch, jumpToMatch } = useViewerActions();

  const [text, setText] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [localStart, setLocalStart] = useState(timeStart);
  const [localEnd, setLocalEnd] = useState(timeEnd);
  const localStartRef = useRef(timeStart);
  const localEndRef = useRef(timeEnd);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          setSearch(null);
        } else {
          setSearch({ text: value, isRegex: regex, caseSensitive: cs });
        }
      }, 250);
    },
    [setSearch],
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
    setSearch(null);
    inputRef.current?.focus();
  };

  const handleJump = useCallback(
    (direction: 1 | -1) => {
      jumpToMatch(direction);
    },
    [jumpToMatch],
  );

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

  const hasTimeFilter = localStart !== '' || localEnd !== '';
  const matchLabel =
    summary && summary.totalMatches > 0
      ? `${matchIndex + 1} / ${summary.totalMatches}`
      : summary?.totalMatches === 0
        ? 'No matches'
        : '';

  return (
    <div className={styles.bar}>
      <div className={styles.inputWrap}>
        <Search size={13} className={styles.searchIcon} />
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          placeholder="Search logs... (Ctrl+F)"
          value={text}
          onChange={handleTextChange}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'ArrowDown') {
              handleJump(e.shiftKey ? -1 : 1);
              e.preventDefault();
            } else if (e.key === 'ArrowUp') {
              handleJump(-1);
              e.preventDefault();
            }
          }}
        />
        {text && (
          <button className={styles.clearBtn} onClick={handleClear} title="Clear (Esc)">
            <X size={12} />
          </button>
        )}
      </div>

      <button
        className={clsx(styles.toggle, isRegex && styles.toggleActive)}
        onClick={handleRegexToggle}
        title="Regular expression"
        disabled={disabled}
      >
        .*
      </button>

      <button
        className={clsx(styles.toggle, caseSensitive && styles.toggleActive)}
        onClick={handleCaseToggle}
        title="Case sensitive"
        disabled={disabled}
      >
        Aa
      </button>

      {onTimeFilter && (
        <div className={styles.timeWrap}>
          <span className={styles.timeLabel}>T</span>
          <input
            className={styles.timeInput}
            type="text"
            placeholder="HH:MM"
            value={localStart}
            onChange={handleStartChange}
            disabled={disabled}
            title="Start time (HH:MM)"
            maxLength={8}
          />
          <span className={styles.timeSep}>&ndash;</span>
          <input
            className={styles.timeInput}
            type="text"
            placeholder="HH:MM"
            value={localEnd}
            onChange={handleEndChange}
            disabled={disabled}
            title="End time (HH:MM)"
            maxLength={8}
          />
          {hasTimeFilter && (
            <button className={styles.clearBtn} onClick={handleClearTime} title="Clear time filter">
              <X size={12} />
            </button>
          )}
          {hasTimeFilter && timeFilterCount != null && (
            <span className={styles.timeCount}>{timeFilterCount.toLocaleString()} lines</span>
          )}
        </div>
      )}

      {summary && (
        <>
          <span className={styles.matchCount}>{matchLabel}</span>
          <button
            className={styles.navBtn}
            onClick={() => handleJump(-1)}
            disabled={!summary.totalMatches}
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            className={styles.navBtn}
            onClick={() => handleJump(1)}
            disabled={!summary.totalMatches}
            title="Next match (Enter)"
          >
            <ChevronDown size={14} />
          </button>
        </>
      )}
    </div>
  );
});
