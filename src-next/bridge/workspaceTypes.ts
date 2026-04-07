/** Workspace identity — the root container for all open state. */
export interface WorkspaceIdentity {
  /** Display name: filename stem for opened .lts, "Untitled" for new. */
  name: string;
  /** Path to .lts file if opened/saved, null if unsaved. */
  filePath: string | null;
  /** True when any tracked state has changed since last save/open. */
  dirty: boolean;
}

/** Lightweight reference to an open session (metadata only, not full state). */
export interface WorkspaceSessionRef {
  sessionId: string;
  paneId: string;
  sourceName: string;
  sourceType: string;
  isStreaming: boolean;
}

/** Lightweight reference to an open editor tab (metadata only, not content). */
export interface WorkspaceEditorRef {
  editorId: string;
  label: string;
  filePath: string | null;
}

export const WORKSPACE_STORAGE_KEY = 'logtapper_workspace_identity';

export function createEmptyIdentity(): WorkspaceIdentity {
  return { name: 'Untitled', filePath: null, dirty: false };
}
