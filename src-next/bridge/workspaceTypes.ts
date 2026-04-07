/** A single workspace entry in the workspace list. */
export interface WorkspaceIdentity {
  /** Unique identifier for this workspace. */
  id: string;
  /** Display name: filename stem for opened .ltw, "Untitled" for new. */
  name: string;
  /** Path to .ltw file if saved, null if unsaved. */
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

/** The workspace list state managed by WorkspaceContext. */
export interface WorkspaceListState {
  workspaces: WorkspaceIdentity[];
  activeId: string | null;
}

export const WORKSPACE_STORAGE_KEY = 'logtapper_workspace_list';

export function createEmptyWorkspace(): WorkspaceIdentity {
  return { id: crypto.randomUUID(), name: 'Untitled', filePath: null, dirty: false };
}

export function createEmptyListState(): WorkspaceListState {
  return { workspaces: [], activeId: null };
}

/** Get the active workspace from the list, or null if none. */
export function getActiveWorkspace(state: WorkspaceListState): WorkspaceIdentity | null {
  if (!state.activeId) return null;
  return state.workspaces.find(w => w.id === state.activeId) ?? null;
}

/** Format the window title bar from the active workspace. */
export function formatTitle(ws: WorkspaceIdentity | null): string {
  if (!ws) return 'LogTapper';
  const indicator = ws.dirty ? ' *' : '';
  return `${ws.name}${indicator} \u2014 LogTapper`;
}
