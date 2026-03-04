import { useState, useCallback, useRef } from 'react';

export interface Selection {
  anchor: number | null;
  selected: Set<number>;
  mode: 'line' | 'box';
  box?: { startLine: number; endLine: number; startCol: number; endCol: number };
}

const EMPTY_SELECTION: Selection = {
  anchor: null,
  selected: new Set(),
  mode: 'line',
};

export function useSelectionManager(getLineText: (lineNum: number) => string | undefined): {
  selection: Selection;
  handleLineClick: (lineNum: number, e: React.MouseEvent) => void;
  handlePointerDown: (lineNum: number, col: number, e: React.PointerEvent) => void;
  handlePointerMove: (lineNum: number, col: number, e: React.PointerEvent) => void;
  handlePointerUp: () => void;
  handleCopy: () => void;
  clear: () => void;
} {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const boxDragging = useRef(false);
  const boxAnchor = useRef<{ line: number; col: number } | null>(null);
  const capturedElement = useRef<Element | null>(null);

  const handleLineClick = useCallback((lineNum: number, e: React.MouseEvent) => {
    if (e.shiftKey && selection.anchor != null) {
      // Range select from anchor to clicked line
      const lo = Math.min(selection.anchor, lineNum);
      const hi = Math.max(selection.anchor, lineNum);
      const newSelected = new Set<number>();
      for (let i = lo; i <= hi; i++) {
        newSelected.add(i);
      }
      setSelection({ anchor: selection.anchor, selected: newSelected, mode: 'line' });
    } else if (e.ctrlKey || e.metaKey) {
      // Toggle individual line
      const newSelected = new Set(selection.selected);
      if (newSelected.has(lineNum)) {
        newSelected.delete(lineNum);
      } else {
        newSelected.add(lineNum);
      }
      setSelection({ anchor: lineNum, selected: newSelected, mode: 'line' });
    } else {
      // Single select
      setSelection({ anchor: lineNum, selected: new Set([lineNum]), mode: 'line' });
    }
  }, [selection.anchor, selection.selected]);

  const handlePointerDown = useCallback((lineNum: number, col: number, e: React.PointerEvent) => {
    if (!e.altKey) return;
    e.preventDefault();
    boxDragging.current = true;
    boxAnchor.current = { line: lineNum, col };
    capturedElement.current = e.currentTarget;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setSelection({
      anchor: lineNum,
      selected: new Set(),
      mode: 'box',
      box: { startLine: lineNum, endLine: lineNum, startCol: col, endCol: col },
    });
  }, []);

  const handlePointerMove = useCallback((lineNum: number, col: number, _e: React.PointerEvent) => {
    if (!boxDragging.current || !boxAnchor.current) return;
    const anchor = boxAnchor.current;
    const startLine = Math.min(anchor.line, lineNum);
    const endLine = Math.max(anchor.line, lineNum);
    const startCol = Math.min(anchor.col, col);
    const endCol = Math.max(anchor.col, col);
    const newSelected = new Set<number>();
    for (let i = startLine; i <= endLine; i++) {
      newSelected.add(i);
    }
    setSelection({
      anchor: anchor.line,
      selected: newSelected,
      mode: 'box',
      box: { startLine, endLine, startCol, endCol },
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    boxDragging.current = false;
    boxAnchor.current = null;
    capturedElement.current = null;
  }, []);

  const handleCopy = useCallback(() => {
    if (selection.selected.size === 0) return;

    if (selection.mode === 'box' && selection.box) {
      // Box mode: column-aligned rectangle
      const { startLine, endLine, startCol, endCol } = selection.box;
      const rows: string[] = [];
      for (let i = startLine; i <= endLine; i++) {
        const text = getLineText(i) ?? '';
        rows.push(text.slice(startCol, endCol));
      }
      navigator.clipboard.writeText(rows.join('\n'));
    } else {
      // Line mode: sorted line texts joined by newline
      const sorted = Array.from(selection.selected).sort((a, b) => a - b);
      const text = sorted
        .map((n) => getLineText(n))
        .filter((t): t is string => t != null)
        .join('\n');
      navigator.clipboard.writeText(text);
    }
  }, [selection, getLineText]);

  const clear = useCallback(() => {
    setSelection(EMPTY_SELECTION);
  }, []);

  return {
    selection,
    handleLineClick,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleCopy,
    clear,
  };
}
