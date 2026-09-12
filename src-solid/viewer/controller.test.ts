// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createComputed, createRoot } from 'solid-js';
import { createViewerController, intersectSorted, DEFAULT_PANE_ID } from './controller';
import type { PaneHandle, ViewerController } from './controller';
import type { HighlightSpan } from '@bridge/generated/HighlightSpan';

const SID = 'session-a';

function makePane() {
  const handle: PaneHandle = {
    jumpToLine: vi.fn(),
    focus: vi.fn(),
    setSelection: vi.fn(),
  };
  return handle as PaneHandle & {
    jumpToLine: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    setSelection: ReturnType<typeof vi.fn>;
  };
}

function build(focusSession = vi.fn()) {
  const controller = createViewerController({ focusSession });
  return { controller, focusSession };
}

const span = (start: number, end: number): HighlightSpan => ({
  start,
  end,
  kind: { type: 'Search' },
});

describe('intersectSorted', () => {
  it('returns [] for no lists and a copy for one', () => {
    expect(intersectSorted([])).toEqual([]);
    const only = [1, 4, 9];
    const out = intersectSorted([only]);
    expect(out).toEqual([1, 4, 9]);
    expect(out).not.toBe(only);
  });

  it('intersects two and three ascending lists', () => {
    expect(intersectSorted([[1, 2, 3, 5, 8], [2, 3, 8, 13]])).toEqual([2, 3, 8]);
    expect(intersectSorted([[1, 2, 3, 5, 8], [2, 3, 8, 13], [3, 8, 21]])).toEqual([3, 8]);
  });

  it('returns [] when the lists are disjoint', () => {
    expect(intersectSorted([[1, 3, 5], [2, 4, 6]])).toEqual([]);
    expect(intersectSorted([[1, 2, 3], [1, 2, 3], []])).toEqual([]);
  });

  it('matches a naive Set reference on random inputs', () => {
    const naive = (lists: number[][]): number[] => {
      if (lists.length === 0) return [];
      const sets = lists.map((l) => new Set(l));
      return [...sets[0]].filter((n) => sets.every((s) => s.has(n))).sort((a, b) => a - b);
    };
    // Deterministic LCG — a fixed seed keeps a failure reproducible.
    let seed = 0x2f6e2b1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let trial = 0; trial < 200; trial++) {
      const count = 1 + Math.floor(rnd() * 3);
      const lists: number[][] = [];
      for (let i = 0; i < count; i++) {
        const s = new Set<number>();
        const size = Math.floor(rnd() * 40);
        for (let k = 0; k < size; k++) s.add(Math.floor(rnd() * 60));
        lists.push([...s].sort((a, b) => a - b));
      }
      expect(intersectSorted(lists)).toEqual(naive(lists));
    }
  });
});

describe('createViewerController — line sets', () => {
  it('is undefined while all three sets are null, and again after they are cleared', () => {
    const { controller } = build();
    expect(controller.lineNumbers(SID)).toBeUndefined();

    controller.setLineSet(SID, 'filter', new Set([3, 1]));
    expect(controller.lineNumbers(SID)).toEqual([1, 3]);

    controller.setLineSet(SID, 'filter', null);
    expect(controller.lineNumbers(SID)).toBeUndefined();
    controller.dispose();
  });

  it('intersects the sets that are present, ascending', () => {
    const { controller } = build();
    controller.setLineSet(SID, 'section', new Set([9, 1, 5, 3]));
    expect(controller.lineNumbers(SID)).toEqual([1, 3, 5, 9]);

    controller.setLineSet(SID, 'filter', new Set([5, 3, 11]));
    expect(controller.lineNumbers(SID)).toEqual([3, 5]);

    controller.setLineSet(SID, 'search', new Set([5]));
    expect(controller.lineNumbers(SID)).toEqual([5]);
    controller.dispose();
  });

  it('returns [] — not undefined — for an empty intersection', () => {
    const { controller } = build();
    controller.setLineSet(SID, 'section', new Set([1, 2]));
    controller.setLineSet(SID, 'filter', new Set([3, 4]));
    expect(controller.lineNumbers(SID)).toEqual([]);
    controller.dispose();
  });

  it('keeps sessions independent', () => {
    const { controller } = build();
    controller.setLineSet(SID, 'filter', new Set([1, 2]));
    expect(controller.lineNumbers('other')).toBeUndefined();
    controller.dispose();
  });

  it('memoises: the same array instance survives unrelated setters', () => {
    const { controller } = build();
    controller.setLineSet(SID, 'filter', new Set([2, 1]));
    const first = controller.lineNumbers(SID);
    expect(first).toEqual([1, 2]);

    controller.setHighlights(SID, new Map());
    controller.setViewMode(SID, { mode: 'Processor' });
    expect(controller.lineNumbers(SID)).toBe(first);

    controller.setLineSet(SID, 'section', new Set([1]));
    expect(controller.lineNumbers(SID)).not.toBe(first);
    expect(controller.lineNumbers(SID)).toEqual([1]);
    controller.dispose();
  });
});

describe('createViewerController — view mode, highlights, revision', () => {
  it('defaults to Full view mode', () => {
    const { controller } = build();
    expect(controller.viewMode(SID)).toEqual({ mode: 'Full' });
    controller.setViewMode(SID, { mode: 'Focus', center: 12 });
    expect(controller.viewMode(SID)).toEqual({ mode: 'Focus', center: 12 });
    controller.dispose();
  });

  it('stores and clears the highlight map', () => {
    const { controller } = build();
    expect(controller.highlights(SID)).toBeNull();
    const map = new Map([[4, [span(0, 3)]]]);
    controller.setHighlights(SID, map);
    expect(controller.highlights(SID)).toBe(map);
    controller.setHighlights(SID, null);
    expect(controller.highlights(SID)).toBeNull();
    controller.dispose();
  });

  it('bumps revision on every setter and on no read', () => {
    const { controller } = build();
    expect(controller.revision(SID)).toBe(0);

    controller.setViewMode(SID, { mode: 'Processor' });
    expect(controller.revision(SID)).toBe(1);

    controller.setLineSet(SID, 'filter', new Set([1]));
    expect(controller.revision(SID)).toBe(2);

    controller.setLineSet(SID, 'filter', null);
    expect(controller.revision(SID)).toBe(3);

    controller.setHighlights(SID, new Map());
    expect(controller.revision(SID)).toBe(4);

    controller.viewMode(SID);
    controller.lineNumbers(SID);
    controller.highlights(SID);
    controller.paneForSession(SID);
    expect(controller.revision(SID)).toBe(4);

    // Per session, not global.
    expect(controller.revision('other')).toBe(0);
    controller.dispose();
  });

  it('drives a reactive consumer of revision()', () => {
    createRoot((dispose) => {
      const controller = createViewerController({ focusSession: vi.fn() });
      const seen: number[] = [];
      createComputed(() => { seen.push(controller.revision(SID)); });

      controller.setLineSet(SID, 'search', new Set([7]));
      controller.setHighlights(SID, new Map());

      expect(seen).toEqual([0, 1, 2]);
      controller.dispose();
      dispose();
    });
  });
});

describe('createViewerController — pane routing', () => {
  it('defaults every session to the main pane', () => {
    const { controller } = build();
    expect(controller.paneForSession(SID)).toBe(DEFAULT_PANE_ID);
    controller.dispose();
  });

  it('focuses the session before jumping when the pane holds another one', () => {
    const { controller, focusSession } = build();
    const pane = makePane();
    controller.attachPane(DEFAULT_PANE_ID, pane);
    controller.bindSession('other', DEFAULT_PANE_ID);

    const order: string[] = [];
    focusSession.mockImplementation(() => order.push('focus'));
    pane.jumpToLine.mockImplementation(() => order.push('jump'));

    controller.scrollToLine(SID, 42);

    expect(order).toEqual(['focus', 'jump']);
    expect(focusSession).toHaveBeenCalledWith(SID);
    expect(pane.jumpToLine).toHaveBeenCalledWith(42);
    controller.dispose();
  });

  it('does not re-focus a session already bound to its pane', () => {
    const { controller, focusSession } = build();
    const pane = makePane();
    controller.attachPane(DEFAULT_PANE_ID, pane);
    controller.bindSession(SID, DEFAULT_PANE_ID);

    controller.scrollToLine(SID, 7);

    expect(focusSession).not.toHaveBeenCalled();
    expect(pane.jumpToLine).toHaveBeenCalledWith(7);
    controller.dispose();
  });

  it('routes to the pane the session is bound to, not the default', () => {
    const { controller } = build();
    const main = makePane();
    const side = makePane();
    controller.attachPane(DEFAULT_PANE_ID, main);
    controller.attachPane('side', side);
    controller.bindSession(SID, 'side');

    expect(controller.paneForSession(SID)).toBe('side');
    controller.scrollToLine(SID, 3);

    expect(side.jumpToLine).toHaveBeenCalledWith(3);
    expect(main.jumpToLine).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('moves a session between panes, leaving only the new binding', () => {
    const { controller } = build();
    controller.bindSession(SID, DEFAULT_PANE_ID);
    controller.bindSession(SID, 'side');

    expect(controller.paneForSession(SID)).toBe('side');
    // The old pane no longer claims the session, so a jump there re-focuses.
    const main = makePane();
    controller.attachPane(DEFAULT_PANE_ID, main);
    controller.bindSession('other', DEFAULT_PANE_ID);
    expect(controller.paneForSession('other')).toBe(DEFAULT_PANE_ID);
    controller.dispose();
  });

  it('passes an explicit selection range to the pane', () => {
    const { controller } = build();
    const pane = makePane();
    controller.attachPane(DEFAULT_PANE_ID, pane);
    controller.bindSession(SID, DEFAULT_PANE_ID);

    controller.scrollToLine(SID, 10, { select: [10, 14] });
    expect(pane.setSelection).toHaveBeenCalledWith([10, 14]);

    pane.setSelection.mockClear();
    controller.scrollToLine(SID, 10);
    expect(pane.setSelection).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('still records the cursor when no pane is attached', () => {
    const { controller, focusSession } = build();
    controller.scrollToLine(SID, 5, { source: 'agent' });
    expect(focusSession).toHaveBeenCalledWith(SID);
    expect(controller.cursor()).toMatchObject({ sessionId: SID, line: 5, source: 'agent' });
    controller.dispose();
  });

  it('focus() drives the active pane', () => {
    const { controller } = build();
    const main = makePane();
    const side = makePane();
    controller.attachPane(DEFAULT_PANE_ID, main);
    controller.attachPane('side', side);

    controller.bindSession(SID, DEFAULT_PANE_ID);
    controller.focus();
    expect(main.focus).toHaveBeenCalledTimes(1);
    expect(side.focus).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('detaches the handle on unmount and ignores a stale detach', () => {
    const { controller } = build();
    const first = makePane();
    const detach = controller.attachPane(DEFAULT_PANE_ID, first);
    controller.bindSession(SID, DEFAULT_PANE_ID);

    detach();
    controller.scrollToLine(SID, 1);
    expect(first.jumpToLine).not.toHaveBeenCalled();

    // A remount replaces the handle; the old detach must not remove the new one.
    const second = makePane();
    controller.attachPane(DEFAULT_PANE_ID, second);
    detach();
    controller.scrollToLine(SID, 2);
    expect(second.jumpToLine).toHaveBeenCalledWith(2);
    controller.dispose();
  });
});

describe('createViewerController — cursor', () => {
  it('starts null and records scrollToLine and setCursor', () => {
    const { controller } = build();
    expect(controller.cursor()).toBeNull();

    controller.setCursor(SID, 3);
    expect(controller.cursor()).toEqual({ sessionId: SID, line: 3 });

    controller.scrollToLine(SID, 9, { source: 'analysis', highlight: true });
    expect(controller.cursor()).toEqual({
      sessionId: SID,
      line: 9,
      source: 'analysis',
      highlight: true,
    });
    controller.dispose();
  });

  it('notifies subscribers until they unsubscribe', () => {
    const { controller } = build();
    const seen: unknown[] = [];
    const off = controller.onCursorChange((c) => seen.push(c));

    controller.setCursor(SID, 1);
    controller.scrollToLine(SID, 2, { source: 'search' });
    off();
    controller.setCursor(SID, 3);

    expect(seen).toEqual([
      { sessionId: SID, line: 1 },
      { sessionId: SID, line: 2, source: 'search' },
    ]);
    controller.dispose();
  });
});

describe('createViewerController — dispose', () => {
  it('drops panes, bindings and cursor listeners, and is idempotent', () => {
    const { controller, focusSession } = build();
    const pane = makePane();
    controller.attachPane(DEFAULT_PANE_ID, pane);
    controller.bindSession(SID, DEFAULT_PANE_ID);
    const seen: unknown[] = [];
    controller.onCursorChange((c) => seen.push(c));

    controller.dispose();
    controller.dispose();

    controller.scrollToLine(SID, 1);
    expect(pane.jumpToLine).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0); // the listener set was cleared
    expect(focusSession).toHaveBeenCalledTimes(1); // binding gone ⇒ focus attempted
  });
});

describe('the frozen surface', () => {
  it('exposes every member downstream packages code against', () => {
    const { controller } = build();
    const keys: (keyof ViewerController)[] = [
      'scrollToLine', 'setViewMode', 'viewMode', 'setLineSet', 'lineNumbers',
      'setHighlights', 'highlights', 'revision', 'cursor', 'onCursorChange',
      'setCursor', 'focus', 'attachPane', 'bindSession', 'paneForSession', 'dispose',
    ];
    for (const key of keys) expect(typeof controller[key]).toBe('function');
    controller.dispose();
  });
});
