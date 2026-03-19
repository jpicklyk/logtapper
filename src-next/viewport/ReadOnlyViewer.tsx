import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DataSource } from './DataSource';
import type { GutterColumnDef } from './GutterColumn';
import type { LineDecoratorDef } from './LineDecorator';
import type { Selection } from './SelectionManager';
import { useSelectionManager } from './SelectionManager';
import { useVirtualBase } from './useVirtualBase';
import { useScrollControls } from './useScrollControls';
import { useFetchScheduler } from './useFetchScheduler';
import TextLine, { TextLineSkeleton } from './TextLine';
import { clamp } from '../utils';
import styles from './ReadOnlyViewer.module.css';

const LINE_HEIGHT = 22;
const OVERSCAN = 10;

// Chrome/Edge cap their DOM scrollHeight at 2^25 px. Beyond this the native
// scrollbar stops working. We keep the virtualizer's total height inside this
// limit by using a sliding "virtual base" offset for large files.
const MAX_BROWSER_SCROLL_PX = 33_554_428;
const MAX_VIRTUAL_LINES = Math.floor(MAX_BROWSER_SCROLL_PX / LINE_HEIGHT);

interface ReadOnlyViewerProps {
  dataSource: DataSource;
  /** External total line count — drives virtualizer size for file mode. */
  totalLineCount?: number;
  scrollToLine?: number;
  jumpSeq?: number;
  tailMode?: boolean;
  gutterColumns?: GutterColumnDef[];
  lineDecorators?: LineDecoratorDef[];
  onLineClick?: (lineNum: number) => void;
  /** Read-only notification called after selection changes. Parent must not
   *  use this to control selection — selection state lives inside the viewer. */
  onSelectionChange?: (selection: Selection) => void;
  className?: string;
  /** Starting virtual-base line when a known data source is restored (e.g.
   *  switching back to a previously-viewed session). Avoids resetting to 0. */
  initialVirtualBase?: number;
  /** Written with the current virtualBase on every render so the parent can
   *  capture scroll position before a session switch. */
  virtualBaseOutRef?: React.MutableRefObject<number>;
}

export default function ReadOnlyViewer({
  dataSource,
  totalLineCount,
  scrollToLine,
  jumpSeq,
  tailMode,
  gutterColumns,
  lineDecorators,
  onLineClick,
  onSelectionChange,
  className,
  initialVirtualBase,
  virtualBaseOutRef,
}: ReadOnlyViewerProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const charWidthRef = useRef(7.2);
  const gutterWidthRef = useRef(0);

  // ── Caret position ──────────────────────────────────────────────────────
  // Tracks a blinking text caret on plain click/drag (no modifier keys).
  // Cleared when line/box selection activates.
  const [caret, setCaret] = useState<{ line: number; col: number } | null>(null);
  const caretDragging = useRef(false);

  // ── Cache version counter ────────────────────────────────────────────────
  // Bumped after every fetch completion or streaming append to trigger
  // a re-render so the virtualizer re-evaluates dataSource.getLine().
  const [, setCacheVersion] = useState(0);
  const bumpCacheVersion = useCallback(() => setCacheVersion((v) => v + 1), []);

  // ── Pending jump ─────────────────────────────────────────────────────────
  // Stored when scrollToLine targets a line not yet in the virtualizer's count
  // (file still indexing). Retried by the effectiveCount effect.
  const pendingJumpRef = useRef<{ line: number; seq: number } | null>(null);

  useEffect(() => {
    pendingJumpRef.current = null;
  }, [dataSource.sourceId]);

  // ── Virtual base management ──────────────────────────────────────────────
  const { virtualBase, virtualBaseRef, setVirtualBase, pendingScrollTarget } =
    useVirtualBase(dataSource.sourceId, initialVirtualBase, tailMode, virtualBaseOutRef);

  const totalLines = totalLineCount ?? dataSource.totalLines;

  const gutterWidth = useMemo(
    () => (gutterColumns ?? []).reduce((sum, col) => sum + col.width, 0),
    [gutterColumns],
  );
  useEffect(() => { gutterWidthRef.current = gutterWidth; }, [gutterWidth]);

  // ── Scroll controls ──────────────────────────────────────────────────────
  const {
    autoScroll,
    autoScrollRef,
    newLinesCount,
    liveTotalLines,
    lastSetScrollTopRef,
    resetAutoScroll,
    disableAutoScroll,
  } = useScrollControls(parentRef, tailMode, totalLines, dataSource, bumpCacheVersion);

  const effectiveCount = clamp(totalLines - virtualBase, 0, MAX_VIRTUAL_LINES);
  const liveEffectiveCount = clamp(liveTotalLines - virtualBase, 0, MAX_VIRTUAL_LINES);

  // ── Virtualizer ──────────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: effectiveCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

  // ── Fetch scheduler ──────────────────────────────────────────────────────
  const { schedulerRef } = useFetchScheduler(
    dataSource, virtualBase, items, liveTotalLines, bumpCacheVersion,
  );

  // ── Selection manager ────────────────────────────────────────────────────
  const {
    selection,
    handleLineClick: selHandleLineClick,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    clear: clearSelection,
  } = useSelectionManager((n) => dataSource.getLine(n)?.raw);

  // Clear selection and caret when the data source changes (new session).
  useEffect(() => {
    clearSelection();
    setCaret(null);
  }, [dataSource.sourceId, clearSelection]);

  // Notify parent of selection changes (read-only).
  useEffect(() => {
    onSelectionChange?.(selection);
  }, [selection, onSelectionChange]);

  // ── Char width measurement (once at mount) ────────────────────────────
  useEffect(() => {
    const span = document.createElement('span');
    Object.assign(span.style, {
      position: 'fixed', top: '-9999px', visibility: 'hidden',
      whiteSpace: 'pre', fontSize: '12px', fontFamily: 'monospace',
    });
    const monoFont = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    if (monoFont) span.style.fontFamily = monoFont;
    span.textContent = 'x'.repeat(100);
    document.body.appendChild(span);
    const w = span.offsetWidth;
    document.body.removeChild(span);
    if (w > 0) charWidthRef.current = w / 100;
  }, []);

  // ── Alt key → crosshair cursor (no React state, no re-renders) ──────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') parentRef.current?.classList.add(styles.altMode);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') parentRef.current?.classList.remove(styles.altMode);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ── Auto-scroll to bottom when new streaming lines arrive ────────────────
  // Kept here (not in useScrollControls) because liveEffectiveCount depends
  // on virtualBase which comes from useVirtualBase.
  useEffect(() => {
    if (!tailMode || !autoScrollRef.current || liveEffectiveCount === 0) return;
    const el = parentRef.current;
    if (!el) return;

    // Drift detection: if the element scrolled away from where we put it,
    // the user is manually scrolling — disable auto-scroll.
    if (lastSetScrollTopRef.current >= 0) {
      const drift = Math.abs(el.scrollTop - lastSetScrollTopRef.current);
      if (drift > 2) {
        disableAutoScroll();
        lastSetScrollTopRef.current = -1;
        return;
      }
    }

    el.scrollTop = el.scrollHeight;
    lastSetScrollTopRef.current = el.scrollTop;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEffectiveCount]);

  // ── Ctrl+C copy handler for line and box selection ───────────────────────
  useEffect(() => {
    const hasSelection = selection.mode === 'box'
      ? selection.box != null
      : selection.selected.size > 0;
    if (!hasSelection) return;

    // Robust clipboard write: async Clipboard API with synchronous execCommand fallback.
    // navigator.clipboard can silently fail in Tauri WebView2 without the clipboard plugin.
    const writeClipboard = (text: string) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
      } else {
        execCommandCopy(text);
      }
    };

    const execCommandCopy = (text: string) => {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    };

    const handleCopy = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
      // If the browser has a native text selection (user dragged within a line),
      // let the browser handle the copy — don't intercept.
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      if (selection.mode === 'box' && selection.box) {
        const { startLine, endLine, startCol, endCol } = selection.box;
        const rows: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
          rows.push((dataSource.getLine(i)?.raw ?? '').slice(startCol, endCol));
        }
        writeClipboard(rows.join('\n'));
      } else if (selection.selected.size > 0) {
        const sorted = Array.from(selection.selected).sort((a, b) => a - b);
        const text = sorted
          .map((n) => dataSource.getLine(n)?.raw)
          .filter(Boolean)
          .join('\n');
        writeClipboard(text as string);
      }
    };

    window.addEventListener('keydown', handleCopy);
    return () => window.removeEventListener('keydown', handleCopy);
   
  }, [selection, dataSource]);

  // ── Scroll to a specific line when requested ─────────────────────────────
  useEffect(() => {
    if (scrollToLine == null || scrollToLine < 0) return;
    autoScrollRef.current = false;
    disableAutoScroll();

    const relIndex = scrollToLine - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      // If the target is beyond the virtualizer's current count (file still
      // indexing), defer until effectiveCount grows to include it.
      if (relIndex >= effectiveCount) {
        pendingJumpRef.current = { line: scrollToLine, seq: jumpSeq ?? 0 };
        return;
      }
      pendingJumpRef.current = null;
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
      schedulerRef.current?.forceFetch();
    } else {
      // scrollToLine is beyond MAX_VIRTUAL_LINES from current base — rebase
      // the virtual window and defer the scroll.
      const half = Math.floor(MAX_VIRTUAL_LINES / 2);
      const newBase = Math.max(0, scrollToLine - half);
      pendingScrollTarget.current = null;
      setVirtualBase(newBase);
      pendingJumpRef.current = { line: scrollToLine, seq: jumpSeq ?? 0 };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToLine, jumpSeq]);

  // Retry a pending jump when effectiveCount grows to include the target.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending) return;
    const relIndex = pending.line - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < effectiveCount) {
      pendingJumpRef.current = null;
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
      schedulerRef.current?.forceFetch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCount]);

  // Deferred scroll after virtualBase change.
  useEffect(() => {
    const target = pendingScrollTarget.current;
    if (target == null) return;
    const relIndex = target - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      pendingScrollTarget.current = null;
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
      schedulerRef.current?.forceFetch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualBase]);

  // ── Coordinate conversion for pointer events ─────────────────────────────
  const getLineColFromPointer = useCallback((clientX: number, clientY: number) => {
    const el = parentRef.current!;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop;
    const x = clientX - rect.left;
    const lineNum = virtualBaseRef.current + Math.max(0, Math.floor(y / LINE_HEIGHT));
    const col = Math.max(0, Math.floor((x - gutterWidthRef.current) / charWidthRef.current));
    return { lineNum, col };
  }, []);

  // ── Caret positioning helper ─────────────────────────────────────────────
  const caretFromPointer = useCallback((clientX: number, clientY: number) => {
    const el = parentRef.current;
    if (!el) return null;
    const { lineNum, col } = getLineColFromPointer(clientX, clientY);
    const lineText = dataSource.getLine(lineNum)?.raw ?? '';
    return { line: lineNum, col: Math.min(col, lineText.length) };
  }, [getLineColFromPointer, dataSource]);

  // ── Line click wrapper ────────────────────────────────────────────────────
  const handleLineClick = useCallback(
    (lineNum: number, e: React.MouseEvent) => {
      if (e.altKey) return;

      // Plain click after a drag-select: user selected text within a line.
      // Don't activate line selection — let the browser own the copy.
      const hasTextSel = !!window.getSelection()?.toString();
      if (hasTextSel && !e.shiftKey && !e.ctrlKey && !e.metaKey) return;

      window.getSelection()?.removeAllRanges();
      selHandleLineClick(lineNum, e);
      onLineClick?.(lineNum);

      // Caret is already tracked by pointer events — just clear on modifier clicks.
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        setCaret(null);
      }
    },
    [selHandleLineClick, onLineClick],
  );

  if (liveTotalLines === 0) {
    return (
      <div className={`${styles.empty}${className ? ' ' + className : ''}`}>
        <p>No data available.</p>
      </div>
    );
  }

  const hasMoreAbove = virtualBase > 0;
  const hasMoreBelow = virtualBase + effectiveCount < liveTotalLines;

  return (
    <div className={`${styles.wrapper}${className ? ' ' + className : ''}`}>
      {hasMoreAbove && (
        <button
          className={`${styles.navButton} ${styles.navTop}`}
          onClick={() => {
            pendingScrollTarget.current = 0;
            setVirtualBase(0);
          }}
          title="Jump to beginning of file"
        >
          <span className={styles.navArrow}>↑</span>
          <span className={styles.navMeta}>Line 1</span>
          <span className={styles.navLabel}>start of file</span>
          <span className={styles.navSpacer} />
        </button>
      )}
      {tailMode && !autoScroll && newLinesCount > 0 && (
        <button
          className={styles.newLinesBadge}
          onClick={resetAutoScroll}
        >
          {newLinesCount > 999 ? '999+' : newLinesCount} new line{newLinesCount !== 1 ? 's' : ''} below
        </button>
      )}
      <div
        ref={parentRef}
        className={styles.viewer}
        onPointerDown={(e) => {
          const { lineNum, col } = getLineColFromPointer(e.clientX, e.clientY);
          handlePointerDown(lineNum, col, e);
          if (e.altKey) {
            e.currentTarget.classList.add(styles.dragging);
            setCaret(null);
          } else if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            // Start caret tracking on plain left-click
            caretDragging.current = true;
            const pos = caretFromPointer(e.clientX, e.clientY);
            if (pos) setCaret(pos);
          }
        }}
        onPointerMove={(e) => {
          const { lineNum, col } = getLineColFromPointer(e.clientX, e.clientY);
          handlePointerMove(lineNum, col, e);
          // Update caret position during normal drag
          if (caretDragging.current && e.buttons === 1) {
            const pos = caretFromPointer(e.clientX, e.clientY);
            if (pos) setCaret(pos);
          }
        }}
        onPointerUp={(e) => {
          handlePointerUp();
          caretDragging.current = false;
          e.currentTarget.classList.remove(styles.dragging);
        }}
        onPointerCancel={(e) => {
          handlePointerUp();
          caretDragging.current = false;
          e.currentTarget.classList.remove(styles.dragging);
        }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            minWidth: '100%',
            width: 'max-content',
            position: 'relative',
          }}
        >
          {items.map((virtualItem) => {
            const actualLineNum = virtualBase + virtualItem.index;
            const line = dataSource.getLine(actualLineNum);
            const isTarget = scrollToLine != null && actualLineNum === scrollToLine;
            const isLineSelected =
              selection.mode !== 'box' && selection.selected.has(actualLineNum);
            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: virtualItem.start,
                  left: 0,
                  minWidth: '100%',
                  width: 'max-content',
                  height: virtualItem.size,
                }}
              >
                {line ? (
                  <TextLine
                    line={line}
                    lineHeight={LINE_HEIGHT}
                    gutterColumns={gutterColumns}
                    decorators={lineDecorators}
                    isSelected={isLineSelected}
                    isJumpTarget={isTarget}
                    jumpSeq={isTarget ? jumpSeq : undefined}
                    onClick={handleLineClick}
                    lineNumOverride={actualLineNum}
                  />
                ) : (
                  <TextLineSkeleton lineNum={actualLineNum} lineHeight={LINE_HEIGHT} />
                )}
              </div>
            );
          })}
          {selection.mode === 'box' && selection.box && selection.box.endCol > selection.box.startCol && (
            <div
              className={styles.boxOverlay}
              style={{
                position: 'absolute',
                top: (selection.box.startLine - virtualBase) * LINE_HEIGHT,
                height: (selection.box.endLine - selection.box.startLine + 1) * LINE_HEIGHT,
                left: gutterWidthRef.current + selection.box.startCol * charWidthRef.current,
                width: (selection.box.endCol - selection.box.startCol) * charWidthRef.current,
              }}
            />
          )}
          {caret && caret.line >= virtualBase && caret.line < virtualBase + effectiveCount && (
            <div
              className={styles.caret}
              style={{
                position: 'absolute',
                top: (caret.line - virtualBase) * LINE_HEIGHT,
                left: gutterWidth + caret.col * charWidthRef.current,
                height: LINE_HEIGHT,
              }}
            />
          )}
        </div>
      </div>
      {hasMoreBelow && (
        <button
          className={`${styles.navButton} ${styles.navBottom}`}
          onClick={() => {
            const newBase = virtualBase + MAX_VIRTUAL_LINES;
            pendingScrollTarget.current = newBase;
            setVirtualBase(newBase);
          }}
          title="Continue to next section of file"
        >
          <span className={styles.navSpacer} />
          <span className={styles.navLabel}>continue below</span>
          <span className={styles.navMeta}>Line {(virtualBase + MAX_VIRTUAL_LINES + 1).toLocaleString()}</span>
          <span className={styles.navArrow}>↓</span>
        </button>
      )}
    </div>
  );
}
