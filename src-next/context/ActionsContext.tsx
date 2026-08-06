import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { bus } from '../events';
import type { AnalysisArtifact, AnalysisSection, ExportAllOptions, ProcessorSummary, SourceType } from '../bridge/types';

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
  /** `sourceType` overrides backend content detection for this open. Used by the
   *  File Info panel's "reopen as" affordance to correct a misdetection — the
   *  type cannot be changed in place because the line index is already built
   *  with the parser it selects. */
  loadFile: (
    path: string,
    paneId?: string,
    existingTabId?: string,
    sourceType?: SourceType,
    /** Replace the pane's current session rather than adding a tab beside it.
     *  Stated explicitly because the alternative — inferring it from a ref that
     *  has not re-rendered yet — is what appended duplicate tabs. */
    replace?: boolean,
    /** Correlation id a workspace restore stamps on its own loads so the
     *  resulting `session:loaded` event(s) can be told apart from an unrelated
     *  concurrent open (see `hooks/workspace/restoreCore.ts`). */
    loadRequestId?: string,
  ) => Promise<void>;
  startStream: (deviceId?: string) => Promise<void>;
  closeSession: (paneId?: string) => Promise<void>;

  // Processor library
  installProcessor: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => Promise<void>;
  loadProcessorFromFile: (filePath: string) => Promise<ProcessorSummary>;

  // Pipeline chain. `sessionId` selects whose chain is edited; omitting it (or
  // passing null) targets the shared default that new sessions inherit.
  addToChain: (id: string, sessionId?: string | null) => void;
  addPackToChain: (processorIds: string[], sessionId?: string | null) => void;
  removeFromChain: (id: string, sessionId?: string | null) => void;
  reorderChain: (fromIndex: number, toIndex: number, sessionId?: string | null) => void;
  toggleChainEnabled: (id: string, sessionId?: string | null) => void;

  // Workspace lifecycle (save/open handle their own clean/dirty transitions)
  newWorkspace: () => void;
  openWorkspace: (path?: string) => void;
  saveWorkspace: () => Promise<void>;
  saveWorkspaceAs: () => Promise<void>;
  closeWorkspace: (targetId: string) => void;
  switchWorkspace: (targetId: string) => void;

  // Analysis mutations. These are workspace-owned artifacts (not per-session),
  // but their durability is split from the rest of WorkspaceMutationActions:
  // the backend's `schedule_autosave` already writes the `.ltw` on every
  // artifact mutation (bookmark or analysis, including MCP-bridge-originated
  // ones), so the frontend must NOT duplicate that write. `trackMutations()`
  // tags these with `ARTIFACT_MUTATION_ACTION_KEYS` instead of
  // `MUTATION_ACTION_KEYS` — the emitted `workspace:mutated` carries
  // `source: 'artifact'`, which tells `useWorkspaceAutoSave` to push a
  // refreshed envelope to the backend's cache instead of running its own
  // `.ltw` write. See context/CLAUDE.md's "Backend-originated mutations".
  publishAnalysis: (
    title: string, sections: AnalysisSection[], sessionId?: string,
  ) => Promise<AnalysisArtifact | null>;
  updateAnalysis: (
    artifactId: string, title?: string, sections?: AnalysisSection[],
  ) => Promise<AnalysisArtifact | null>;
  deleteAnalysis: (artifactId: string) => Promise<void>;
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
  /** Scroll a pane (or the focused pane when `paneId` is omitted) to a line.
   *  Per-pane search navigation (`PaneSearchContext`) jumps through this.
   *  `sessionId` targets the viewer hosting that session and takes precedence
   *  over `paneId` — session-scoped panels (dashboard, bookmarks, timeline,
   *  correlations, analyses) pass it so only their session's viewer moves. */
  jumpToLine: (lineNum: number, paneId?: string, sessionId?: string) => void;
  setStreamFilter: (expr: string) => Promise<void>;
  cancelStreamFilter: () => void;
  setTimeFilter: (start: string, end: string) => Promise<void>;
  openTab: (type: string) => void;
  /** Opens (or reuses) the workspace-wide analysis tab and targets it at
   *  `artifactId` — routes through `layout:open-tab` so the tab's resolved
   *  pane id can be paired with a targeted `analysis:open` event. */
  openAnalysis: (artifactId: string) => void;
  setActiveLogPane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  exportSession: () => void;

  // System / export actions
  setFileAssociation: (ext: string, enabled: boolean) => Promise<void>;
  openDefaultAppsSettings: () => Promise<void>;
  startMcpBridge: () => Promise<void>;
  stopMcpBridge: () => Promise<void>;
  setMcpOpenAllowlist: (dirs: string[], allowAll: boolean) => Promise<void>;
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
 * Names of the analysis actions — artifact mutations whose `.ltw` durability
 * is already owned by the backend (`schedule_autosave` in
 * `artifact_mutations.rs`). `trackMutations()` wraps these with
 * `markDirty()` + `bus.emit('workspace:mutated', { source: 'artifact' })`
 * instead of `source: 'workspace'`, so `useWorkspaceAutoSave` only pushes a
 * refreshed envelope rather than duplicating the backend's `.ltw` write.
 *
 * MUST stay disjoint from `MUTATION_ACTION_KEYS` — a key in both would fire
 * `workspace:mutated` twice (once per source) for a single action.
 */
export const ARTIFACT_MUTATION_ACTION_KEYS: ReadonlySet<keyof WorkspaceMutationActions> = new Set([
  'publishAnalysis',
  'updateAnalysis',
  'deleteAnalysis',
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
 * This is the single enforcement point for both halves of the dirty signal:
 * `markDirty()` updates the WorkspaceContext flag (title bar, close prompt),
 * and `workspace:mutated` schedules the debounced auto-save.
 *
 * These used to diverge — `trackMutations` called only `markDirty`, while
 * `useWorkspaceAutoSave` subscribes only to the bus. The result was that
 * opening a file, editing the pipeline chain, or installing a processor marked
 * the workspace dirty and then never persisted it. Only session-layer
 * mutations (bookmarks, analyses) reached the auto-saver.
 *
 * Restore paths bracket their work in `workspace:restore-begin`/`-end`, which
 * suppresses auto-save so a restore does not immediately re-persist itself.
 *
 * `ARTIFACT_MUTATION_ACTION_KEYS` (analysis mutations) are wrapped the same
 * way but emit `source: 'artifact'` — the backend already owns their `.ltw`
 * write, so `useWorkspaceAutoSave` only refreshes the envelope for these
 * instead of running its own `.ltw` write. See that registry's doc comment.
 */
export function trackMutations(
  actions: Partial<ActionsContextValue>,
  markDirty: () => void,
): Partial<ActionsContextValue> {
  const onMutateWorkspace = () => {
    markDirty();
    bus.emit('workspace:mutated', { source: 'workspace' });
  };
  const onMutateArtifact = () => {
    markDirty();
    bus.emit('workspace:mutated', { source: 'artifact' });
  };
  const result = { ...actions } as Record<string, unknown>;
  for (const key of MUTATION_ACTION_KEYS) {
    const fn = actions[key];
    if (typeof fn === 'function') {
      result[key] = tracked(fn as (...args: never[]) => unknown, onMutateWorkspace);
    }
  }
  for (const key of ARTIFACT_MUTATION_ACTION_KEYS) {
    const fn = actions[key];
    if (typeof fn === 'function') {
      result[key] = tracked(fn as (...args: never[]) => unknown, onMutateArtifact);
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
  closeWorkspace: (_targetId: string) => noop(),
  switchWorkspace: (_targetId: string) => noop(),
  publishAnalysis: (_title: string, _sections: AnalysisSection[], _sessionId?: string) => Promise.resolve(null),
  updateAnalysis: (_artifactId: string, _title?: string, _sections?: AnalysisSection[]) => Promise.resolve(null),
  deleteAnalysis: (_artifactId: string) => noopAsync(),

  // View actions
  openFileDialog: () => noopAsync(),
  openInEditorDialog: () => noopAsync(),
  stopStream: () => noopAsync(),
  runPipeline: () => noopAsync(),
  stopPipeline: noop,
  clearResults: noop,
  jumpToLine: (_lineNum: number, _paneId?: string, _sessionId?: string) => noop(),
  setStreamFilter: (_expr: string) => noopAsync(),
  cancelStreamFilter: noop,
  setTimeFilter: (_start: string, _end: string) => noopAsync(),
  openTab: (_type: string) => noop(),
  openAnalysis: (_artifactId: string) => noop(),
  setActiveLogPane: (_paneId: string) => noop(),
  setActivePane: (_paneId: string) => noop(),
  saveFile: () => noopAsync(),
  saveFileAs: () => noopAsync(),
  exportSession: noop,

  // System / export actions
  setFileAssociation: (_ext: string, _enabled: boolean) => noopAsync(),
  openDefaultAppsSettings: () => noopAsync(),
  startMcpBridge: () => noopAsync(),
  stopMcpBridge: () => noopAsync(),
  setMcpOpenAllowlist: (_dirs: string[], _allowAll: boolean) => noopAsync(),
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
