import type { BottomTabType, LeftPaneTab, RightPaneTab, SplitNode } from './workspaceTypes';
import {
  MIN_LEFT_WIDTH, MAX_LEFT_WIDTH,
  MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH,
  MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT,
  STORAGE_KEY,
  VALID_CENTER_TYPES, VALID_BOTTOM_TYPES, VALID_LEFT_TABS, VALID_RIGHT_TABS,
} from './workspaceTypes';
import { clamp, allPanes } from './splitTreeHelpers';

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

/** Sanitize a tree restored from localStorage. Strip unknown tab types, flatten corrupt nodes. */
export function sanitizeTree(node: SplitNode): SplitNode | null {
  if (!node || typeof node !== 'object') return null;

  if (node.type === 'leaf') {
    if (!node.pane || !Array.isArray(node.pane.tabs)) return null;
    const tabs = node.pane.tabs
      .filter((t) => VALID_CENTER_TYPES.has(t.type))
      .map((t) => ({ ...t, closable: true }));
    // Empty panes are valid (the default state is an empty leaf)
    const activeTabId = tabs.find((t) => t.id === node.pane.activeTabId)
      ? node.pane.activeTabId
      : (tabs[0]?.id ?? '');
    return { ...node, pane: { ...node.pane, tabs, activeTabId } };
  }

  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length !== 2) return null;
    const left = sanitizeTree(node.children[0]);
    const right = sanitizeTree(node.children[1]);
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedState;
    const result: Partial<PersistedState> = {};

    if (parsed.centerTree) {
      const sanitized = sanitizeTree(parsed.centerTree);
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
  } catch {
    return {};
  }
}

export function savePersistedState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage full */ }
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { centerTree?: SplitNode };
    const tree = parsed?.centerTree;
    if (!tree) return null;
    function firstPaneId(node: SplitNode): string | null {
      if (node.type === 'leaf') return node.pane.id;
      return firstPaneId(node.children[0]);
    }
    return firstPaneId(tree);
  } catch {
    return null;
  }
}

/**
 * Returns all persisted logviewer tabs across all panes, with their pane ID
 * and whether each tab is currently active. Used by useLogViewer's startup
 * restore to reload all open files, not just the last-focused one.
 */
export function getStoredLogviewerTabs(): Array<{ tabId: string; paneId: string; isActive: boolean }> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { centerTree?: SplitNode };
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
  } catch {
    return [];
  }
}
