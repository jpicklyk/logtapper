/** @jsxImportSource solid-js */
import { Index, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { DataSource } from '@viewport/DataSource';
import { buildCopyText, writeClipboard } from '@viewport/copyText';
import { createCacheBinding, OVERSCAN } from './cacheBinding';
import { createVirtualBase, DEFAULT_ROW_HEIGHT } from './virtualBase';
import { ScrollControls } from './scrollControls';
import { SelectionManager } from './selection';
import { installBench } from '@bench';
import { Row } from './Row';
import styles from './LogViewer.module.css';

/**
 * Virtualized log viewer — the Solid render layer over the P2 viewer core.
 *
 * Windowing is hand-rolled (no third-party virtualizer): a `createMemo` over
 * `(scrollTop, viewportHeight, rowHeight)` produces `{ start, end }` with
 * `OVERSCAN` rows of margin, and `<Index>` renders that slice as absolutely
 * positioned rows inside a spacer of `renderCount × rowHeight` px.
 *
 * `createVirtualBase`, `createCacheBinding` and `new ScrollControls(...)` are all
 * constructed in this component body, which is the owner their contract requires:
 * unmounting the viewer disposes the scheduler, detaches every listener, drops
 * the `onAppend` subscriptions and persists the scroll position.
 */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Row height comes from the `--viewer-row-h` custom property on `<html>` (a user
 * setting, not a theme value). Read once at mount and whenever `rowHeight` changes.
 */
function readRowHeight(): number {
  if (typeof document === 'undefined') return DEFAULT_ROW_HEIGHT;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--viewer-row-h').trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ROW_HEIGHT;
}

export interface LogViewerProps {
  dataSource: DataSource;
  /** Authoritative line count for file mode. Defaults to `dataSource.totalLines`. */
  totalLineCount?: number;
  /** Session id — enables scroll-position persistence across session switches. */
  sessionId?: string;
  /** Streaming tail mode: pins the window to line 0 and auto-scrolls to bottom. */
  tailMode?: boolean;
  /** Override the measured `--viewer-row-h`. */
  rowHeight?: number;
  /** Notified after a row is clicked (read-only — selection lives in the viewer). */
  onLineClick?: (lineNum: number) => void;
  class?: string;
}

export function LogViewer(props: LogViewerProps) {
  let container: HTMLDivElement | undefined;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [rowHeight, setRowHeight] = createSignal(DEFAULT_ROW_HEIGHT);
  const [cursorLine, setCursorLine] = createSignal<number | null>(null);

  const syncRowHeight = () => setRowHeight(props.rowHeight ?? readRowHeight());
  onMount(syncRowHeight);
  createEffect(on(() => props.rowHeight, syncRowHeight, { defer: true }));

  // ── Viewer core (P2) ─────────────────────────────────────────────────────
  const dataSource = () => props.dataSource;
  const tailMode = () => props.tailMode;
  const totalLines = () => props.totalLineCount ?? props.dataSource.totalLines;

  const vb = createVirtualBase({
    sourceId: () => props.dataSource.sourceId,
    tailMode,
    rowHeight,
    sessionId: () => props.sessionId,
  });

  const scrollCtl = new ScrollControls({ tailMode, totalLines, dataSource });

  const selection = new SelectionManager();

  // ── Benchmark harness (?bench=1) ─────────────────────────────────────────
  // Installed ahead of `createCacheBinding` so this effect runs before the
  // scheduler's first fetch — `firstPaintedRowMs` then measures fetch-to-paint.
  createEffect(() => {
    if (!location.search.includes('bench=1')) return;
    const bench = installBench({
      label: 'solid',
      getScrollEl: () => container ?? null,
      getTotalLines: () => scrollCtl.liveTotalLines(),
      rowHeight: () => rowHeight(),
      isReady: () => container?.querySelector('[data-line]:not([data-skeleton])') != null,
    });
    if (props.sessionId != null) bench.markLinePage();
  });

  const binding = createCacheBinding({
    dataSource,
    scrollTop,
    viewportHeight,
    rowHeight,
    virtualBase: vb.virtualBase,
    liveTotalLines: scrollCtl.liveTotalLines,
  });

  // ── Window maths ─────────────────────────────────────────────────────────
  // Sized from `liveTotalLines` (the stream total in tail mode, the prop count
  // in file mode) so the spacer and `createCacheBinding`'s reported range can
  // never disagree about how many rows exist.
  const renderCount = createMemo(() =>
    clamp(scrollCtl.liveTotalLines() - vb.virtualBase(), 0, vb.maxVirtualLines()),
  );

  const visibleRows = createMemo(() => Math.max(1, Math.floor(viewportHeight() / Math.max(1, rowHeight()))));

  const windowIndices = createMemo<number[]>(() => {
    const rh = Math.max(1, rowHeight());
    const count = renderCount();
    const h = viewportHeight();
    if (count === 0 || h <= 0) return [];
    const top = Math.max(0, scrollTop());
    const start = Math.max(0, Math.floor(top / rh) - OVERSCAN);
    const end = Math.min(count - 1, Math.ceil((top + h) / rh) - 1 + OVERSCAN);
    if (end < start) return [];
    const out: number[] = new Array(end - start + 1);
    for (let i = 0; i < out.length; i++) out[i] = start + i;
    return out;
  });

  // ── Container measurement ────────────────────────────────────────────────
  const measure = () => {
    if (container) setViewportHeight(container.clientHeight);
  };

  onMount(() => {
    const el = container;
    if (!el) return;
    scrollCtl.attach(el);
    measure();

    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => el.removeEventListener('scroll', onScroll));

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    } else {
      window.addEventListener('resize', measure);
      onCleanup(() => window.removeEventListener('resize', measure));
    }
  });

  // ── Clear selection + cursor when the data source changes ────────────────
  createEffect(
    on(
      () => props.dataSource.sourceId,
      () => {
        selection.clear();
        setCursorLine(null);
      },
      { defer: true },
    ),
  );

  // ── Tail-mode auto-scroll: at most one rAF write per frame ───────────────
  // The frame does the append commit *and* the follow scroll, so the target is
  // derived from the spacer geometry this component already owns
  // (`renderCount × rowHeight`) instead of read back off the element:
  // `el.scrollHeight` here is a forced synchronous layout of the tree the
  // append just dirtied, and profiling a 60 s stream attributed 620 ms of
  // main-thread time to that single read. An over-large `scrollTop` write is
  // clamped by the browser, so no read is needed to stay pinned. Order matters:
  // the `scrollTop` signal is published first so the rows move in the same
  // frame, and the element write that follows pays for one layout covering
  // both — rather than the scroll event driving a second render pass later.
  let rafId: number | null = null;
  onCleanup(() => {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  });

  createEffect(
    on(renderCount, (count) => {
      if (!props.tailMode || !scrollCtl.autoScrollRef.value || count === 0) return;
      const el = container;
      if (!el || rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!scrollCtl.autoScrollRef.value) return;
        const contentHeight = renderCount() * rowHeight();
        setScrollTop(Math.max(0, contentHeight - viewportHeight()));
        el.scrollTop = contentHeight;
      });
    }),
  );

  // ── Scrolling / jumping ──────────────────────────────────────────────────
  const scrollRelIntoView = (rel: number, center = false) => {
    const el = container;
    if (!el) return;
    const rh = Math.max(1, rowHeight());
    const top = rel * rh;
    if (center) {
      el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 2) + Math.floor(rh / 2));
    } else if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + rh > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + rh - el.clientHeight;
    }
    setScrollTop(el.scrollTop);
  };

  /** Move the window if needed, then bring `absLine` into view. */
  const jumpToLine = (absLine: number) => {
    const rel = absLine - vb.current.value;
    if (rel >= 0 && rel < vb.maxVirtualLines()) {
      vb.pendingScrollTarget.value = null;
      scrollRelIntoView(rel);
      return;
    }
    // Target is outside the current virtual window — rebase and defer.
    const newBase = Math.max(0, absLine - Math.floor(vb.maxVirtualLines() / 2));
    vb.pendingScrollTarget.value = absLine;
    vb.setVirtualBase(newBase);
  };

  // Consume the deferred scroll target after a rebase.
  createEffect(
    on(vb.virtualBase, () => {
      const target = vb.pendingScrollTarget.value;
      if (target == null) return;
      const rel = target - vb.current.value;
      if (rel < 0 || rel >= vb.maxVirtualLines()) return;
      vb.pendingScrollTarget.value = null;
      scrollRelIntoView(rel, true);
      binding.forceFetch();
    }),
  );

  // ── Keyboard navigation ──────────────────────────────────────────────────
  const moveCursor = (target: number, shiftKey: boolean) => {
    const total = scrollCtl.liveTotalLines();
    if (total === 0) return;
    const next = clamp(target, 0, total - 1);
    batch(() => {
      setCursorLine(next);
      selection.handleLineClick(next, { shiftKey, ctrlKey: false, metaKey: false });
    });
    jumpToLine(next);
  };

  /** First line currently under the top edge of the viewport. */
  const firstVisibleLine = () =>
    vb.current.value + Math.floor(Math.max(0, scrollTop()) / Math.max(1, rowHeight()));

  const RELATIVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']);

  const onKeyDown = (e: KeyboardEvent) => {
    const cur = cursorLine();
    // First relative move with no cursor yet parks it on the top visible line
    // rather than stepping off an invisible one.
    if (cur == null && RELATIVE_KEYS.has(e.key)) {
      moveCursor(firstVisibleLine(), e.shiftKey);
      e.preventDefault();
      return;
    }
    const from = cur ?? firstVisibleLine();
    const page = Math.max(1, visibleRows() - 1);
    switch (e.key) {
      case 'ArrowUp': moveCursor(from - 1, e.shiftKey); break;
      case 'ArrowDown': moveCursor(from + 1, e.shiftKey); break;
      case 'PageUp': moveCursor(from - page, e.shiftKey); break;
      case 'PageDown': moveCursor(from + page, e.shiftKey); break;
      case 'Home': moveCursor(0, e.shiftKey); break;
      case 'End': moveCursor(scrollCtl.liveTotalLines() - 1, e.shiftKey); break;
      default: return;
    }
    e.preventDefault();
  };

  // ── Ctrl+C copy + Alt box-select cursor (window-level, as in React) ──────
  onMount(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        container?.classList.add(styles.altMode);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
      const sel = selection.selection;
      const has = sel.mode === 'box' ? sel.box != null : sel.selected.size > 0;
      if (!has) return;
      // A native text selection inside a line means the user dragged to select
      // text — let the browser own that copy.
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      // Read the source once here — `buildCopyText` calls the getter
      // synchronously, so it never outlives this handler.
      const src = props.dataSource;
      const text = buildCopyText(sel, (n) => src.getLine(n)?.raw);
      if (text != null) writeClipboard(text);
    };
    const onWindowKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') container?.classList.remove(styles.altMode);
    };
    window.addEventListener('keydown', onWindowKeyDown);
    window.addEventListener('keyup', onWindowKeyUp);
    onCleanup(() => {
      window.removeEventListener('keydown', onWindowKeyDown);
      window.removeEventListener('keyup', onWindowKeyUp);
    });
  });

  // ── Pointer → (line, col) for box selection ──────────────────────────────
  const lineColFromPointer = (clientX: number, clientY: number) => {
    const el = container;
    if (!el) return { lineNum: 0, col: 0 };
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop;
    const rh = Math.max(1, rowHeight());
    return {
      lineNum: vb.current.value + Math.max(0, Math.floor(y / rh)),
      col: Math.max(0, Math.floor(clientX - rect.left)),
    };
  };

  const handleLineClick = (lineNum: number, e: MouseEvent) => {
    if (e.altKey) return;
    batch(() => {
      selection.handleLineClick(lineNum, e);
      setCursorLine(lineNum);
    });
    props.onLineClick?.(lineNum);
  };

  const spacerStyle = (): JSX.CSSProperties =>
    ({
      '--spacer-h': `${renderCount() * rowHeight()}px`,
      '--row-h': `${rowHeight()}px`,
    }) as JSX.CSSProperties;

  return (
    <div class={props.class ? `${styles.wrapper} ${props.class}` : styles.wrapper}>
      <Show when={props.tailMode && !scrollCtl.autoScroll() && scrollCtl.newLinesCount() > 0}>
        <button
          type="button"
          class={styles.newLinesBadge}
          onClick={() => scrollCtl.resetAutoScroll()}
        >
          {scrollCtl.newLinesCount() > 999 ? '999+' : scrollCtl.newLinesCount()} new line
          {scrollCtl.newLinesCount() === 1 ? '' : 's'} below
        </button>
      </Show>
      <div
        ref={container}
        class={styles.viewer}
        tabindex={0}
        role="grid"
        aria-label="Log lines"
        aria-rowcount={scrollCtl.liveTotalLines()}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          const { lineNum, col } = lineColFromPointer(e.clientX, e.clientY);
          selection.handlePointerDown(lineNum, col, e);
        }}
        onPointerMove={(e) => {
          if (!selection.isBoxDragging) return;
          const { lineNum, col } = lineColFromPointer(e.clientX, e.clientY);
          selection.handlePointerMove(lineNum, col);
        }}
        onPointerUp={() => selection.handlePointerUp()}
        onPointerCancel={() => selection.handlePointerUp()}
      >
        <div class={styles.spacer} style={spacerStyle()}>
          <Index each={windowIndices()}>
            {(relIndex) => (
              <Row
                index={relIndex()}
                virtualBase={vb.virtualBase()}
                rowHeight={rowHeight()}
                cacheVersion={binding.cacheVersion()}
                dataSource={props.dataSource}
                selected={
                  selection.selection.mode !== 'box' &&
                  selection.selection.selected.has(vb.virtualBase() + relIndex())
                }
                active={cursorLine() === vb.virtualBase() + relIndex()}
                onLineClick={handleLineClick}
              />
            )}
          </Index>
        </div>
      </div>
    </div>
  );
}
