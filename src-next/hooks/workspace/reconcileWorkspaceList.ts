/**
 * Reconcile the synchronously-seeded in-memory workspace list (from
 * localStorage) with the authoritative on-disk `app-state.json` at startup.
 *
 * Under option 1C (see `plans/workspace-restore-design.md` §Q1) `app-state.json`
 * is authoritative and localStorage is demoted to a fast bootstrap mirror. This
 * pure function encodes the merge so it can be unit-tested without React:
 *
 * - **disk non-empty → disk wins** for the list, `activeId`, `ltwPath`, and the
 *   two auto-save fields. The `dirty` flag is the one exception: disk's `dirty`
 *   is advisory only. The in-memory UI dirty flag reflects unsaved edits the
 *   user made this session and must not be clobbered by a possibly-stale disk
 *   value, so a workspace present in memory keeps its in-memory `dirty`.
 * - **disk empty + memory non-empty → adopt memory** and signal `migrated`. The
 *   caller writes the adopted state straight back to disk. This is the one-time,
 *   idempotent migration for every existing user (no version flag: "disk empty,
 *   memory non-empty" is itself the trigger).
 * - **both empty → createDefault** signal. The caller creates the default
 *   workspace.
 *
 * React-free by design — same pattern as `artifactPairing.ts` / `autoSaveGate.ts`.
 */
import type { AppStateFile } from '../../bridge/types';
import type { WorkspaceIdentity, WorkspaceListState } from '../../bridge/workspaceTypes';
import { createEmptyListState } from '../../bridge/workspaceTypes';

export interface ReconcileResult {
  /** The resolved workspace list to apply. */
  state: WorkspaceListState;
  /** True when memory was adopted because disk was empty — the caller must
   *  write `state` back to disk exactly once. */
  migrated: boolean;
  /** True when both sides were empty — the caller should create the default
   *  workspace. `state` is an empty list in this case. */
  createDefault: boolean;
}

/**
 * Merge the in-memory list (`memory`) with the on-disk state (`disk`).
 * See the module doc for the resolution rules.
 */
export function reconcileWorkspaceList(
  memory: WorkspaceListState,
  disk: AppStateFile,
): ReconcileResult {
  const diskWorkspaces = disk.workspaces ?? [];
  const memoryWorkspaces = memory.workspaces ?? [];

  // Disk is authoritative whenever it holds any entries.
  if (diskWorkspaces.length > 0) {
    // Look up the in-memory dirty flag by id so it survives hydration.
    const memoryDirtyById = new Map<string, boolean>(
      memoryWorkspaces.map((w) => [w.id, w.dirty]),
    );

    const workspaces: WorkspaceIdentity[] = diskWorkspaces.map((entry) => ({
      id: entry.id,
      name: entry.name,
      filePath: entry.ltwPath,
      // Advisory-only from disk: keep the in-memory UI flag when we have one.
      dirty: memoryDirtyById.get(entry.id) ?? entry.dirty,
      autoSavePath: entry.autoSavePath ?? null,
      lastAutoSaveAt: entry.lastAutoSaveAt ?? null,
    }));

    return {
      state: { workspaces, activeId: resolveActiveId(disk.activeWorkspaceId, workspaces) },
      migrated: false,
      createDefault: false,
    };
  }

  // Disk empty, memory non-empty → adopt memory; caller persists it once.
  if (memoryWorkspaces.length > 0) {
    return { state: memory, migrated: true, createDefault: false };
  }

  // Both empty → caller creates the default workspace.
  return { state: createEmptyListState(), migrated: false, createDefault: true };
}

/**
 * Keep the disk-supplied active id when it names a workspace that survived the
 * merge; otherwise fall back to the first workspace so the pointer is never
 * left dangling.
 */
function resolveActiveId(
  candidate: string | null,
  workspaces: ReadonlyArray<WorkspaceIdentity>,
): string | null {
  if (candidate && workspaces.some((w) => w.id === candidate)) return candidate;
  return workspaces[0]?.id ?? null;
}
