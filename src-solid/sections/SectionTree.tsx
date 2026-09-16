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
      /** Every section `startLine` this header's checkbox governs (itself included for `parent`). */
      startLines: readonly number[];
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
        startLines: row.sections.map((item) => item.section.startLine),
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
      startLines: [row.section.startLine, ...row.children.map((c) => c.section.startLine)],
    });
    if (isExpanded(key)) {
      for (const child of row.children) {
        out.push({ type: 'leaf', key: `s-${child.section.startLine}`, section: child.section, child: true });
      }
    }
  }
  return out;
}

/** 'all' | 'some' | 'none' selected among `startLines`, for a group's checkbox state. */
function groupCheckState(
  startLines: readonly number[],
  isSelected: (startLine: number) => boolean,
): 'all' | 'some' | 'none' {
  const selectedCount = startLines.filter(isSelected).length;
  if (selectedCount === 0) return 'none';
  return selectedCount === startLines.length ? 'all' : 'some';
}

function lineCount(section: SectionEntry): number {
  return section.endLine - section.startLine + 1;
}

export interface SectionTreeProps {
  rows: readonly FlatRow[];
  activeStartLine: number;
  focusedKey: string | null;
  isSelected: (startLine: number) => boolean;
  isExpanded: (key: string) => boolean;
  onToggle: (startLine: number) => void;
  onToggleGroup: (startLines: readonly number[]) => void;
  onToggleExpanded: (key: string) => void;
  onJump: (section: SectionEntry) => void;
  onFocusRow: (key: string) => void;
}

/**
 * The tree itself — a flat, virtualization-free list (bugreports rarely exceed
 * a few hundred sections).
 *
 * Rows are `div role="treeitem"`, not `button`. Two reasons: HTML forbids
 * interactive descendants inside a `button`, and the checkbox each row carries
 * was one; and a native button per row put 586 stops in the tab order for a
 * large dumpstate, where a tree should expose exactly one. Focus is roving
 * (`tabIndex` 0 on the focused row, -1 elsewhere), driven by `SectionsPanel`'s
 * Arrow/Enter/Space handling — which is also what makes the `tabIndex={-1}`
 * checkbox keyboard-operable (Space on the focused row).
 */
export function SectionTree(props: SectionTreeProps) {
  const rowTabIndex = (key: string): number => (key === props.focusedKey ? 0 : -1);

  return (
    <div class={styles.tree} role="tree">
      <For each={props.rows}>
        {(row) =>
          row.type === 'leaf' ? (
            <div
              class={styles.row}
              classList={{
                [styles.rowActive]: row.section.startLine === props.activeStartLine,
                [styles.rowFocused]: row.key === props.focusedKey,
                [styles.rowChild]: row.child,
              }}
              role="treeitem"
              data-row-key={row.key}
              tabIndex={rowTabIndex(row.key)}
              aria-level={row.child ? 2 : 1}
              title={getSectionDescription(row.section.name) ?? row.section.name}
              onClick={() => props.onJump(row.section)}
              onFocus={() => props.onFocusRow(row.key)}
            >
              <input
                type="checkbox"
                class={styles.checkbox}
                tabIndex={-1}
                checked={props.isSelected(row.section.startLine)}
                onClick={(event) => event.stopPropagation()}
                onChange={() => props.onToggle(row.section.startLine)}
                aria-label={`Filter to ${row.section.name}`}
              />
              <span class={styles.rowName}>{row.section.name}</span>
              <span class={styles.rowLines}>{lineCount(row.section).toLocaleString()}</span>
            </div>
          ) : (
            <div
              class={styles.groupRow}
              classList={{ [styles.rowFocused]: row.key === props.focusedKey }}
              role="treeitem"
              data-row-key={row.key}
              tabIndex={rowTabIndex(row.key)}
              aria-level={1}
              aria-expanded={props.isExpanded(row.key)}
              onClick={() => props.onToggleExpanded(row.key)}
              onFocus={() => props.onFocusRow(row.key)}
            >
              <input
                type="checkbox"
                class={styles.checkbox}
                tabIndex={-1}
                checked={groupCheckState(row.startLines, props.isSelected) === 'all'}
                // The native `indeterminate` DOM property has no declarative
                // JSX form; rather than an imperative ref effect, the partial
                // state is a plain data attribute the stylesheet paints —
                // fully declarative, consistent with the rest of this file.
                data-partial={groupCheckState(row.startLines, props.isSelected) === 'some' ? '' : undefined}
                onClick={(event) => event.stopPropagation()}
                onChange={() => props.onToggleGroup(row.startLines)}
                aria-label={`Filter to all of ${row.label}`}
              />
              <span class={styles.rowName}>{row.label}</span>
              <span class={styles.groupBadge}>{row.count}</span>
              <span class={styles.rowLines}>{row.totalLines.toLocaleString()}</span>
              <span class={styles.chevron} classList={{ [styles.chevronOpen]: props.isExpanded(row.key) }} aria-hidden="true">
                {'›'}
              </span>
            </div>
          )
        }
      </For>
    </div>
  );
}
