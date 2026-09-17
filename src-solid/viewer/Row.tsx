/** @jsxImportSource solid-js */
import { Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { HighlightSpan } from '@bridge/generated/HighlightSpan';
import type { LogLevel } from '@bridge/generated/LogLevel';
import type { DataSource } from '@viewport/DataSource';
import { HighlightedText, mergeHighlights } from './HighlightedText';
import styles from './LogViewer.module.css';

/**
 * One absolutely-positioned row of the virtual window.
 *
 * Two coordinate systems meet here and must not be confused:
 *  - `virtualBase + index` is the **rendered index** — the row's position in
 *    whatever the data source is currently showing. It is the click identity
 *    (`data-line`, `onLineClick`) and the selection key, exactly as React's
 *    `lineNumOverride` is.
 *  - `line().lineNum` is the **absolute backend line number**. It is what the
 *    gutter prints, so a filtered view reads 61 234 rather than 1 — matching
 *    what a bookmark, an agent's `lines_around` and an exported `.lts` say.
 *  Skeleton rows have no `ViewLine` yet and fall back to the positional number,
 *  as React's `TextLineSkeleton` does.
 *
 * Reads its line through a `createMemo` keyed on `cacheVersion`: bumping the
 * version re-runs every row's memo, but a memo only notifies downstream when
 * its value changes by reference, so an append repaints only the rows whose
 * `getLine` result actually resolved.
 *
 * All styling is class- and `data-*`-driven; the only inline contribution is
 * the `--row-top` custom property the stylesheet consumes.
 */

const LEVEL_LETTER: Record<LogLevel, string> = {
  Verbose: 'V',
  Debug: 'D',
  Info: 'I',
  Warn: 'W',
  Error: 'E',
  Fatal: 'F',
};

export interface RowProps {
  /** Index relative to `virtualBase`. */
  index: number;
  virtualBase: number;
  rowHeight: number;
  /** Invalidation counter from `createCacheBinding`. */
  cacheVersion: number;
  dataSource: DataSource;
  /**
   * `ViewerController.highlights(sessionId)` for the session on screen. Spans
   * found here for this line win over the ones the backend put on `ViewLine`.
   */
  controllerHighlights?: Map<number, HighlightSpan[]> | null;
  selected: boolean;
  /** The keyboard cursor's row. */
  active: boolean;
  /**
   * Non-null while this row is the target of a controller jump that asked for
   * a highlight. The value becomes `data-flash`, and the stylesheet keys a
   * different animation-name off each phase, so flashing the same row twice in
   * a row restarts the animation instead of being swallowed.
   */
  flash?: 'a' | 'b' | null;
  onLineClick: (lineNum: number, e: MouseEvent) => void;
}

export function Row(props: RowProps) {
  const lineNum = () => props.virtualBase + props.index;

  const line = createMemo(() => {
    void props.cacheVersion; // invalidation dependency
    return props.dataSource.getLine(lineNum());
  });

  /** Absolute backend line number once the line resolves; positional until then. */
  const shownLineNum = () => line()?.lineNum ?? lineNum();

  const highlights = createMemo<HighlightSpan[]>(() => {
    const l = line();
    if (!l) return [];
    const extra = props.controllerHighlights?.get(lineNum());
    return extra ? mergeHighlights(l.highlights, extra) : l.highlights;
  });

  const style = (): JSX.CSSProperties =>
    ({ '--row-top': `${props.index * props.rowHeight}px` }) as JSX.CSSProperties;

  return (
    <div
      class={styles.row}
      style={style()}
      role="row"
      aria-rowindex={lineNum() + 1}
      data-line={lineNum()}
      data-level={line()?.level}
      data-selected={props.selected ? '' : undefined}
      data-active={props.active ? '' : undefined}
      data-flash={props.flash ?? undefined}
      data-skeleton={line() ? undefined : ''}
      onClick={(e) => props.onLineClick(lineNum(), e)}
    >
      <span class={styles.lineNum} role="gridcell">
        {String(shownLineNum() + 1).padStart(7, ' ')}
      </span>
      <Show when={line()} fallback={<span class={styles.skeletonBar} role="gridcell" />}>
        {(l) => (
          <>
            <span class={styles.level} role="gridcell">{LEVEL_LETTER[l().level] ?? ' '}</span>
            <span class={styles.msg} role="gridcell">
              <HighlightedText text={l().raw} highlights={highlights()} />
            </span>
          </>
        )}
      </Show>
    </div>
  );
}
