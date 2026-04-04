// Domain hooks (instantiated once in context/HookWiring)
export { useLogViewer } from './useLogViewer';
export type { LogViewerActions } from './useLogViewer';
export { usePipeline } from './usePipeline';
export type { PipelineActions } from './usePipeline';
export { useStateTracker } from './useStateTracker';
export type { StateTrackerActions } from './useStateTracker';

// Component-local hooks
export { useTogglePane } from './useTogglePane';
export type { TogglePaneState } from './useTogglePane';
export { useWorkspaceLayout } from './useWorkspaceLayout';
export type {
  CenterTabType,
  BottomTabType,
  LeftPaneTab,
  RightPaneTab,
  LayoutPreset,
  Tab,
  CenterPane,
  SplitNode,
  WorkspaceLayoutState,
  DropZone,
} from './useWorkspaceLayout';
export { useSettings, SETTING_DEFAULTS, DEFAULT_BOOKMARK_CATEGORIES, loadSettings } from './useSettings';
export type { AppSettings, UseSettingsResult, BookmarkCategoryDef } from './useSettings';
export { useAnonymizerConfig } from './useAnonymizerConfig';
export type { UseAnonymizerConfigResult } from './useAnonymizerConfig';
export { useChartData } from './useChartData';
export { useFilter } from './useFilter';
export type { FilterState } from './useFilter';
export { useBookmarks, useBookmarkLines, useBookmarkLookup } from './useBookmarks';
export type { BookmarkState } from './useBookmarks';
export { useAnalysis } from './useAnalysis';
export type { AnalysisState } from './useAnalysis';
export { useWatches } from './useWatches';
export type { UseWatchesReturn } from './useWatches';
export { useMarketplace } from './useMarketplace';
export type { MarketplaceState } from './useMarketplace';
export { useToast } from './useToast';
export { useAnalysisToast } from './useAnalysisToast';
export { useWatchToast } from './useWatchToast';
export { useLtsImportToast } from './useLtsImportToast';
export { useWorkspaceRestore } from './useWorkspaceRestore';
export { useWorkspaceRestoreToast } from './useWorkspaceRestoreToast';
export { useFileShortcuts } from './useFileShortcuts';
export { useMcpStatus } from './useMcpStatus';
export type { McpConnState, McpStatusInfo } from './useMcpStatus';
export { useStatusBarSelection } from './useStatusBarSelection';
export type { StatusBarSelection } from './useStatusBarSelection';
export { useStartupFile } from './useStartupFile';
export { useEditorTabRestore } from './useEditorTabRestore';
