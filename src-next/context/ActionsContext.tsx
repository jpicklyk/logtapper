import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { SearchQuery, ExportAllOptions, ProcessorSummary } from '../bridge/types';

// ---------------------------------------------------------------------------
// Action categories
// ---------------------------------------------------------------------------

/**
 * Workspace mutations — actions that change what the workspace contains.
 * These are automatically wrapped with dirty tracking by the workspace
 * orchestrator. Adding an action here is sufficient to get tracking.
 */
export interface WorkspaceMutationActions {
  // Session lifecycle
  loadFile: (path: string, paneId?: string) => Promise<void>;
  startStream: (deviceId?: string) => Promise<void>;
  closeSession: (paneId?: string) => Promise<void>;

  // Processor library
  installProcessor: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => Promise<void>;
  loadProcessorFromFile: (filePath: string) => Promise<ProcessorSummary>;

  // Pipeline chain
  addToChain: (id: string) => void;
  addPackToChain: (processorIds: string[]) => void;
  removeFromChain: (id: string) => void;
  reorderChain: (fromIndex: number, toIndex: number) => void;
  toggleChainEnabled: (id: string) => void;

  // Workspace lifecycle (save/open handle their own clean/dirty transitions)
  newWorkspace: () => void;
  openWorkspace: (path?: string) => void;
  saveWorkspace: () => Promise<void>;
  saveWorkspaceAs: () => Promise<void>;
  closeWorkspace: () => void;
  switchWorkspace: (targetId: string) => void;
}

/**
 * Non-mutation actions — navigation, search, focus, execution, system, UI state.
 * These do NOT mark the workspace dirty. The name "ViewActions" is historical;
 * the interface includes system operations (MCP bridge, file associations) and
 * file I/O (save, export) alongside true view actions (jump, search, focus).
 * The grouping criterion is: not tracked by `trackMutations()`.
 */
export interface ViewActions {
  openFileDialog: () => Promise<void>;
  openInEditorDialog: () => Promise<void>;
  stopStream: () => Promise<void>;
  runPipeline: () => Promise<void>;
  stopPipeline: () => void;
  clearResults: () => void;
  jumpToLine: (lineNum: number, paneId?: string) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  setSearch: (query: SearchQuery | null) => void;
  setStreamFilter: (expr: string) => Promise<void>;
  cancelStreamFilter: () => void;
  openTab: (type: string) => void;
  setActiveLogPane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  setEffectiveLineNums: (lineNums: number[] | null) => void;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  exportSession: () => void;

  // System / export actions
  setFileAssociation: (ext: string, enabled: boolean) => Promise<void>;
  openDefaultAppsSettings: () => Promise<void>;
  startMcpBridge: () => Promise<void>;
  stopMcpBridge: () => Promise<void>;
  exportAllSessions: (options: ExportAllOptions) => Promise<void>;
}

export interface ActionsContextValue extends WorkspaceMutationActions, ViewActions {}

// ---------------------------------------------------------------------------
// Tracked wrapper — the enforcement mechanism
// ---------------------------------------------------------------------------

/**
 * Names of all WorkspaceMutationActions keys. Used by `trackMutations()`
 * to know which actions to wrap. If you add a new mutation action, add
 * its key here — this is the single source of truth for dirty tracking.
 */
export const MUTATION_ACTION_KEYS: ReadonlySet<keyof WorkspaceMutationActions> = new Set([
  'loadFile',
  'startStream',
  'closeSession',
  'installProcessor',
  'removeProcessor',
  'loadProcessorFromFile',
  'addToChain',
  'addPackToChain',
  'removeFromChain',
  'reorderChain',
  'toggleChainEnabled',
  // Workspace lifecycle actions handle their own clean/dirty transitions,
  // so they are NOT in this set. They call markClean/resetIdentity directly.
] as const);

/**
 * Wraps a function so that `onMutate` is called after it completes.
 * For async functions, fires after the promise resolves.
 */
export function tracked<T extends (...args: never[]) => unknown>(
  fn: T,
  onMutate: () => void,
): T {
  return ((...args: Parameters<T>) => {
    const result = fn(...args);
    if (result instanceof Promise) {
      return result.then((r) => { onMutate(); return r; });
    }
    onMutate();
    return result;
  }) as unknown as T;
}

/**
 * Takes raw action implementations and wraps all mutation actions with
 * automatic dirty tracking. View actions pass through unchanged.
 *
 * This is the single enforcement point — no scattered bus emissions needed.
 */
export function trackMutations(
  actions: Partial<ActionsContextValue>,
  markDirty: () => void,
): Partial<ActionsContextValue> {
  const result = { ...actions } as Record<string, unknown>;
  for (const key of MUTATION_ACTION_KEYS) {
    const fn = actions[key];
    if (typeof fn === 'function') {
      result[key] = tracked(fn as (...args: never[]) => unknown, markDirty);
    }
  }
  return result as Partial<ActionsContextValue>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const noop = () => { /* stub */ };
const noopAsync = () => Promise.resolve();

const DEFAULT_ACTIONS: ActionsContextValue = {
  // Mutations
  loadFile: (_path: string, _paneId?: string) => noopAsync(),
  startStream: (_deviceId?: string) => noopAsync(),
  closeSession: (_paneId?: string) => noopAsync(),
  installProcessor: (_yaml: string) => noopAsync(),
  removeProcessor: (_id: string) => noopAsync(),
  loadProcessorFromFile: (_filePath: string) => Promise.resolve({} as ProcessorSummary),
  addToChain: (_id: string) => noop(),
  addPackToChain: (_processorIds: string[]) => noop(),
  removeFromChain: (_id: string) => noop(),
  reorderChain: (_fromIndex: number, _toIndex: number) => noop(),
  toggleChainEnabled: (_id: string) => noop(),
  newWorkspace: noop,
  openWorkspace: (_path?: string) => noop(),
  saveWorkspace: () => noopAsync(),
  saveWorkspaceAs: () => noopAsync(),
  closeWorkspace: noop,
  switchWorkspace: (_targetId: string) => noop(),

  // View actions
  openFileDialog: () => noopAsync(),
  openInEditorDialog: () => noopAsync(),
  stopStream: () => noopAsync(),
  runPipeline: () => noopAsync(),
  stopPipeline: noop,
  clearResults: noop,
  jumpToLine: (_lineNum: number, _paneId?: string) => noop(),
  jumpToMatch: (_direction: 1 | -1) => noop(),
  setSearch: (_query: SearchQuery | null) => noop(),
  setStreamFilter: (_expr: string) => noopAsync(),
  cancelStreamFilter: noop,
  openTab: (_type: string) => noop(),
  setActiveLogPane: (_paneId: string) => noop(),
  setActivePane: (_paneId: string) => noop(),
  setEffectiveLineNums: (_lineNums: number[] | null) => noop(),
  saveFile: () => noopAsync(),
  saveFileAs: () => noopAsync(),
  exportSession: noop,

  // System / export actions
  setFileAssociation: (_ext: string, _enabled: boolean) => noopAsync(),
  openDefaultAppsSettings: () => noopAsync(),
  startMcpBridge: () => noopAsync(),
  stopMcpBridge: () => noopAsync(),
  exportAllSessions: (_options: ExportAllOptions) => noopAsync(),
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
