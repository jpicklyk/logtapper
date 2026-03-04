// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CenterTabType = 'logviewer' | 'dashboard' | 'scratch' | 'editor' | 'analysis';
export type BottomTabType = 'timeline' | 'correlations' | 'search-results' | 'watches' | 'filter-results';
export type LeftPaneTab = 'info' | 'state' | 'bookmarks' | 'analysis';
export type RightPaneTab = 'processors' | 'marketplace';
export type LayoutPreset = 'compact' | 'standard' | 'wide';
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface Tab {
  id: string;
  type: CenterTabType;
  label: string;
  closable: boolean;
}

export interface CenterPane {
  id: string;
  tabs: Tab[];
  activeTabId: string;
}

export type SplitNode =
  | { type: 'leaf'; id: string; pane: CenterPane }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: [SplitNode, SplitNode]; ratio: number };

export interface WorkspaceLayoutState {
  // Left pane
  leftPaneWidth: number;
  leftPaneTab: LeftPaneTab;
  setLeftPaneTab: (tab: LeftPaneTab) => void;
  resizeLeftPane: (delta: number) => void;

  // Center area
  centerTree: SplitNode;
  reorderTab: (paneId: string, fromIndex: number, toIndex: number) => void;
  closeTab: (tabId: string, paneId: string) => void;
  setActiveTab: (tabId: string, paneId: string) => void;
  addCenterTab: (paneId: string, type: CenterTabType, label?: string) => void;
  resizeSplit: (splitNodeId: string, ratio: number) => void;
  renameTab: (tabId: string, label: string) => void;
  openCenterTab: (type: CenterTabType, label?: string) => void;
  dropTabOnPane: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;

  // Right pane
  rightPaneVisible: boolean;
  rightPaneWidth: number;
  rightPaneTab: RightPaneTab;
  toggleRightPane: (tab?: RightPaneTab) => void;
  resizeRightPane: (delta: number) => void;

  // Bottom pane
  bottomPaneVisible: boolean;
  bottomPaneHeight: number;
  bottomPaneTab: BottomTabType;
  toggleBottomPane: (tab?: BottomTabType) => void;
  resizeBottomPane: (delta: number) => void;
  openBottomTab: (tab: BottomTabType) => void;

  // General
  preset: LayoutPreset;
  containerRef: React.RefObject<HTMLDivElement>;
  resetLayout: () => void;

  // Focus tracking — updated directly on every tab/pane activation (no bus event)
  focusedPaneId: string | null;
  setFocusedPaneId: (paneId: string) => void;
  /** Focus a specific logviewer tab as the active session source. Sets both
   *  focusedPaneId and focusedLogviewerTabId in one call. */
  focusLogviewerTab: (tabId: string, paneId: string) => void;
  /** Active tab type in the focused pane, or null if no pane is focused. */
  focusedActiveTabType: CenterTabType | null;
  /** The specific logviewer tab that owns the focused session.
   *  Only this tab shows the blue underline focus marker. */
  focusedLogviewerTabId: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_LEFT_WIDTH = 140;
export const MAX_LEFT_WIDTH = 420;
export const DEFAULT_LEFT_WIDTH = 220;

export const MIN_RIGHT_WIDTH = 220;
export const MAX_RIGHT_WIDTH = 600;
export const DEFAULT_RIGHT_WIDTH = 300;

export const MIN_BOTTOM_HEIGHT = 100;
export const MAX_BOTTOM_HEIGHT = 500;
export const DEFAULT_BOTTOM_HEIGHT = 200;

export const COMPACT_LEFT_WIDTH = 40;

export const STORAGE_KEY = 'logtapper_workspace_v1';

export const VALID_CENTER_TYPES = new Set<string>(['logviewer', 'dashboard', 'scratch', 'editor', 'analysis']);
export const VALID_BOTTOM_TYPES = new Set<string>(['timeline', 'correlations', 'search-results', 'watches', 'filter-results']);
export const VALID_LEFT_TABS = new Set<string>(['info', 'state', 'bookmarks', 'analysis']);
export const VALID_RIGHT_TABS = new Set<string>(['processors', 'marketplace']);

export const TAB_LABELS: Record<CenterTabType, string> = {
  logviewer: 'Log',
  dashboard: 'Dashboard',
  scratch: 'Scratch',
  editor: 'Editor',
  analysis: 'Analysis',
};
