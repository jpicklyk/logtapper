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
  onLineClick: (lineNum: number, e: MouseEvent) => void;
}

export function Row(props: RowProps) {
  const lineNum = () => props.virtualBase + props.index;

  const line = createMemo(() => {
    void props.cacheVersion; // invalidation dependency
    return props.dataSource.getLine(lineNum());
  });

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
      data-line={lineNum()}
      data-level={line()?.level}
      data-selected={props.selected ? '' : undefined}
      data-active={props.active ? '' : undefined}
      data-skeleton={line() ? undefined : ''}
      onClick={(e) => props.onLineClick(lineNum(), e)}
    >
      <span class={styles.lineNum}>{String(lineNum() + 1).padStart(7, ' ')}</span>
      <Show when={line()} fallback={<span class={styles.skeletonBar} />}>
        {(l) => (
          <>
            <span class={styles.level}>{LEVEL_LETTER[l().level] ?? ' '}</span>
            <span class={styles.msg}>
              <HighlightedText text={l().raw} highlights={highlights()} />
            </span>
          </>
        )}
      </Show>
    </div>
  );
}
