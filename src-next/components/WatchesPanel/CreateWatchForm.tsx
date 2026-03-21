import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { FilterCriteria, LogLevel, CombineMode } from '../../bridge/types';
import { Button } from '../../ui';
import clsx from 'clsx';
import styles from './WatchesPanel.module.css';

interface CreateWatchFormProps {
  onSubmit: (criteria: FilterCriteria) => Promise<void>;
  onCancel: () => void;
}

const ALL_LEVELS: { key: LogLevel; label: string }[] = [
  { key: 'Verbose', label: 'V' },
  { key: 'Debug', label: 'D' },
  { key: 'Info', label: 'I' },
  { key: 'Warn', label: 'W' },
  { key: 'Error', label: 'E' },
  { key: 'Fatal', label: 'F' },
];

export const CreateWatchForm = React.memo(function CreateWatchForm({
  onSubmit,
  onCancel,
}: CreateWatchFormProps) {
  const [textSearch, setTextSearch] = useState('');
  const [regex, setRegex] = useState('');
  const [selectedLevels, setSelectedLevels] = useState<Set<LogLevel>>(new Set());
  const [tags, setTags] = useState('');
  const [pids, setPids] = useState('');
  const [combine, setCombine] = useState<CombineMode>('and');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const toggleLevel = useCallback((level: LogLevel) => {
    setSelectedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const buildCriteria = useCallback((): FilterCriteria | null => {
    const criteria: FilterCriteria = {};
    if (textSearch.trim()) criteria.textSearch = textSearch.trim();
    if (regex.trim()) criteria.regex = regex.trim();
    if (selectedLevels.size > 0) criteria.logLevels = Array.from(selectedLevels);
    if (tags.trim()) {
      criteria.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
    }
    if (pids.trim()) {
      const parsed = pids
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((n) => !isNaN(n));
      if (parsed.length > 0) criteria.pids = parsed;
    }
    if (combine !== 'and') criteria.combine = combine;

    if (Object.keys(criteria).length === 0) return null;
    return criteria;
  }, [textSearch, regex, selectedLevels, tags, pids, combine]);

  const handleSubmit = useCallback(async () => {
    const criteria = buildCriteria();
    if (!criteria) {
      setError('At least one filter criterion is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(criteria);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }, [buildCriteria, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSubmit, onCancel],
  );

  return (
    <div className={styles.createForm} onKeyDown={handleKeyDown}>
      {/* Row 1: text search */}
      <div className={styles.formRow}>
        <input
          ref={inputRef}
          className={styles.formInput}
          type="text"
          placeholder="Text search..."
          value={textSearch}
          onChange={(e) => setTextSearch(e.target.value)}
        />
      </div>

      {/* Row 2: levels + optional fields */}
      <div className={styles.formRow}>
        <div className={styles.levelGroup}>
          {ALL_LEVELS.map(({ key, label }) => (
            <button
              key={key}
              className={clsx(
                styles.levelToggle,
                selectedLevels.has(key) && styles.levelToggleActive,
                (key === 'Error' || key === 'Fatal') && selectedLevels.has(key) && styles.levelToggleDanger,
                key === 'Warn' && selectedLevels.has(key) && styles.levelToggleWarning,
              )}
              onClick={() => toggleLevel(key)}
              type="button"
              title={key}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className={clsx(styles.formInput, styles.formInputSmall)}
          type="text"
          placeholder="tag"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <input
          className={clsx(styles.formInput, styles.formInputSmall)}
          type="text"
          placeholder="regex"
          value={regex}
          onChange={(e) => setRegex(e.target.value)}
        />
        <input
          className={clsx(styles.formInput, styles.formInputTiny)}
          type="text"
          placeholder="pid"
          value={pids}
          onChange={(e) => setPids(e.target.value)}
        />
      </div>

      {/* Row 3: combine + actions */}
      <div className={clsx(styles.formRow, styles.formRowActions)}>
        <div className={styles.combineGroup}>
          <button
            className={clsx(styles.combineToggle, combine === 'and' && styles.combineToggleActive)}
            onClick={() => setCombine('and')}
            type="button"
          >
            AND
          </button>
          <button
            className={clsx(styles.combineToggle, combine === 'or' && styles.combineToggleActive)}
            onClick={() => setCombine('or')}
            type="button"
          >
            OR
          </button>
        </div>
        {error && <span className={styles.formError}>{error}</span>}
        <div className={styles.formActions}>
          <button className={styles.formCancelLink} onClick={onCancel} type="button">
            Cancel
          </button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={submitting}>
            Create
          </Button>
        </div>
      </div>
    </div>
  );
});
