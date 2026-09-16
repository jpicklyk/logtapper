/** @jsxImportSource solid-js */
import { Index, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { DataSource } from '@viewport/DataSource';
import { buildCopyText, writeClipboard } from '@viewport/copyText';
import { absoluteLineToFilteredIndex } from '@logviewer/scrollMapping';
import { createCacheBinding } from './cacheBinding';
import { DEFAULT_PANE_ID } from './controller';
import type { ViewerController } from './controller';
import { createVirtualBase, DEFAULT_ROW_HEIGHT } from './virtualBase';
import { ScrollControls } from './scrollControls';
import { SelectionManager } from './selection';
import { installBench } from '@bench';
import { Row } from './Row';
import styles from './LogViewer.module.css';

/**
 * Virtualized log viewer — the Solid render layer over the P2 viewer core.
 *
 * Windowing is hand-rolled (no third-party virtualizer): `createCacheBinding`'s
 * `visibleRange` memo turns `(scrollTop, viewportHeight, rowHeight)` into
 * `{ start, end }` with `OVERSCAN` rows of margin, and `<Index>` renders exactly
 * that slice as absolutely positioned rows inside a spacer of
 * `renderCount × rowHeight` px. The binding owns that arithmetic outright, so
 * the rows drawn are by construction the rows fetched.
 *
 * `createVirtualBase`, `createCacheBinding` and `new ScrollControls(...)` are all
 * constructed in this component body, which is the owner their contract requires:
 * unmounting the viewer disposes the scheduler, detaches every listener, drops
 * the `onAppend` subscriptions and persists the scroll position.
 *
 * ## Coordinate systems
 *
 * This component is the **only** place the two line-number spaces meet, and the
 * conversion lives here on purpose:
 *
 *  - **Absolute** — a backend file line. Everything outside the viewer speaks
 *    this: `PaneHandle.jumpToLine` / `setSelection`, `controller.setCursor`,
 *    `onCursorChange`, and therefore every analyzer, search hit, bookmark,
 *    section, analysis, device-state transition and agent navigation.
 *  - **Rendered** — a row index in whatever the data source currently shows.
 *    `CacheDataSource.getLine(i)` indexes positionally into the active line set,
 *    so with a filter on, row 0 may be file line 61 234. `virtualBase`,
 *    `scrollTop / rowHeight`, `SelectionManager` and `Row`'s `data-line` are all
 *    rendered space (React keeps selection in rendered space too).
 *
 * `toRendered` / `toAbsolute` below are the border. `controller.lineNumbers(sid)`
 * is the mapping table; when it is `undefined` no line set is active and the two
 * spaces coincide, which is why dropping the conversion looked correct for so
 * long.
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
  /**
   * Notified after a row is clicked, with the **absolute backend line number**
   * (read-only — selection lives in the viewer).
   */
  onLineClick?: (lineNum: number) => void;
  /**
   * The app's `ViewerController`. When supplied, the viewer registers itself as
   * a pane, binds `sessionId` to it, resets its cache on `revision()` bumps and
   * reports its cursor back. Optional so tests can mount a bare viewer.
   */
  controller?: ViewerController;
  /** Which pane this viewer is. Defaults to the controller's `'main'`. */
  paneId?: string;
  /** Notified whenever the viewer's own cursor moves, in absolute line numbers. */
  onCursorChange?: (line: number) => void;
  /**
   * Notified when this pane gains pointer or keyboard focus — alongside the
   * matching `controller.focusPane(paneId)` call, so a split-pane host (S1)
   * can track which pane is "active" for its own UI (a `QueryBar`'s
   * shortcut-gating `active` prop, an outline) without polling the
   * controller.
   */
  onActivate?: () => void;
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

  // `--viewer-row-h` is a user setting written with
  // `document.documentElement.style.setProperty` (the same channel
  // `theme/applyTheme.ts` uses for its tokens). Nothing writes it at runtime
  // *yet*, but the spacer height, the window maths and every `Row`'s `--row-top`
  // are all derived from the value read at mount — so the first settings surface
  // that exposes it would desync all three until the viewer remounted. Watching
  // the one attribute it can arrive through costs one observer per pane.
  onMount(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(syncRowHeight);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    onCleanup(() => observer.disconnect());
  });

  // ── Viewer core (P2) ─────────────────────────────────────────────────────
  const dataSource = () => props.dataSource;
  const tailMode = () => props.tailMode;
  const totalLines = () => props.totalLineCount ?? props.dataSource.totalLines;

  // ── Absolute ↔ rendered mapping ──────────────────────────────────────────
  /** The active line set for this pane's session, or `undefined` when none is. */
  const lineSet = (): number[] | undefined => {
    const sid = props.sessionId;
    return sid != null ? props.controller?.lineNumbers(sid) : undefined;
  };

  /**
   * Absolute backend line → rendered row index. `null` when the line set is
   * empty (nothing is renderable, so there is nowhere to go). A line that is not
   * itself in the set resolves to the nearest row at or after it — the binary
   * search `src-next` already ships and unit-tests.
   */
  const toRendered = (absLine: number): number | null => {
    const ln = lineSet();
    if (!ln) return absLine;
    return absoluteLineToFilteredIndex(absLine, ln);
  };

  /**
   * Rendered row index → absolute backend line. The fetched `ViewLine` is the
   * cheapest source of truth (it carries the real `lineNum`); the line set is the
   * fallback for a row whose data has not resolved yet.
   */
  const toAbsolute = (rendered: number): number => {
    const resolved = props.dataSource.getLine(rendered);
    if (resolved) return resolved.lineNum;
    const ln = lineSet();
    return ln ? (ln[rendered] ?? rendered) : rendered;
  };

  const vb = createVirtualBase({
    sourceId: () => props.dataSource.sourceId,
    tailMode,
    rowHeight,
    sessionId: () => props.sessionId,
  });

  // `renderedLineCount` is React's `effectiveTotalLines`: with a line set active
  // it — not the stream total — is how many rows exist, in tail mode too.
  const scrollCtl = new ScrollControls({
    tailMode,
    totalLines,
    dataSource,
    renderedLineCount: () => lineSet()?.length,
  });

  const selection = new SelectionManager();

  // ── Benchmark harness (?bench=1) ─────────────────────────────────────────
  // Installed ahead of `createCacheBinding` so this effect runs before the
  // scheduler's first fetch — `firstPaintedRowMs` then measures fetch-to-paint.
  // Keyed on `props.sessionId` alone (review A-L9): the effect used to track
  // whatever it happened to read, so an unrelated signal could re-run the
  // install. `installBench` is a module singleton that only re-points its
  // `current`, so a re-run on a session switch is harmless, but the dependency
  // is now the one this code actually means.
  createEffect(
    on(
      () => props.sessionId,
      (sessionId) => {
        if (!location.search.includes('bench=1')) return;
        const bench = installBench({
          label: 'solid',
          getScrollEl: () => container ?? null,
          getTotalLines: () => scrollCtl.liveTotalLines(),
          rowHeight: () => rowHeight(),
          isReady: () => container?.querySelector('[data-line]:not([data-skeleton])') != null,
        });
        if (sessionId != null) bench.markLinePage();
      },
    ),
  );

  const binding = createCacheBinding({
    dataSource,
    scrollTop,
    viewportHeight,
    rowHeight,
    virtualBase: vb.virtualBase,
    maxVirtualLines: vb.maxVirtualLines,
    liveTotalLines: scrollCtl.liveTotalLines,
    // A line set / view mode / highlight change remaps what this source renders
    // without moving its `sourceId`, so the binding needs the same reset.
    revision: () => {
      const sid = props.sessionId;
      return sid != null ? (props.controller?.revision(sid) ?? 0) : 0;
    },
  });

  // ── Window maths ─────────────────────────────────────────────────────────
  // Sized from `liveTotalLines` (the stream total in tail mode, the prop count
  // in file mode) so the spacer and `createCacheBinding`'s reported range can
  // never disagree about how many rows exist.
  const renderCount = createMemo(() =>
    clamp(scrollCtl.liveTotalLines() - vb.virtualBase(), 0, vb.maxVirtualLines()),
  );

  const visibleRows = createMemo(() => Math.max(1, Math.floor(viewportHeight() / Math.max(1, rowHeight()))));

  // The rows rendered are exactly the rows the binding reports to the scheduler.
  // There used to be a second copy of this arithmetic here, clamped differently
  // (to `maxVirtualLines`, which the binding did not apply) — so the rows drawn
  // and the rows fetched could silently disagree. The binding now takes
  // `maxVirtualLines` and owns the maths alone.
  const windowIndices = createMemo<number[]>(() => {
    const range = binding.visibleRange();
    if (!range) return [];
    const out: number[] = new Array(range.end - range.start + 1);
    for (let i = 0; i < out.length; i++) out[i] = range.start + i;
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

  /**
   * Move the window if needed, then bring a **rendered** row index into view.
   * `virtualBase` and `pendingScrollTarget` are both rendered space.
   */
  const jumpToRendered = (rendered: number) => {
    const rel = rendered - vb.current.value;
    if (rel >= 0 && rel < vb.maxVirtualLines()) {
      vb.pendingScrollTarget.value = null;
      scrollRelIntoView(rel);
      return;
    }
    // Target is outside the current virtual window — rebase and defer.
    const newBase = Math.max(0, rendered - Math.floor(vb.maxVirtualLines() / 2));
    vb.pendingScrollTarget.value = rendered;
    vb.setVirtualBase(newBase);
  };

  /**
   * `PaneHandle.jumpToLine` — takes an **absolute backend line number** and maps
   * it through the active line set first. Without this, a "show matched lines"
   * jump to line 61 234 in a 40-row filtered view set `scrollTop` to ~1.35 M px,
   * which the browser clamps to 0: the jump silently did nothing.
   */
  const jumpToLine = (absLine: number) => {
    const rendered = toRendered(absLine);
    if (rendered == null) return; // empty line set — nothing is renderable
    jumpToRendered(rendered);
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

  // ── Viewer controller (W0a) ──────────────────────────────────────────────
  // The pane handle is this component's imperative surface: the controller is
  // the only thing allowed to drive it, and it is detached on unmount so a late
  // `scrollToLine` cannot reach a disposed viewer.
  const paneId = () => props.paneId ?? DEFAULT_PANE_ID;

  /** Pointer-down or native focus inside this pane makes it the controller's
   *  focus target — see `focusPane`'s doc comment for why this is on the
   *  controller and not left for a caller to infer from a ref. */
  const activatePane = (): void => {
    props.controller?.focusPane(paneId());
    props.onActivate?.();
  };

  onMount(() => {
    const controller = props.controller;
    if (!controller) return;
    onCleanup(
      controller.attachPane(paneId(), {
        jumpToLine,
        focus: () => container?.focus(),
        setSelection: (range) => {
          if (!range) {
            selection.clear();
            return;
          }
          // `range` is absolute; the selection set is rendered space (as React's
          // is), so both ends cross the border here.
          const start = toRendered(range[0]);
          const end = toRendered(range[1]);
          if (start == null || end == null) return;
          // Reuse the click path rather than adding a second range writer:
          // anchor on `start`, then shift-extend to `end`.
          selection.handleLineClick(start, { shiftKey: false, ctrlKey: false, metaKey: false });
          if (end !== start) {
            selection.handleLineClick(end, { shiftKey: true, ctrlKey: false, metaKey: false });
          }
        },
      }),
    );
  });

  createEffect(
    on(
      () => props.sessionId,
      (sessionId) => {
        if (sessionId != null) props.controller?.bindSession(sessionId, paneId());
      },
    ),
  );

  // Report the viewer's own cursor (click, arrow keys) back to the controller.
  // `cursorLine` is a rendered row; every consumer of `controller.cursor`
  // (bookmarks, device state, sections, analyses, the timeline strip) reads an
  // absolute file line — so the conversion happens here, at the boundary.
  createEffect(
    on(cursorLine, (line) => {
      if (line == null) return;
      const absolute = toAbsolute(line);
      const sid = props.sessionId;
      if (sid != null) props.controller?.setCursor(sid, absolute);
      props.onCursorChange?.(absolute);
    }),
  );

  /** Controller highlight overlay for the session on screen. */
  const controllerHighlights = createMemo(() => {
    const sid = props.sessionId;
    return sid != null ? (props.controller?.highlights(sid) ?? null) : null;
  });

  // ── Keyboard navigation ──────────────────────────────────────────────────
  const moveCursor = (target: number, shiftKey: boolean) => {
    const total = scrollCtl.liveTotalLines();
    if (total === 0) return;
    const next = clamp(target, 0, total - 1);
    batch(() => {
      setCursorLine(next);
      selection.handleLineClick(next, { shiftKey, ctrlKey: false, metaKey: false });
    });
    jumpToRendered(next);
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
    // `lineNum` is the rendered row; the prop is documented as a line number and
    // its only consumers are outside the viewer, so it gets the absolute one.
    props.onLineClick?.(toAbsolute(lineNum));
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
        onFocusIn={activatePane}
        onPointerDown={(e) => {
          activatePane();
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
                controllerHighlights={controllerHighlights()}
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
