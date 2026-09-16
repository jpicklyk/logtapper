// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createRoot, createEffect } from 'solid-js';
import { SelectionManager } from './selection';
import type { BoxPointerEvent } from './selection';
import { buildCopyText } from '@viewport/copyText';

const click = (o: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
  shiftKey: false, ctrlKey: false, metaKey: false, ...o,
});

interface CaptureSpies {
  setPointerCapture: ReturnType<typeof vi.fn>;
  releasePointerCapture: ReturnType<typeof vi.fn>;
  hasPointerCapture: ReturnType<typeof vi.fn>;
}

function boxEvent(alt = true): BoxPointerEvent & CaptureSpies {
  const captured = new Set<number>();
  const setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  const releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
  const hasPointerCapture = vi.fn((id: number) => captured.has(id));
  const target = {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture,
  } as unknown as EventTarget;
  return {
    altKey: alt,
    pointerId: 7,
    currentTarget: target,
    preventDefault: vi.fn(),
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture,
  };
}

const lines = (sel: { selected: Set<number> }) => Array.from(sel.selected).sort((a, b) => a - b);

describe('SelectionManager', () => {
  it('starts empty in line mode', () => {
    const sm = new SelectionManager();
    expect(sm.selection.anchor).toBeNull();
    expect(sm.selection.selected.size).toBe(0);
    expect(sm.selection.mode).toBe('line');
    expect(sm.selection.box).toBeUndefined();
  });

  // ── Line mode ────────────────────────────────────────────────────────────

  describe('line mode', () => {
    it('plain click selects a single line and sets the anchor', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(10, click());
      expect(sm.selection.anchor).toBe(10);
      expect(lines(sm.selection)).toEqual([10]);
    });

    it('plain click replaces the previous selection', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(10, click());
      sm.handleLineClick(20, click());
      expect(lines(sm.selection)).toEqual([20]);
      expect(sm.selection.anchor).toBe(20);
    });

    it('shift+click selects the range forward from the anchor', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(3, click());
      sm.handleLineClick(6, click({ shiftKey: true }));
      expect(lines(sm.selection)).toEqual([3, 4, 5, 6]);
      expect(sm.selection.anchor).toBe(3); // anchor is preserved
    });

    it('shift+click selects the range backward from the anchor', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(6, click());
      sm.handleLineClick(3, click({ shiftKey: true }));
      expect(lines(sm.selection)).toEqual([3, 4, 5, 6]);
      expect(sm.selection.anchor).toBe(6);
    });

    it('shift+click with no anchor falls back to a single select', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(5, click({ shiftKey: true }));
      expect(lines(sm.selection)).toEqual([5]);
      expect(sm.selection.anchor).toBe(5);
    });

    it('ctrl+click adds a line and moves the anchor', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(1, click());
      sm.handleLineClick(4, click({ ctrlKey: true }));
      expect(lines(sm.selection)).toEqual([1, 4]);
      expect(sm.selection.anchor).toBe(4);
    });

    it('ctrl+click toggles an already-selected line off', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(1, click());
      sm.handleLineClick(4, click({ ctrlKey: true }));
      sm.handleLineClick(4, click({ ctrlKey: true }));
      expect(lines(sm.selection)).toEqual([1]);
    });

    it('meta+click behaves like ctrl+click', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(1, click());
      sm.handleLineClick(2, click({ metaKey: true }));
      expect(lines(sm.selection)).toEqual([1, 2]);
    });
  });

  // ── Box mode ─────────────────────────────────────────────────────────────

  describe('box mode', () => {
    it('alt+pointerdown starts a degenerate box and captures the pointer', () => {
      const sm = new SelectionManager();
      const e = boxEvent();

      sm.handlePointerDown(5, 12, e);

      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.setPointerCapture).toHaveBeenCalledWith(7);
      expect(sm.isBoxDragging).toBe(true);
      expect(sm.selection.mode).toBe('box');
      expect(sm.selection.box).toEqual({ startLine: 5, endLine: 5, startCol: 12, endCol: 12 });
      expect(sm.selection.selected.size).toBe(0);
    });

    it('pointerdown without alt is ignored', () => {
      const sm = new SelectionManager();
      const e = boxEvent(false);

      sm.handlePointerDown(5, 12, e);

      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(sm.isBoxDragging).toBe(false);
      expect(sm.selection.mode).toBe('line');
    });

    it('drag down-right grows the box and fills the line set', () => {
      const sm = new SelectionManager();
      sm.handlePointerDown(2, 4, boxEvent());
      sm.handlePointerMove(5, 9);

      expect(sm.selection.box).toEqual({ startLine: 2, endLine: 5, startCol: 4, endCol: 9 });
      expect(lines(sm.selection)).toEqual([2, 3, 4, 5]);
      expect(sm.selection.anchor).toBe(2);
    });

    it('drag up-left normalizes the box around the anchor', () => {
      const sm = new SelectionManager();
      sm.handlePointerDown(5, 9, boxEvent());
      sm.handlePointerMove(2, 4);

      expect(sm.selection.box).toEqual({ startLine: 2, endLine: 5, startCol: 4, endCol: 9 });
      expect(lines(sm.selection)).toEqual([2, 3, 4, 5]);
      expect(sm.selection.anchor).toBe(5); // anchor stays at the drag origin
    });

    it('pointermove without an active drag is a no-op', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(1, click());
      sm.handlePointerMove(9, 9);
      expect(sm.selection.mode).toBe('line');
      expect(lines(sm.selection)).toEqual([1]);
    });

    it('releases the pointer capture it took (the pointercancel path)', () => {
      const sm = new SelectionManager();
      const e = boxEvent();
      sm.handlePointerDown(2, 4, e);
      expect(e.setPointerCapture).toHaveBeenCalledWith(7);

      // `handlePointerUp` is also the `onPointerCancel` handler, where nothing
      // else releases the capture and the element keeps swallowing pointer
      // events for that id.
      sm.handlePointerUp();

      expect(e.releasePointerCapture).toHaveBeenCalledWith(7);
      expect(sm.capturedElement).toBeNull();
    });

    it('releases nothing when no box drag was started', () => {
      const sm = new SelectionManager();
      const e = boxEvent(false);
      sm.handlePointerDown(2, 4, e);
      sm.handlePointerUp();
      expect(e.releasePointerCapture).not.toHaveBeenCalled();
    });

    it('pointerup ends the drag but keeps the selection', () => {
      const sm = new SelectionManager();
      sm.handlePointerDown(2, 4, boxEvent());
      sm.handlePointerMove(4, 8);
      sm.handlePointerUp();

      expect(sm.isBoxDragging).toBe(false);
      expect(sm.capturedElement).toBeNull();
      expect(sm.selection.mode).toBe('box');
      expect(lines(sm.selection)).toEqual([2, 3, 4]);

      // A move after pointerup must not extend the box.
      sm.handlePointerMove(10, 10);
      expect(lines(sm.selection)).toEqual([2, 3, 4]);
    });

    it('a line click after a box drag drops the box', () => {
      const sm = new SelectionManager();
      sm.handlePointerDown(2, 4, boxEvent());
      sm.handlePointerMove(4, 8);
      sm.handlePointerUp();

      sm.handleLineClick(7, click());

      expect(sm.selection.mode).toBe('line');
      expect(sm.selection.box).toBeUndefined();
      expect(lines(sm.selection)).toEqual([7]);
    });
  });

  // ── clear ────────────────────────────────────────────────────────────────

  it('clear resets to the empty line-mode selection', () => {
    const sm = new SelectionManager();
    sm.handlePointerDown(2, 4, boxEvent());
    sm.handlePointerMove(4, 8);

    sm.clear();

    expect(sm.selection.anchor).toBeNull();
    expect(sm.selection.selected.size).toBe(0);
    expect(sm.selection.mode).toBe('line');
    expect(sm.selection.box).toBeUndefined();
  });

  // ── Reactivity ───────────────────────────────────────────────────────────

  it('selection reads are reactive', () => {
    // createRoot defers the initial effect run until its callback returns, so
    // the mutations have to happen after it.
    const { sm, seen, dispose } = createRoot((d) => {
      const manager = new SelectionManager();
      const sizes: number[] = [];
      createEffect(() => { sizes.push(manager.selection.selected.size); });
      return { sm: manager, seen: sizes, dispose: d };
    });

    expect(seen).toEqual([0]);

    sm.handleLineClick(1, click());
    sm.handleLineClick(4, click({ shiftKey: true }));

    expect(seen).toEqual([0, 1, 4]);
    dispose();
  });

  // ── Interop with the unchanged copyText module ───────────────────────────

  describe('buildCopyText interop', () => {
    const text = (n: number) => `line ${n}`;

    it('joins the selected lines in line mode', () => {
      const sm = new SelectionManager();
      sm.handleLineClick(2, click());
      sm.handleLineClick(4, click({ shiftKey: true }));
      expect(buildCopyText(sm.selection, text)).toBe('line 2\nline 3\nline 4');
    });

    it('slices columns in box mode', () => {
      const sm = new SelectionManager();
      sm.handlePointerDown(1, 0, boxEvent());
      sm.handlePointerMove(2, 4);
      expect(buildCopyText(sm.selection, text)).toBe('line\nline');
    });

    it('returns null for an empty selection', () => {
      const sm = new SelectionManager();
      expect(buildCopyText(sm.selection, text)).toBeNull();
    });
  });
});
