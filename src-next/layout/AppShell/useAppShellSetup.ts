import { useCallback, useEffect, useState } from 'react';
import {
  useSettings,
  useAnonymizerConfig,
  useToast,
  useAnalysisToast,
  useWatchToast,
  useWorkspaceRestoreToast,
  useLtsImportToast,
  useFileShortcuts,
  useStartupFile,
  useEditorTabRestore,
} from '../../hooks';
import { useFileActions, useWorkspaceActions } from '../../context';
import { startMcpBridge } from '../../bridge/commands';
import { bus } from '../../events';
import type { WorkspaceLayoutState } from '../../hooks';

interface UseAppShellSetupParams {
  openCenterTab: WorkspaceLayoutState['openCenterTab'];
}

export function useAppShellSetup({ openCenterTab }: UseAppShellSetupParams) {
  const settingsHook = useSettings();
  const anonymizerConfig = useAnonymizerConfig();
  const { toasts, addToast, dismissToast } = useToast();
  useAnalysisToast(addToast);
  useWatchToast(addToast);
  useWorkspaceRestoreToast(addToast);
  useLtsImportToast(addToast);

  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const handler = () => { setSettingsOpen(true); };
    bus.on('layout:settings-requested', handler);
    return () => { bus.off('layout:settings-requested', handler); };
  }, []);

  // Start MCP bridge on mount if the user has it enabled.
  useEffect(() => {
    if (settingsHook.settings.mcpBridgeEnabled) {
      startMcpBridge().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — run once on mount only

  const { openFileDialog, openInEditorDialog, saveFile, saveFileAs, exportSession } = useFileActions();
  const { newWorkspace, saveWorkspace } = useWorkspaceActions();
  useFileShortcuts({ openFileDialog, openInEditorDialog, saveFile, saveFileAs, exportSession, newWorkspace, saveWorkspace });
  useStartupFile();
  useEditorTabRestore(openCenterTab);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return {
    settingsHook,
    anonymizerConfig,
    settingsOpen,
    closeSettings,
    toasts,
    dismissToast,
  };
}
