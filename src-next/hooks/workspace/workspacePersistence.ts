import type { LtsEditorTabPayload, LtwEditorTab } from '../../bridge/types';
import { autoSaveWorkspace, saveWorkspaceV4 } from '../../bridge/commands';
import type { BottomTabType, EditorTabState, LeftPaneTab, RightPaneTab, SplitNode } from './workspaceTypes';
import { storageGet } from '../../utils';
import { LS_CONTENT_PREFIX, LS_MODE_PREFIX, LS_WRAP_PREFIX, LS_FILEPATH_PREFIX } from '../../components/EditorTab';
import {
  MIN_LEFT_WIDTH, MAX_LEFT_WIDTH,
  MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH,
  MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT,
  STORAGE_KEY,
  VALID_CENTER_TYPES, VALID_BOTTOM_TYPES, VALID_LEFT_TABS, VALID_RIGHT_TABS,
} from './workspaceTypes';
import { clamp, allPanes } from './splitTreeHelpers';
import { storageGetJSON, storageSetJSON } from '../../utils';

// ---------------------------------------------------------------------------
// Persisted state interface
// ---------------------------------------------------------------------------

export interface PersistedState {
  centerTree: SplitNode;
  leftPaneWidth: number;
  leftPaneTab: LeftPaneTab;
  rightPaneVisible: boolean;
  rightPaneWidth: number;
  rightPaneTab: RightPaneTab;
  bottomPaneVisible: boolean;
  bottomPaneHeight: number;
  bottomPaneTab: BottomTabType;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/** Sanitize a tree restored from localStorage. Strip unknown tab types, flatten corrupt nodes.
 *  @param tabPaths  Optional tabId→filePath map. When provided, logviewer tabs without a
 *                   corresponding file path are stripped (e.g. unsaved ADB stream tabs). */
export function sanitizeTree(node: SplitNode, tabPaths?: Record<string, string>): SplitNode | null {
  if (!node || typeof node !== 'object') return null;

  if (node.type === 'leaf') {
    if (!node.pane || !Array.isArray(node.pane.tabs)) return null;
    const tabs = node.pane.tabs
      // Migrate legacy 'scratch' tabs to 'editor'
      .map((t) => (t.type as string) === 'scratch' ? { ...t, type: 'editor' as const } : t)
      .filter((t) => VALID_CENTER_TYPES.has(t.type))
      // Strip logviewer tabs that have no file path (unsaved ADB streams)
      .filter((t) => t.type !== 'logviewer' || !tabPaths || !!tabPaths[t.id])
      .map((t) => ({ ...t, closable: true }));
    // Empty panes are valid (the default state is an empty leaf)
    const activeTabId = tabs.find((t) => t.id === node.pane.activeTabId)
      ? node.pane.activeTabId
      : (tabs[0]?.id ?? '');
    return { ...node, pane: { ...node.pane, tabs, activeTabId } };
  }

  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length !== 2) return null;
    const left = sanitizeTree(node.children[0], tabPaths);
    const right = sanitizeTree(node.children[1], tabPaths);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    const ratio = typeof node.ratio === 'number' ? clamp(node.ratio, 0.1, 0.9) : 0.5;
    const direction = node.direction === 'vertical' ? 'vertical' : 'horizontal';
    return { ...node, children: [left, right], ratio, direction };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export function loadPersistedState(): Partial<PersistedState> {
  const parsed = storageGetJSON<PersistedState | null>(STORAGE_KEY, null);
  if (!parsed) return {};

  {
    const result: Partial<PersistedState> = {};

    if (parsed.centerTree) {
      // Pass tabPaths so logviewer tabs without a file path (unsaved ADB
      // streams) are stripped before the tree is used by the app.
      const tabPaths = storageGetJSON<Record<string, string>>('logtapper_tab_paths', {});
      const sanitized = sanitizeTree(parsed.centerTree, tabPaths);
      if (sanitized) result.centerTree = sanitized;
    }
    if (typeof parsed.leftPaneWidth === 'number') {
      result.leftPaneWidth = clamp(parsed.leftPaneWidth, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH);
    }
    if (typeof parsed.leftPaneTab === 'string' && VALID_LEFT_TABS.has(parsed.leftPaneTab)) {
      result.leftPaneTab = parsed.leftPaneTab;
    }
    if (typeof parsed.rightPaneVisible === 'boolean') {
      result.rightPaneVisible = parsed.rightPaneVisible;
    }
    if (typeof parsed.rightPaneWidth === 'number') {
      result.rightPaneWidth = clamp(parsed.rightPaneWidth, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH);
    }
    if (typeof parsed.rightPaneTab === 'string' && VALID_RIGHT_TABS.has(parsed.rightPaneTab)) {
      result.rightPaneTab = parsed.rightPaneTab as RightPaneTab;
    }
    if (typeof parsed.bottomPaneVisible === 'boolean') {
      result.bottomPaneVisible = parsed.bottomPaneVisible;
    }
    if (typeof parsed.bottomPaneHeight === 'number') {
      result.bottomPaneHeight = clamp(parsed.bottomPaneHeight, MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT);
    }
    if (typeof parsed.bottomPaneTab === 'string' && VALID_BOTTOM_TYPES.has(parsed.bottomPaneTab)) {
      result.bottomPaneTab = parsed.bottomPaneTab as BottomTabType;
    }
    return result;
  }
}

export function savePersistedState(state: PersistedState): void {
  storageSetJSON(STORAGE_KEY, state);
}

// ---------------------------------------------------------------------------
// Public read helpers (used by useFileSession startup restore)
// ---------------------------------------------------------------------------

/**
 * Reads the persisted workspace tree and returns the first center pane ID.
 * Used by useLogViewer's startup restore so the session is registered under
 * the real pane ID, not the 'primary' fallback.
 */
export function getStoredFirstPaneId(): string | null {
  const parsed = storageGetJSON<{ centerTree?: SplitNode } | null>(STORAGE_KEY, null);
  const tree = parsed?.centerTree;
  if (!tree) return null;
  function firstPaneId(node: SplitNode): string | null {
    if (node.type === 'leaf') return node.pane.id;
    return firstPaneId(node.children[0]);
  }
  return firstPaneId(tree);
}

/**
 * Returns all persisted logviewer tabs across all panes, with their pane ID
 * and whether each tab is currently active. Used by useLogViewer's startup
 * restore to reload all open files, not just the last-focused one.
 */
export function getStoredLogviewerTabs(): Array<{ tabId: string; paneId: string; isActive: boolean }> {
  const parsed = storageGetJSON<{ centerTree?: SplitNode } | null>(STORAGE_KEY, null);
  const tree = parsed?.centerTree;
  if (!tree) return [];
  const result: Array<{ tabId: string; paneId: string; isActive: boolean }> = [];
  for (const pane of allPanes(tree)) {
    for (const tab of pane.tabs) {
      if (tab.type === 'logviewer') {
        result.push({ tabId: tab.id, paneId: pane.id, isActive: tab.id === pane.activeTabId });
      }
    }
  }
  return result;
}

/**
 * Collect full editor tab data from persisted workspace state.
 * Reads per-tab localStorage keys. Used by Export and workspace Save.
 */
export function collectEditorTabs(): LtsEditorTabPayload[] {
  const parsed = storageGetJSON<{ centerTree?: SplitNode } | null>(STORAGE_KEY, null);
  if (!parsed?.centerTree) return [];

  const tabs: LtsEditorTabPayload[] = [];
  for (const pane of allPanes(parsed.centerTree)) {
    for (const tab of pane.tabs) {
      if (tab.type !== 'editor') continue;
      tabs.push({
        label: tab.label,
        content: storageGet(LS_CONTENT_PREFIX + tab.id) ?? '',
        viewMode: (storageGet(LS_MODE_PREFIX + tab.id) ?? 'editor') as LtsEditorTabPayload['viewMode'],
        wordWrap: storageGet(LS_WRAP_PREFIX + tab.id) === 'true',
        filePath: storageGet(LS_FILEPATH_PREFIX + tab.id) ?? null,
      });
    }
  }
  return tabs;
}

/**
 * Collect editor tabs already shaped as LtwEditorTab[] for save payloads.
 * Wraps collectEditorTabs with the field projection.
 */
export function collectEditorTabsForSave(): LtwEditorTab[] {
  return collectEditorTabs().map(t => ({
    label: t.label,
    content: t.content,
    viewMode: t.viewMode,
    wordWrap: t.wordWrap,
    filePath: t.filePath,
  }));
}

/**
 * Route a save payload to the correct backend command.
 * - Known .ltw path → saveWorkspaceV4 (explicit save path)
 * - No path → autoSaveWorkspace (app_data_dir, returns saved path)
 *
 * Returns the saved path if autoSaveWorkspace was used, null otherwise.
 */
export async function performAutoSave(payload: {
  workspaceName: string;
  filePath: string | null;
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
  pipelineChain: string[];
  disabledChainIds: string[];
}): Promise<string | null> {
  const { workspaceName, filePath, editorTabs, layout, pipelineChain, disabledChainIds } = payload;
  if (filePath) {
    await saveWorkspaceV4({ destPath: filePath, workspaceName, editorTabs, layout, pipelineChain, disabledChainIds });
    return null;
  }
  return autoSaveWorkspace({ workspaceName, editorTabs, layout, pipelineChain, disabledChainIds });
}

/**
 * Build an AppStateFile payload from workspace context state.
 * Shared between persistAppState and useAppExitSave.
 */
export function buildAppStatePayload(
  workspaces: ReadonlyArray<{ id: string; name: string; filePath: string | null; dirty: boolean }>,
  activeId: string | null,
): import('../../bridge/types').AppStateFile {
  return {
    workspaces: workspaces.map(w => ({
      id: w.id,
      name: w.name,
      ltwPath: w.filePath,
      dirty: w.dirty,
    })),
    activeWorkspaceId: activeId,
  };
}

/**
 * Map loaded editor tabs to layout:open-tab event payloads for restore.
 * Pure function extracted from doLoadWorkspace for testability.
 */
export function buildEditorTabEvents(tabs: LtwEditorTab[]): Array<{
  type: 'editor';
  label: string;
  filePath: string | undefined;
  editorState: EditorTabState;
}> {
  return tabs.map((t) => ({
    type: 'editor' as const,
    label: t.label,
    filePath: t.filePath ?? undefined,
    editorState: { content: t.content, viewMode: t.viewMode, wordWrap: t.wordWrap },
  }));
}
