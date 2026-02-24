import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { SearchQuery } from '../bridge/types';

interface ActionsContextValue {
  loadFile: (path: string) => Promise<void>;
  openFileDialog: () => Promise<void>;
  startStream: (deviceId: string) => Promise<void>;
  stopStream: () => Promise<void>;
  closeSession: () => void;
  runPipeline: () => Promise<void>;
  stopPipeline: () => void;
  clearResults: () => void;
  installProcessor: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => void;
  toggleProcessor: (id: string) => void;
  jumpToLine: (lineNum: number) => void;
  setSearch: (query: SearchQuery | null) => void;
  openTab: (type: string) => void;
}

const ActionsContext = createContext<ActionsContextValue | null>(null);

const noop = () => { /* stub */ };
const noopAsync = () => Promise.resolve();

export function ActionsProvider({ children }: { children: ReactNode }) {
  const loadFile = useCallback((_path: string) => noopAsync(), []);
  const openFileDialog = useCallback(() => noopAsync(), []);
  const startStream = useCallback((_deviceId: string) => noopAsync(), []);
  const stopStream = useCallback(() => noopAsync(), []);
  const closeSession = useCallback(noop, []);
  const runPipeline = useCallback(() => noopAsync(), []);
  const stopPipeline = useCallback(noop, []);
  const clearResults = useCallback(noop, []);
  const installProcessor = useCallback((_yaml: string) => noopAsync(), []);
  const removeProcessor = useCallback((_id: string) => noop(), []);
  const toggleProcessor = useCallback((_id: string) => noop(), []);
  const jumpToLine = useCallback((_lineNum: number) => noop(), []);
  const setSearch = useCallback((_query: SearchQuery | null) => noop(), []);
  const openTab = useCallback((_type: string) => noop(), []);

  const value = useMemo<ActionsContextValue>(() => ({
    loadFile,
    openFileDialog,
    startStream,
    stopStream,
    closeSession,
    runPipeline,
    stopPipeline,
    clearResults,
    installProcessor,
    removeProcessor,
    toggleProcessor,
    jumpToLine,
    setSearch,
    openTab,
  }), [loadFile, openFileDialog, startStream, stopStream, closeSession,
       runPipeline, stopPipeline, clearResults, installProcessor,
       removeProcessor, toggleProcessor, jumpToLine, setSearch, openTab]);

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
