/** @jsxImportSource solid-js */
import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FilterCriteria, LogLevel } from '@bridge/types';
import { LEVEL_SHORT } from '@bridge/types';
import styles from './watches.module.css';

/** Solid port of `src-next/components/WatchesPanel/CriteriaChips.tsx` —
 *  read-only rendering of a watch's `FilterCriteria`, unchanged shape. */
export interface CriteriaChipsProps {
  criteria: FilterCriteria;
}

const DANGER_LEVELS = new Set<LogLevel>(['Error', 'Fatal']);
const WARNING_LEVELS = new Set<LogLevel>(['Warn']);

interface Chip {
  key: string;
  text: string;
  kind?: 'label' | 'danger' | 'warning' | 'accent' | 'dimmed';
}

function levelChips(levels: readonly LogLevel[]): Chip[] {
  return levels.map((lvl) => ({
    key: `level-${lvl}`,
    text: LEVEL_SHORT[lvl] ?? lvl,
    kind: DANGER_LEVELS.has(lvl) ? 'danger' : WARNING_LEVELS.has(lvl) ? 'warning' : undefined,
  }));
}

export function CriteriaChips(props: CriteriaChipsProps): JSX.Element {
  const chips = (): Chip[] => {
    const c = props.criteria;
    const out: Chip[] = [];
    if (c.textSearch) out.push({ key: 'text', text: `text:${c.textSearch}` });
    if (c.regex) out.push({ key: 'regex', text: `/${c.regex}/` });
    if (c.logLevels?.length) out.push(...levelChips(c.logLevels));
    if (c.tags?.length) for (const tag of c.tags) out.push({ key: `tag-${tag}`, text: `tag:${tag}` });
    if (c.pids?.length) out.push({ key: 'pids', text: `pid:${c.pids.join(', ')}` });
    if (c.combine === 'or') out.push({ key: 'combine', text: 'OR', kind: 'accent' });
    if (out.length === 0) out.push({ key: 'empty', text: 'no criteria', kind: 'dimmed' });
    return out;
  };

  const chipClass = (kind: Chip['kind']): string =>
    [
      styles.chip,
      kind === 'danger' && styles.chipDanger,
      kind === 'warning' && styles.chipWarning,
      kind === 'accent' && styles.chipAccent,
      kind === 'dimmed' && styles.chipDimmed,
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <div class={styles.chips}>
      <For each={chips()}>{(chip) => <span class={chipClass(chip.kind)}>{chip.text}</span>}</For>
    </div>
  );
}
