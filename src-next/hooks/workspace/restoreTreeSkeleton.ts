/**
 * Pure, React-free rebuild of the center-tree split skeleton for workspace
 * restore (work item f5d0e527 — "workspace restore collapses pane
 * grouping").
 *
 * Save writes the FULL center tree (splits, ratios, nesting) into the
 * `.ltw` layout blob (`useWorkspace.ts`'s `buildSavePayload` → `getLayoutState()`).
 * Restore used to discard it entirely: a fresh single-pane tree is seeded
 * before any session reloads, the saved pane ids are stale by the time a
 * session lands, so `findLeafByPaneId` never finds them and every session
 * falls through to `firstLeaf` — flattening the whole workspace into one
 * pane (`sessionTreeOps.ts`'s `applySessionLoaded` fallback branch).
 *
 * This module reconstructs the split/leaf skeleton with FRESH pane ids
 * before any session load runs, and records where each dropped
 * (`logviewer`/`editor`) tab used to live so `restoreCore.ts` can steer each
 * `loadFile` / editor-tab-restore event at the pane it actually occupied
 * when the workspace was saved — matched by a content-stable key
 * (`sourcePath`) rather than the now-stale pane id.
 *
 * Deliberately dependency-light — no import from `workspacePersistence.ts`,
 * which drags in the EditorTab/ThemeContext module graph (same rationale as
 * `appStatePayload.ts`) — so this stays trivially unit-testable and safe to
 * import from `restoreCore.ts`, which is carefully mocked in
 * `restoreCore.test.ts`.
 */
import type { CenterPane, CenterTabType, SplitNode, Tab } from './workspaceTypes';
import { VALID_CENTER_TYPES } from './workspaceTypes';
import { normalizePath } from './restoreTrust';

/**
 * How the skeleton rebuild treats each tab type on the saved tree. Keyed
 * exhaustively over `CenterTabType` (mirrors `TAB_LABELS` in
 * `workspaceTypes.ts`) so a future addition to that union fails to compile
 * here instead of being silently dropped on restore:
 *
 *  - `'placement'` — the tab is dropped from the rebuilt leaf and recorded
 *    as a `TabPlacement` instead. `restoreCore.ts`'s `PaneResolver` matches
 *    it back to its remapped pane by content-stable `sourcePath`, because
 *    the tab's own identity (sessionId for `logviewer`, tab id for
 *    `editor`) doesn't survive restore — `logviewer` rebinds to a
 *    freshly-loaded session via the normal session-load path;
 *    `editor` content is replayed separately via `buildEditorTabEvents`
 *    (its `.ltw`-persisted `content`/`viewMode`/`wordWrap`, not anything on
 *    the tree), which is why a copy isn't kept here — that would risk a
 *    duplicate tab.
 *  - `'carryOver'` — the tab is kept directly in the new leaf, fresh tab id,
 *    otherwise as-is; no further content restore needed. `dashboard`
 *    recreates itself anyway on the next `pipeline:completed` for its
 *    session (`useCenterTree`'s `onPipelineCompleted`, which no-ops —
 *    reuses, doesn't duplicate — if it's already present), now correctly
 *    targeting the session's remapped pane; keeping it here just means it
 *    doesn't have to wait for that rerun. `analysis` (the reader tab)
 *    self-selects an artifact on mount (`AnalysisReader`'s
 *    pending-selection / first-artifact fallback) — it needs no data
 *    handed to it, just to exist in the right pane.
 */
const TAB_RESTORE_STRATEGY: Record<CenterTabType, 'placement' | 'carryOver'> = {
  logviewer: 'placement',
  editor: 'placement',
  dashboard: 'carryOver',
  analysis: 'carryOver',
};

export interface TabPlacement {
  type: CenterTabType;
  oldPaneId: string;
  newPaneId: string;
  /** The stable, content-derived key used to match this placement back to
   *  its remapped pane — `Tab.sourcePath` for `logviewer` (stamped at
   *  session-load time), the file path for `editor` (stamped onto the tab
   *  the same way — see `useCenterTree.openCenterTab`). `null`/absent for a
   *  tab with no known path yet (e.g. an ADB stream, or an untitled editor
   *  tab) — callers fall back to `byOldPaneId` for those. */
  sourcePath?: string | null;
}

export interface TreeSkeleton {
  /** The rebuilt tree: same split structure (direction/ratio/nesting) as
   *  the saved one, fresh split/leaf/pane ids, `logviewer`/`editor` tabs
   *  dropped — empty (or carry-over-only) leaves ready for placement. */
  tree: SplitNode;
  /** Old pane id → new pane id, covering every leaf in the saved tree. */
  paneIdMap: Map<string, string>;
  /** One entry per dropped `'placement'`-strategy tab (`logviewer`, `editor`
   *  — see `TAB_RESTORE_STRATEGY`). */
  placements: TabPlacement[];
}

function looksLikeSplitNode(value: unknown): value is SplitNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as { type?: unknown };
  return node.type === 'leaf' || node.type === 'split';
}

/**
 * Rebuild the split skeleton from a saved tree (the `.ltw` layout blob's
 * `centerTree`, still `unknown` at the call site). Returns `null` when
 * `saved` isn't a well-formed `SplitNode` — defensive: a corrupt or foreign
 * `layout` value must not crash restore, it just falls back to the
 * pre-fix flat behavior a legacy `.ltw` with no tree at all already gets.
 */
export function rebuildTreeSkeleton(saved: unknown): TreeSkeleton | null {
  if (!looksLikeSplitNode(saved)) return null;

  const paneIdMap = new Map<string, string>();
  const placements: TabPlacement[] = [];

  function visit(node: SplitNode): SplitNode | null {
    if (node.type === 'split') {
      if (!Array.isArray(node.children) || node.children.length !== 2) return null;
      const left = visit(node.children[0]);
      const right = visit(node.children[1]);
      if (!left || !right) return null;
      return {
        type: 'split',
        id: crypto.randomUUID(),
        direction: node.direction === 'vertical' ? 'vertical' : 'horizontal',
        ratio: typeof node.ratio === 'number' ? node.ratio : 0.5,
        children: [left, right],
      };
    }

    // Leaf
    if (!node.pane || !Array.isArray(node.pane.tabs)) return null;
    const newPaneId = crypto.randomUUID();
    paneIdMap.set(node.pane.id, newPaneId);

    const keptTabs: Tab[] = [];
    for (const tab of node.pane.tabs) {
      if (!tab || !VALID_CENTER_TYPES.has(tab.type)) continue;
      const strategy = TAB_RESTORE_STRATEGY[tab.type];
      if (strategy === 'placement') {
        placements.push({
          type: tab.type,
          oldPaneId: node.pane.id,
          newPaneId,
          sourcePath: tab.sourcePath ?? null,
        });
        continue;
      }
      // 'carryOver'
      keptTabs.push({ id: crypto.randomUUID(), type: tab.type, label: tab.label, closable: true });
    }

    const pane: CenterPane = {
      id: newPaneId,
      tabs: keptTabs,
      activeTabId: keptTabs[0]?.id ?? '',
    };
    return { type: 'leaf', id: crypto.randomUUID(), pane };
  }

  const tree = visit(saved);
  if (!tree) return null;
  return { tree, paneIdMap, placements };
}

export interface PaneResolver {
  /** Match a placement of `type` (default `logviewer`) by its saved
   *  `sourcePath` (normalized). Consumes the matched placement so a second
   *  load can't also claim it. */
  bySourcePath: (path: string | null | undefined, type?: CenterTabType) => string | null;
  /** Remap a stale saved pane id straight through `paneIdMap`. */
  byOldPaneId: (oldPaneId: string | null | undefined) => string | null;
  /** Resolve in priority order: stable content key, then remapped old pane
   *  id. Returns `null` when neither matches (e.g. a file opened after the
   *  last save with no corresponding saved placement) — callers fall back
   *  to their normal default-pane behavior in that case. */
  resolve: (opts: { sourcePath?: string | null; oldPaneId?: string; type?: CenterTabType }) => string | null;
}

/**
 * Resolves the new pane id a restored session (or other placement) should
 * target. Prefers the content-stable `sourcePath` match — it survives even
 * though every pane id in the tree was regenerated; falls back to the
 * pane-id map for entries with no `sourcePath` (e.g. an ADB stream tab).
 * Each placement is claimed at most once, so two loads never land on the
 * same recorded slot.
 */
export function createPaneResolver(skeleton: TreeSkeleton): PaneResolver {
  const claimed = new Set<number>();

  const bySourcePath: PaneResolver['bySourcePath'] = (path, type = 'logviewer') => {
    if (!path) return null;
    const norm = normalizePath(path);
    const idx = skeleton.placements.findIndex((p, i) =>
      !claimed.has(i) && p.type === type && p.sourcePath != null && normalizePath(p.sourcePath) === norm);
    if (idx === -1) return null;
    claimed.add(idx);
    return skeleton.placements[idx].newPaneId;
  };

  const byOldPaneId: PaneResolver['byOldPaneId'] = (oldPaneId) => {
    if (!oldPaneId) return null;
    return skeleton.paneIdMap.get(oldPaneId) ?? null;
  };

  const resolve: PaneResolver['resolve'] = (opts) =>
    bySourcePath(opts.sourcePath, opts.type ?? 'logviewer') ?? byOldPaneId(opts.oldPaneId);

  return { bySourcePath, byOldPaneId, resolve };
}
