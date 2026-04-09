import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DataSource } from './DataSource';
import type { GutterColumnDef } from './GutterColumn';
import type { LineDecoratorDef } from './LineDecorator';
import type { Selection } from './SelectionManager';
import { useSelectionManager } from './SelectionManager';
import { buildCopyText } from './copyText';
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
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const parentCallbackRef = useCallback((el: HTMLDivElement | null) => {
    parentRef.current = el;
    setScrollContainer(el);
  }, []);
  const charWidthRef = useRef(7.2);
  const gutterWidthRef = useRef(0);

  // ── Caret position (imperative to avoid re-renders during drag) ─────────
  // Positioned via direct DOM style writes — no React state, no reconciliation
  // overhead at 60-120 Hz pointer move frequency.
  const caretRef = useRef<{ line: number; col: number } | null>(null);
  const caretDivRef = useRef<HTMLDivElement>(null);
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

  // ── Imperative caret positioning ───────────────────────────────────────
  const updateCaretDom = useCallback((pos: { line: number; col: number } | null) => {
    caretRef.current = pos;
    const el = caretDivRef.current;
    if (!el) return;
    if (!pos) {
      el.style.display = 'none';
      return;
    }
    const vb = virtualBaseRef.current;
    const relLine = pos.line - vb;
    // Hide if outside the current virtual window
    if (relLine < 0 || relLine >= MAX_VIRTUAL_LINES) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.top = `${relLine * LINE_HEIGHT}px`;
    el.style.left = `${gutterWidthRef.current + pos.col * charWidthRef.current}px`;
  }, []);

  // ── Scroll controls ──────────────────────────────────────────────────────
  const {
    autoScroll,
    autoScrollRef,
    newLinesCount,
    liveTotalLines,
    resetAutoScroll,
    disableAutoScroll,
  } = useScrollControls(scrollContainer, tailMode, totalLines, dataSource, bumpCacheVersion);

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
    updateCaretDom(null);
  }, [dataSource.sourceId, clearSelection, updateCaretDom]);

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
  //
  // Deferred to rAF so queued input events (wheel-up, key-up) can set
  // autoScrollRef=false before the scroll executes. Without this, a pending
  // effect from a just-arrived batch overrides the user's scroll-away.
  useEffect(() => {
    if (!tailMode || !autoScrollRef.current || liveEffectiveCount === 0) return;
    const el = parentRef.current;
    if (!el) return;

    requestAnimationFrame(() => {
      if (!autoScrollRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
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
      const text = buildCopyText(selection, (n) => dataSource.getLine(n)?.raw);
      if (text != null) writeClipboard(text);
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

  // Reposition caret when virtualBase shifts (large-file navigation).
  useEffect(() => {
    updateCaretDom(caretRef.current);
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
        updateCaretDom(null);
      }
    },
    [selHandleLineClick, onLineClick, updateCaretDom],
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
        ref={parentCallbackRef}
        className={styles.viewer}
        onPointerDown={(e) => {
          const { lineNum, col } = getLineColFromPointer(e.clientX, e.clientY);
          handlePointerDown(lineNum, col, e);
          if (e.altKey) {
            e.currentTarget.classList.add(styles.dragging);
            updateCaretDom(null);
          } else if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            // Start caret tracking on plain left-click
            caretDragging.current = true;
            updateCaretDom(caretFromPointer(e.clientX, e.clientY));
          }
        }}
        onPointerMove={(e) => {
          const { lineNum, col } = getLineColFromPointer(e.clientX, e.clientY);
          handlePointerMove(lineNum, col, e);
          // Update caret position during normal drag
          if (caretDragging.current && e.buttons === 1) {
            updateCaretDom(caretFromPointer(e.clientX, e.clientY));
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
          <div
            ref={caretDivRef}
            className={styles.caret}
            style={{
              position: 'absolute',
              display: 'none',
              height: LINE_HEIGHT,
            }}
          />
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
