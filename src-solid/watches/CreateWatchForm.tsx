/** @jsxImportSource solid-js */
import { createSignal, For, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { CombineMode, FilterCriteria, LogLevel } from '@bridge/types';
// The "nothing set" base every partial-criteria literal spreads onto. Owned by
// `query/` and exported from its barrel — this form used to re-literalise the
// same eight nullable fields, which is exactly the drift `@bridge/CLAUDE.md`'s
// `T | null` policy warns about.
import { EMPTY_CRITERIA } from '../query';
import styles from './watches.module.css';

export interface CreateWatchFormProps {
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

/** Solid port of `src-next/components/WatchesPanel/CreateWatchForm.tsx`. Same
 *  fields, same "every `FilterCriteria` field is required (nullable) on the
 *  wire, start null and track whether anything was actually set" contract. */
export function CreateWatchForm(props: CreateWatchFormProps): JSX.Element {
  const [textSearch, setTextSearch] = createSignal('');
  const [regex, setRegex] = createSignal('');
  const [selectedLevels, setSelectedLevels] = createSignal<Set<LogLevel>>(new Set());
  const [tags, setTags] = createSignal('');
  const [pids, setPids] = createSignal('');
  const [combine, setCombine] = createSignal<CombineMode>('and');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inputRef: HTMLInputElement | undefined;

  onMount(() => inputRef?.focus());

  const toggleLevel = (level: LogLevel): void => {
    setSelectedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const buildCriteria = (): FilterCriteria | null => {
    // Spread, never alias: `EMPTY_CRITERIA` is a shared module-level object
    // and the assignments below mutate `criteria` in place.
    const criteria: FilterCriteria = { ...EMPTY_CRITERIA };
    let anySet = false;
    if (textSearch().trim()) { criteria.textSearch = textSearch().trim(); anySet = true; }
    if (regex().trim()) { criteria.regex = regex().trim(); anySet = true; }
    if (selectedLevels().size > 0) { criteria.logLevels = Array.from(selectedLevels()); anySet = true; }
    if (tags().trim()) {
      criteria.tags = tags().split(',').map((t) => t.trim()).filter(Boolean);
      anySet = true;
    }
    if (pids().trim()) {
      const parsed = pids()
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      if (parsed.length > 0) { criteria.pids = parsed; anySet = true; }
    }
    if (combine() !== 'and') { criteria.combine = combine(); anySet = true; }
    return anySet ? criteria : null;
  };

  const handleSubmit = async (): Promise<void> => {
    const criteria = buildCriteria();
    if (!criteria) {
      setError('At least one filter criterion is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await props.onSubmit(criteria);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onCancel();
    }
  };

  const levelClass = (key: LogLevel): string =>
    [
      styles.levelToggle,
      selectedLevels().has(key) && styles.levelToggleActive,
      (key === 'Error' || key === 'Fatal') && selectedLevels().has(key) && styles.levelToggleDanger,
      key === 'Warn' && selectedLevels().has(key) && styles.levelToggleWarning,
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <div class={styles.createForm} onKeyDown={handleKeyDown} data-testid="create-watch-form">
      <div class={styles.formRow}>
        <input
          ref={inputRef}
          class={styles.formInput}
          type="text"
          placeholder="Text search…"
          value={textSearch()}
          onInput={(e) => setTextSearch(e.currentTarget.value)}
        />
      </div>

      <div class={styles.formRow}>
        <div class={styles.levelGroup}>
          <For each={ALL_LEVELS}>
            {({ key, label }) => (
              <button
                type="button"
                class={levelClass(key)}
                onClick={() => toggleLevel(key)}
                title={key}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <input
          class={`${styles.formInput} ${styles.formInputSmall}`}
          type="text"
          placeholder="tag"
          value={tags()}
          onInput={(e) => setTags(e.currentTarget.value)}
        />
        <input
          class={`${styles.formInput} ${styles.formInputSmall}`}
          type="text"
          placeholder="regex"
          value={regex()}
          onInput={(e) => setRegex(e.currentTarget.value)}
        />
        <input
          class={`${styles.formInput} ${styles.formInputTiny}`}
          type="text"
          placeholder="pid"
          value={pids()}
          onInput={(e) => setPids(e.currentTarget.value)}
        />
      </div>

      <div class={`${styles.formRow} ${styles.formRowActions}`}>
        <div class={styles.combineGroup}>
          <button
            type="button"
            class={`${styles.combineToggle} ${combine() === 'and' ? styles.combineToggleActive : ''}`}
            onClick={() => setCombine('and')}
          >
            AND
          </button>
          <button
            type="button"
            class={`${styles.combineToggle} ${combine() === 'or' ? styles.combineToggleActive : ''}`}
            onClick={() => setCombine('or')}
          >
            OR
          </button>
        </div>
        {error() && <span class={styles.formError}>{error()}</span>}
        <div class={styles.formActions}>
          <button type="button" class={styles.formCancelLink} onClick={() => props.onCancel()}>
            Cancel
          </button>
          <button
            type="button"
            class={styles.primaryButtonSm}
            onClick={() => void handleSubmit()}
            disabled={submitting()}
          >
            {submitting() ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
