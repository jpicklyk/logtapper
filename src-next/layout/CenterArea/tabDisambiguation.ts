/**
 * Pure, tree-only computation of display label + tooltip overrides for
 * logviewer tabs that share the same base label.
 *
 * Session ids are content-derived (see `core/session.rs`), so two loads of a
 * same-named file (e.g. "dumpstate.txt" pulled from two different devices)
 * produce indistinguishable tabs by label alone. `Tab.sourcePath` (stashed at
 * session-load time — see `hooks/workspace/sessionTreeOps.ts`) is enough to
 * disambiguate them without any context access, which is why this lives as a
 * pure function over the `SplitNode` tree rather than a context selector —
 * `layout/` components stay prop-driven (layout/CLAUDE.md).
 */
import { allPanes } from '../../hooks/workspace';
import type { SplitNode } from '../../hooks';
import { basename, dirname } from '../../utils';

export interface TabDisplayInfo {
  /** Display label — the tab's own label, or with a " — <parentDir>/" suffix
   *  appended when it collides with another open tab's label. */
  label: string;
  /** Full hover text: source path + line count when known. */
  tooltip: string;
}

/**
 * Build a `tabId -> { label, tooltip }` map for every logviewer tab in the
 * tree. Only tabs whose label collides with another tab's label get a
 * disambiguating suffix; all logviewer tabs with a known `sourcePath` get a
 * populated tooltip regardless of collision.
 */
export function computeTabDisplayInfo(tree: SplitNode): Map<string, TabDisplayInfo> {
  const result = new Map<string, TabDisplayInfo>();

  const logviewerTabs = allPanes(tree)
    .flatMap((pane) => pane.tabs)
    .filter((t) => t.type === 'logviewer');

  const byLabel = new Map<string, typeof logviewerTabs>();
  for (const tab of logviewerTabs) {
    const group = byLabel.get(tab.label);
    if (group) group.push(tab);
    else byLabel.set(tab.label, [tab]);
  }

  for (const group of byLabel.values()) {
    // Only disambiguate when the collision is real — distinct sessions with
    // different source paths. Multiple tabs from the SAME path (or with no
    // known path yet, e.g. still loading) are left alone: there is nothing
    // honest to disambiguate them with.
    const distinctPaths = new Set(group.map((t) => t.sourcePath).filter((p): p is string => !!p));
    const shouldDisambiguate = group.length > 1 && distinctPaths.size > 1;

    for (const tab of group) {
      const lines = tab.sourceTotalLines != null ? `${tab.sourceTotalLines.toLocaleString()} lines` : null;
      const tooltip = tab.sourcePath
        ? [tab.sourcePath, lines].filter(Boolean).join(' · ')
        : tab.label;

      let label = tab.label;
      if (shouldDisambiguate && tab.sourcePath) {
        const parentDirName = basename(dirname(tab.sourcePath));
        if (parentDirName) label = `${tab.label} — ${parentDirName}/`;
      }

      result.set(tab.id, { label, tooltip });
    }
  }

  return result;
}
