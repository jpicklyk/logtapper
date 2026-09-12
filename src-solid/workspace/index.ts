/**
 * Public API of the workspace package: the persistence store, the `.ltw`
 * layout namespace, and the restore-plan runner. W1b (the UI) and W9 (editor
 * tabs) import from here only — never from the files directly.
 */
export {
  REACT_LAYOUT_KEYS,
  SOLID_LAYOUT_VERSION,
  emptySolidLayout,
  readSolidLayout,
  writeSolidLayout,
} from './layoutBlob';
export type { SolidLayout } from './layoutBlob';

export {
  AUTO_SAVE_DEBOUNCE_MS,
  SOLID_MIRROR_KEY,
  createWorkspaceStore,
  mirrorToStoredTabs,
} from './workspaceStore';
export type {
  PipelineChainSnapshot,
  ShellLayoutPort,
  WorkspaceMirror,
  WorkspaceSessionActions,
  WorkspaceSessions,
  WorkspaceStore,
  WorkspaceStoreDeps,
} from './workspaceStore';

export { runRestorePlan } from './restore';
export type { RestoreIo, RestoreOutcome } from './restore';
