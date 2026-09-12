/** @jsxImportSource solid-js */
import { For } from 'solid-js';
import type { SectionEntry, SectionRow } from '@fileinfo/sectionTree';
import { getSectionDescription } from '@fileinfo/sectionDescriptions';
import styles from './sections.module.css';

/**
 * A flattened, keyboard-navigable row: either a jumpable leaf (a `single`
 * section, or one member of an expanded group/parent) or a collapsible group
 * header (`prefixGroup`/`parent` — clicking one toggles expand, exactly like
 * React's `SectionGroup`/`ParentSection`; there is no separate jump target for
 * the header itself).
 */
export type FlatRow =
  | { type: 'leaf'; key: string; section: SectionEntry; child: boolean }
  | {
      type: 'group';
      key: string;
      label: string;
      count: number;
      totalLines: number;
      /** Every section name this header's checkbox governs (itself included for `parent`). */
      names: readonly string[];
    };

/** Flatten a section tree into keyboard-navigable rows, honouring which groups are open. */
export function flattenRows(rows: readonly SectionRow[], isExpanded: (key: string) => boolean): FlatRow[] {
  const out: FlatRow[] = [];
  for (const row of rows) {
    if (row.kind === 'single') {
      out.push({ type: 'leaf', key: `s-${row.section.startLine}`, section: row.section, child: false });
      continue;
    }
    if (row.kind === 'prefixGroup') {
      const key = `g-${row.prefix}`;
      out.push({
        type: 'group',
        key,
        label: row.prefix.trim(),
        count: row.sections.length,
        totalLines: row.totalLines,
        names: row.sections.map((item) => item.section.name),
      });
      if (isExpanded(key)) {
        for (const item of row.sections) {
          out.push({ type: 'leaf', key: `s-${item.section.startLine}`, section: item.section, child: true });
        }
      }
      continue;
    }
    // 'parent'
    const key = `p-${row.section.startLine}`;
    out.push({
      type: 'group',
      key,
      label: row.section.name,
      count: row.children.length,
      totalLines: row.totalLines,
      names: [row.section.name, ...row.children.map((c) => c.section.name)],
    });
    if (isExpanded(key)) {
      for (const child of row.children) {
        out.push({ type: 'leaf', key: `s-${child.section.startLine}`, section: child.section, child: true });
      }
    }
  }
  return out;
}

/** 'all' | 'some' | 'none' selected among `names`, for a group's checkbox state. */
function groupCheckState(names: readonly string[], isSelected: (name: string) => boolean): 'all' | 'some' | 'none' {
  const selectedCount = names.filter(isSelected).length;
  if (selectedCount === 0) return 'none';
  return selectedCount === names.length ? 'all' : 'some';
}

function lineCount(section: SectionEntry): number {
  return section.endLine - section.startLine + 1;
}

export interface SectionTreeProps {
  rows: readonly FlatRow[];
  activeStartLine: number;
  focusedKey: string | null;
  isSelected: (name: string) => boolean;
  isExpanded: (key: string) => boolean;
  onToggle: (name: string) => void;
  onToggleGroup: (names: readonly string[]) => void;
  onToggleExpanded: (key: string) => void;
  onJump: (section: SectionEntry) => void;
  onFocusRow: (key: string) => void;
}

/** The tree itself — a flat, virtualization-free list (bugreports rarely exceed a few hundred sections). */
export function SectionTree(props: SectionTreeProps) {
  return (
    <div class={styles.tree} role="tree">
      <For each={props.rows}>
        {(row) =>
          row.type === 'leaf' ? (
            <button
              type="button"
              class={styles.row}
              classList={{
                [styles.rowActive]: row.section.startLine === props.activeStartLine,
                [styles.rowFocused]: row.key === props.focusedKey,
                [styles.rowChild]: row.child,
              }}
              role="treeitem"
              data-row-key={row.key}
              aria-selected={props.isSelected(row.section.name)}
              title={getSectionDescription(row.section.name) ?? row.section.name}
              onClick={() => props.onJump(row.section)}
              onFocus={() => props.onFocusRow(row.key)}
            >
              <input
                type="checkbox"
                class={styles.checkbox}
                checked={props.isSelected(row.section.name)}
                onClick={(event) => event.stopPropagation()}
                onChange={() => props.onToggle(row.section.name)}
                aria-label={`Filter to ${row.section.name}`}
              />
              <span class={styles.rowName}>{row.section.name}</span>
              <span class={styles.rowLines}>{lineCount(row.section).toLocaleString()}</span>
            </button>
          ) : (
            <button
              type="button"
              class={styles.groupRow}
              classList={{ [styles.rowFocused]: row.key === props.focusedKey }}
              role="treeitem"
              data-row-key={row.key}
              aria-expanded={props.isExpanded(row.key)}
              onClick={() => props.onToggleExpanded(row.key)}
              onFocus={() => props.onFocusRow(row.key)}
            >
              <input
                type="checkbox"
                class={styles.checkbox}
                checked={groupCheckState(row.names, props.isSelected) === 'all'}
                // The native `indeterminate` DOM property has no declarative
                // JSX form; rather than an imperative ref effect, the partial
                // state is a plain data attribute the stylesheet paints —
                // fully declarative, consistent with the rest of this file.
                data-partial={groupCheckState(row.names, props.isSelected) === 'some' ? '' : undefined}
                onClick={(event) => event.stopPropagation()}
                onChange={() => props.onToggleGroup(row.names)}
                aria-label={`Filter to all of ${row.label}`}
              />
              <span class={styles.rowName}>{row.label}</span>
              <span class={styles.groupBadge}>{row.count}</span>
              <span class={styles.rowLines}>{row.totalLines.toLocaleString()}</span>
              <span class={styles.chevron} classList={{ [styles.chevronOpen]: props.isExpanded(row.key) }} aria-hidden="true">
                {'›'}
              </span>
            </button>
          )
        }
      </For>
    </div>
  );
}
