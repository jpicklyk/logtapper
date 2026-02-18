import { useState, useRef, useCallback, useEffect } from 'react';
import type { SearchQuery, SearchSummary } from '../bridge/types';

interface Props {
  onSearch: (query: SearchQuery | null) => void;
  summary: SearchSummary | null;
  onJumpToMatch: (direction: 1 | -1) => void;
  currentMatchIndex: number;
  disabled?: boolean;
}

export default function SearchBar({
  onSearch,
  summary,
  onJumpToMatch,
  currentMatchIndex,
  disabled,
}: Props) {
  const [text, setText] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
