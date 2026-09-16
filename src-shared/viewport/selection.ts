/**
 * The viewer's selection model — the shape `buildCopyText` reads.
 *
 * Framework-free by construction: the React `useSelectionManager` hook that
 * produced this shape lived next to it in `viewport/SelectionManager.ts` and
 * died with the React tree; each frontend now owns its own selection
 * *controller* and only the data shape is shared.
 */
export interface Selection {
  anchor: number | null;
  selected: Set<number>;
  mode: 'line' | 'box';
  box?: { startLine: number; endLine: number; startCol: number; endCol: number };
}
