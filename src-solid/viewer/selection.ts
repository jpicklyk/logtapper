import { createStore } from 'solid-js/store';

/**
 * Solid port of the React `viewport/SelectionManager.ts` (`useSelectionManager`).
 *
 * Same shape as the React `Selection` interface, so `buildCopyText` from
 * `@viewport/copyText` accepts this store's state unchanged (structural typing —
 * no import of the React module is needed).
 *
 * Ownership: `createStore` needs no owner, so a `SelectionManager` may be built
 * anywhere. It registers no effects and needs no disposal.
 */

export interface Selection {
  anchor: number | null;
  selected: Set<number>;
  mode: 'line' | 'box';
  box?: { startLine: number; endLine: number; startCol: number; endCol: number };
}

/** The mouse-modifier subset `handleLineClick` reads. */
export interface ClickModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The pointer-event subset `handlePointerDown` reads. */
export interface BoxPointerEvent {
  altKey: boolean;
  pointerId: number;
  currentTarget: EventTarget | null;
  preventDefault: () => void;
}

const emptySelection = (): Selection => ({ anchor: null, selected: new Set(), mode: 'line' });

export class SelectionManager {
  /**
   * Reactive selection state (a store proxy). `selected` is a plain `Set`, which
   * Solid stores do not deep-proxy — every transition replaces the whole Set, so
   * reads of `selection.selected` still re-run when it changes.
   */
  readonly selection: Selection;

  private readonly _set: (next: Selection) => void;
  private _boxDragging = false;
  private _boxAnchor: { line: number; col: number } | null = null;
  private _capturedElement: Element | null = null;
  private _capturedPointerId: number | null = null;

  constructor() {
    const [state, setState] = createStore<Selection>(emptySelection());
    this.selection = state;
    // Replace the whole record so a previous `box` is dropped, not merged.
    this._set = (next) => setState({ box: undefined, ...next });
  }

  /** click = single, shift+click = range from anchor, ctrl/cmd+click = toggle. */
  handleLineClick(lineNum: number, e: ClickModifiers): void {
    const { anchor, selected } = this.selection;
    if (e.shiftKey && anchor != null) {
      const lo = Math.min(anchor, lineNum);
      const hi = Math.max(anchor, lineNum);
      const next = new Set<number>();
      for (let i = lo; i <= hi; i++) next.add(i);
      this._set({ anchor, selected: next, mode: 'line' });
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(lineNum)) next.delete(lineNum);
      else next.add(lineNum);
      this._set({ anchor: lineNum, selected: next, mode: 'line' });
    } else {
      this._set({ anchor: lineNum, selected: new Set([lineNum]), mode: 'line' });
    }
  }

  /** alt+drag starts a rectangular (box) selection. Non-alt pointers are ignored. */
  handlePointerDown(lineNum: number, col: number, e: BoxPointerEvent): void {
    if (!e.altKey) return;
    e.preventDefault();
    this._boxDragging = true;
    this._boxAnchor = { line: lineNum, col };
    const target = e.currentTarget as Element | null;
    this._capturedElement = target;
    this._capturedPointerId = e.pointerId;
    target?.setPointerCapture?.(e.pointerId);
    this._set({
      anchor: lineNum,
      selected: new Set(),
      mode: 'box',
      box: { startLine: lineNum, endLine: lineNum, startCol: col, endCol: col },
    });
  }

  /** Extend the box while dragging. No-op unless a box drag is active. */
  handlePointerMove(lineNum: number, col: number): void {
    const anchor = this._boxAnchor;
    if (!this._boxDragging || !anchor) return;
    const startLine = Math.min(anchor.line, lineNum);
    const endLine = Math.max(anchor.line, lineNum);
    const startCol = Math.min(anchor.col, col);
    const endCol = Math.max(anchor.col, col);
    const next = new Set<number>();
    for (let i = startLine; i <= endLine; i++) next.add(i);
    this._set({
      anchor: anchor.line,
      selected: next,
      mode: 'box',
      box: { startLine, endLine, startCol, endCol },
    });
  }

  /** End a box drag. The selection itself is kept. */
  handlePointerUp(): void {
    this._boxDragging = false;
    this._boxAnchor = null;
    // Release what `handlePointerDown` captured. `pointerup` releases implicit
    // capture on its own, but this handler is also the `pointercancel` path —
    // where nothing releases it and the element keeps swallowing every
    // subsequent pointer event for that id.
    const captured = this._capturedElement;
    const pointerId = this._capturedPointerId;
    if (captured && pointerId != null) {
      try {
        if (captured.hasPointerCapture?.(pointerId)) captured.releasePointerCapture?.(pointerId);
      } catch {
        // The element may already be detached — releasing is best-effort.
      }
    }
    this._capturedElement = null;
    this._capturedPointerId = null;
  }

  /** Reset to the empty line-mode selection. */
  clear(): void {
    this._set(emptySelection());
  }

  /** True while an alt+drag box selection is in progress. */
  get isBoxDragging(): boolean {
    return this._boxDragging;
  }

  /** The element that captured the pointer for the active box drag, if any. */
  get capturedElement(): Element | null {
    return this._capturedElement;
  }
}
