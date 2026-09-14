/**
 * Public API of the workspace package: the persistence store, the `.ltw`
 * layout namespace, the restore-plan runner, and the workspace-home UI
 * (`WorkspaceHome`, `Switcher`). W9 (editor tabs) and `App.tsx` import from
 * here only — never from the files directly.
 */
export {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  REACT_LAYOUT_KEYS,
  SOLID_LAYOUT_VERSION,
  emptySolidLayout,
  emptySplitLayout,
  readSolidLayout,
  writeSolidLayout,
} from './layoutBlob';
export type { SolidLayout, SplitLayout } from './layoutBlob';

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

export { WorkspaceHome } from './WorkspaceHome';
export type { WorkspaceHomeProps } from './WorkspaceHome';

export { Switcher } from './Switcher';
export type { SwitcherProps } from './Switcher';
