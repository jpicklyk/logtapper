/**
 * Module-level handoff for a pane id -> artifact id pairing, consumed by
 * AnalysisReader on mount.
 *
 * `openCenterTab` (hooks/workspace/useCenterTree.ts) resolves the target
 * pane id synchronously and returns it, but React doesn't commit the
 * resulting tab/pane change — and mount (or switch-render) AnalysisReader
 * into it — until after the current task. A plain `analysis:open` bus event
 * fired right after `openCenterTab` returns is missed by a reader that
 * hasn't mounted yet (new-tab and reuse-inactive-tab open paths).
 *
 * This mirrors the LS_*_PREFIX localStorage seeding EditorTab exports for
 * the same "hand initial state to a component that mounts after the open
 * request" problem (see `components/EditorTab/EditorTab.tsx`) — except this
 * handoff is transient (in-memory, consumed once) rather than persisted.
 *
 * The already-mounted case (reusing an already-active analysis tab) does
 * NOT rely on this — it's covered by the live `analysis:open` bus event
 * instead, since a mount-only consume can't re-fire for a second click on
 * an already-active tab targeting a different artifact.
 */
const pendingByPane = new Map<string, string>();

export function setPendingAnalysisSelection(paneId: string, artifactId: string): void {
  pendingByPane.set(paneId, artifactId);
}

/** Reads and clears the pending selection for `paneId`, if any. */
export function takePendingAnalysisSelection(paneId: string): string | null {
  const artifactId = pendingByPane.get(paneId);
  if (artifactId === undefined) return null;
  pendingByPane.delete(paneId);
  return artifactId;
}
