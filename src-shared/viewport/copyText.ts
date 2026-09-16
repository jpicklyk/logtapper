import type { Selection } from './selection';

/**
 * Build the clipboard text for a given selection.
 *
 * Line mode: each selected line's text, joined by newline.
 * Box mode: column-aligned rectangle from each line in the range.
 *
 * Empty lines (raw === "") are preserved — only truly missing lines
 * (getLineText returns undefined) are excluded.
 */
export function buildCopyText(
  selection: Selection,
  getLineText: (lineNum: number) => string | undefined,
): string | null {
  if (selection.mode === 'box' && selection.box) {
    const { startLine, endLine, startCol, endCol } = selection.box;
    const rows: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const text = getLineText(i) ?? '';
      rows.push(text.slice(startCol, endCol));
    }
    return rows.join('\n');
  }

  if (selection.selected.size === 0) return null;

  const sorted = Array.from(selection.selected).sort((a, b) => a - b);
  const text = sorted
    .map((n) => getLineText(n))
    .filter((t): t is string => t != null)
    .join('\n');
  return text;
}

/** Synchronous fallback copy via a hidden textarea + execCommand. */
function execCommandCopy(text: string): void {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
}

/**
 * Robust clipboard write: async Clipboard API with synchronous execCommand fallback.
 * navigator.clipboard can silently fail in Tauri WebView2 without the clipboard plugin.
 */
export function writeClipboard(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
  } else {
    execCommandCopy(text);
  }
}
