import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { SearchQuery } from '../bridge/types';

export interface ActionsContextValue {
  loadFile: (path: string) => Promise<void>;
  openFileDialog: () => Promise<void>;
  startStream: (deviceId?: string) => Promise<void>;
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

const noop = () => { /* stub */ };
const noopAsync = () => Promise.resolve();

const DEFAULT_ACTIONS: ActionsContextValue = {
  loadFile: (_path: string) => noopAsync(),
  openFileDialog: () => noopAsync(),
  startStream: (_deviceId?: string) => noopAsync(),
  stopStream: () => noopAsync(),
  closeSession: noop,
  runPipeline: () => noopAsync(),
  stopPipeline: noop,
  clearResults: noop,
  installProcessor: (_yaml: string) => noopAsync(),
  removeProcessor: (_id: string) => noop(),
  toggleProcessor: (_id: string) => noop(),
  jumpToLine: (_lineNum: number) => noop(),
  setSearch: (_query: SearchQuery | null) => noop(),
  openTab: (_type: string) => noop(),
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
