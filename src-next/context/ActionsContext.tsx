import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { SearchQuery } from '../bridge/types';

export interface ActionsContextValue {
  loadFile: (path: string, paneId?: string) => Promise<void>;
  openFileDialog: () => Promise<void>;
  startStream: (deviceId?: string) => Promise<void>;
  stopStream: () => Promise<void>;
  closeSession: (paneId?: string) => Promise<void>;
  runPipeline: () => Promise<void>;
  stopPipeline: () => void;
  clearResults: () => void;
  installProcessor: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => void;
  toggleProcessor: (id: string) => void;
  jumpToLine: (lineNum: number, paneId?: string) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  setSearch: (query: SearchQuery | null) => void;
  setStreamFilter: (expr: string) => Promise<void>;
  cancelStreamFilter: () => void;
  openInEditorDialog: () => Promise<void>;
  openTab: (type: string) => void;
  /** Focus a specific log pane, updating SessionContext and emitting session:focused. */
  setActiveLogPane: (paneId: string) => void;
  /** Mark any pane as the active pane for save routing (does not affect session focus). */
  setActivePane: (paneId: string) => void;
  /**
   * Called by PaneContent on every render to keep effectiveLineNumsRef in sync.
   * Enables search navigation to scope results to the currently visible lines.
   */
  setEffectiveLineNums: (lineNums: number[] | null) => void;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  exportSession: () => void;
}

const noop = () => { /* stub */ };
const noopAsync = () => Promise.resolve();

const DEFAULT_ACTIONS: ActionsContextValue = {
  loadFile: (_path: string, _paneId?: string) => noopAsync(),
  openFileDialog: () => noopAsync(),
  startStream: (_deviceId?: string) => noopAsync(),
  stopStream: () => noopAsync(),
  closeSession: (_paneId?: string) => noopAsync(),
  runPipeline: () => noopAsync(),
  stopPipeline: noop,
  clearResults: noop,
  installProcessor: (_yaml: string) => noopAsync(),
  removeProcessor: (_id: string) => noop(),
  toggleProcessor: (_id: string) => noop(),
  jumpToLine: (_lineNum: number, _paneId?: string) => noop(),
  jumpToMatch: (_direction: 1 | -1) => noop(),
  setSearch: (_query: SearchQuery | null) => noop(),
  setStreamFilter: (_expr: string) => noopAsync(),
  cancelStreamFilter: noop,
  openInEditorDialog: () => noopAsync(),
  openTab: (_type: string) => noop(),
  setActiveLogPane: (_paneId: string) => noop(),
  setActivePane: (_paneId: string) => noop(),
  setEffectiveLineNums: (_lineNums: number[] | null) => noop(),
  saveFile: () => noopAsync(),
  saveFileAs: () => noopAsync(),
  exportSession: noop,
};

const ActionsContext = createContext<ActionsContextValue | null>(null);

interface ActionsProviderProps {
  actions?: Partial<ActionsContextValue>;
  children: ReactNode;
}

/**
 * Provides action callbacks to the app.
 * Accepts injected actions via props — real implementations from hooks
 * override the default stubs.
 */
export function ActionsProvider({ actions, children }: ActionsProviderProps) {
  const value = useMemo<ActionsContextValue>(() => ({
    ...DEFAULT_ACTIONS,
    ...actions,
  }), [actions]);

  return (
    <ActionsContext.Provider value={value}>
      {children}
    </ActionsContext.Provider>
  );
}

export function useActionsContext(): ActionsContextValue {
  const ctx = useContext(ActionsContext);
  if (!ctx) {
    throw new Error('useActionsContext must be used within an ActionsProvider');
  }
  return ctx;
}
