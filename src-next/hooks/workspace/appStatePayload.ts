import type { AppStateFile } from '../../bridge/types';

/**
 * Build an `AppStateFile` payload from workspace context state.
 *
 * Pure and dependency-light on purpose: it lives apart from
 * `workspacePersistence.ts` (which imports EditorTab and other browser-only
 * modules) so that `WorkspaceContext` can persist to disk without dragging the
 * editor/theme module graph — and its `window.matchMedia` module-load side
 * effects — into node test environments.
 *
 * Shared between `persistAppState`, `useAppExitSave`, and the WorkspaceContext
 * write-through / hydration paths.
 */
export function buildAppStatePayload(
  workspaces: ReadonlyArray<{
    id: string;
    name: string;
    filePath: string | null;
    dirty: boolean;
    autoSavePath?: string | null;
    lastAutoSaveAt?: number | null;
  }>,
  activeId: string | null,
): AppStateFile {
  return {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      ltwPath: w.filePath,
      dirty: w.dirty,
      autoSavePath: w.autoSavePath ?? null,
      lastAutoSaveAt: w.lastAutoSaveAt ?? null,
    })),
    activeWorkspaceId: activeId,
  };
}
