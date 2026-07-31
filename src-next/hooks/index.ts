// Domain hooks — these own effects (bus/Tauri listeners, timers) and are
// instantiated EXACTLY ONCE, in context/HookWiring. Never mount them in a
// component: every extra instance duplicates every listener and timer inside.
export { useLogViewer } from './useLogViewer';
export type { LogViewerActions } from './useLogViewer';
export { usePipelineWiring } from './usePipelineWiring';
export { useStateTracker } from './useStateTracker';
export type { StateTrackerActions } from './useStateTracker';

// Effect-free action hooks — the mountable half of a domain. These hold no
// listeners, subscriptions or timers, so any number of components may mount
// them. New pipeline effects belong in usePipelineWiring, never here.
export { usePipelineCommands } from './usePipelineCommands';
export type { PipelineActions } from './usePipelineCommands';

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
export { useSettings, SETTING_DEFAULTS, DEFAULT_BOOKMARK_CATEGORIES, loadSettings, categoryColorToHex } from './useSettings';
export type { AppSettings, UseSettingsResult, BookmarkCategoryDef } from './useSettings';
export { useAnonymizerConfig } from './useAnonymizerConfig';
export type { UseAnonymizerConfigResult } from './useAnonymizerConfig';
export { useBookmarks, useBookmarkLines, useBookmarkLookup } from './useBookmarks';
export type { BookmarkState } from './useBookmarks';
export { useAnalysis } from './useAnalysis';
export type { AnalysisState } from './useAnalysis';
export { useWatchList } from './useWatchList';
export type { UseWatchListReturn } from './useWatchList';
export { useMarketplace } from './useMarketplace';
export type { MarketplaceState } from './useMarketplace';
export { useToast, nextToastId } from './useToast';
export { useAnalysisToast } from './useAnalysisToast';
export { useWatchToast } from './useWatchToast';
export { useLtsImportToast } from './useLtsImportToast';
export { useUntrustedAutoSaveToast } from './useUntrustedAutoSaveToast';
export { useWorkspaceRestore } from './useWorkspaceRestore';
export { useWorkspaceRestoreToast } from './useWorkspaceRestoreToast';
export { useFileShortcuts } from './useFileShortcuts';
export { useMcpStatus } from './useMcpStatus';
export type { McpConnState, McpStatusInfo } from './useMcpStatus';
export { useStatusBarSelection, useSelection } from './useStatusBarSelection';
export type { StatusBarSelection, SelectionMatch } from './useStatusBarSelection';
export { useCorrelatorResult } from './useCorrelatorResult';
export type { UseCorrelatorResultReturn } from './useCorrelatorResult';
export { useStartupFile } from './useStartupFile';
export { useStartupRestore } from './useStartupRestore';
export { useEditorTabRestore } from './useEditorTabRestore';
export { useWorkspace } from './useWorkspace';
export type { WorkspaceActions, SavePromptChoice } from './useWorkspace';
export { useWorkspaceAutoSave } from './useWorkspaceAutoSave';
export type { AutoSavePayload } from './useWorkspaceAutoSave';
export { useAppExitSave } from './useAppExitSave';
