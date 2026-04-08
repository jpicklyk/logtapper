import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { ProcessorSummary, PipelineRunSummary, PackSummary } from '../bridge/types';

/** Processor IDs that must always remain at the tail of the chain. */
export const PINNED_TAIL_IDS = new Set(['__pii_anonymizer']);

// ── Per-session pipeline state ──────────────────────────────────────────────

export interface SessionPipelineState {
  results: PipelineRunSummary[];
  runCount: number;
  running: boolean;
  progress: { current: number; total: number } | null;
  error: string | null;
}

const DEFAULT_SESSION_STATE: SessionPipelineState = {
  results: [],
  runCount: 0,
  running: false,
  progress: null,
  error: null,
};

/** Returns the session's pipeline state or the stable default if absent. */
function getOrDefault(map: Map<string, SessionPipelineState>, sessionId: string | null): SessionPipelineState {
  if (!sessionId) return DEFAULT_SESSION_STATE;
  return map.get(sessionId) ?? DEFAULT_SESSION_STATE;
}

/** Set processor result counts (backend sends accumulated totals during streaming). */
function mergeProcessorResult(
  s: SessionPipelineState,
  processorId: string,
  matchedLines: number,
  emissionCount: number,
): SessionPipelineState {
  const idx = s.results.findIndex((r) => r.processorId === processorId);
  const updated = { processorId, matchedLines, emissionCount };
  const results = idx >= 0
    ? s.results.map((r, i) => i === idx ? updated : r)
    : [...s.results, updated];
  return { ...s, results };
}

/** Returns a new Map with the session entry updated. */
function withSessionState(
  map: Map<string, SessionPipelineState>,
  sessionId: string,
  updater: (prev: SessionPipelineState) => SessionPipelineState,
): Map<string, SessionPipelineState> {
  const next = new Map(map);
  next.set(sessionId, updater(getOrDefault(map, sessionId)));
  return next;
}

// ── State ─────────────────────────────────────────────────────────────────────

interface PipelineState {
  processors: ProcessorSummary[];
  packs: PackSummary[];
  pipelineChain: string[];
  /** Processor IDs present in the chain but excluded from execution. */
  disabledChainIds: string[];
  /** Enabled subset of pipelineChain — kept as a separate field for selector stability. */
  activeProcessorIds: string[];
  /** Per-session pipeline results, keyed by sessionId. */
  resultsBySession: Map<string, SessionPipelineState>;
  /** Global error (processor install/remove failures — not per-session). */
  error: string | null;
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type PipelineAction =
  // Run lifecycle — each action encodes a valid transition
  | { type: 'run:started'; sessionId: string }
  | { type: 'run:progress'; sessionId: string; current: number; total: number }
  | { type: 'run:complete'; sessionId: string; results: PipelineRunSummary[]; newRunCount: number }
  | { type: 'run:failed'; sessionId: string; error: string }
  | { type: 'run:stopped'; sessionId: string }
  // Results management
  | { type: 'results:cleared'; sessionId: string }
  | { type: 'pre-load:cleared'; sessionId: string }
  // Session cleanup
  | { type: 'session:removed'; sessionId: string }
  // Processor library
  | { type: 'processors:loaded'; processors: ProcessorSummary[]; initialChain?: string[]; initialDisabled?: string[] }
  | { type: 'processor:installed'; processor: ProcessorSummary }
  | { type: 'processor:removed'; id: string }
  | { type: 'packs:loaded'; packs: PackSummary[] }
  // Chain management (PINNED_TAIL_IDS logic lives in the reducer, not at call sites)
  | { type: 'chain:add'; id: string }
  | { type: 'chain:add-pack'; processorIds: string[] }
  | { type: 'chain:remove'; id: string }
  | { type: 'chain:reorder'; fromIndex: number; toIndex: number }
  | { type: 'chain:toggle-enabled'; id: string }
  // Workspace restore — override entire chain with saved state
  | { type: 'chain:restore'; chain: string[]; disabledChainIds: string[] }
  // ADB streaming incremental updates
  | { type: 'adb:results-update'; sessionId: string; processorId: string; matchedLines: number; emissionCount: number }
  | { type: 'adb:results-batch'; updates: Array<{ sessionId: string; processorId: string; matchedLines: number; emissionCount: number }> }
  | { type: 'adb:run-count-bump'; sessionId: string }
  // Error management
  | { type: 'error:set'; error: string }
  | { type: 'error:clear' };

// ── Reducer ───────────────────────────────────────────────────────────────────

const initialState: PipelineState = {
  processors: [],
  packs: [],
  pipelineChain: [],
  disabledChainIds: [],
  activeProcessorIds: [],
  resultsBySession: new Map(),
  error: null,
};

/** Apply a new chain value and keep activeProcessorIds in sync. */
function withChain(state: PipelineState, chain: string[], disabledChainIds?: string[]): PipelineState {
  const disabled = disabledChainIds ?? state.disabledChainIds;
  const disabledSet = new Set(disabled);
  return {
    ...state,
    pipelineChain: chain,
    disabledChainIds: disabled,
    activeProcessorIds: chain.filter((id) => !disabledSet.has(id)),
  };
}

function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    // ── Run lifecycle ────────────────────────────────────────────────────────
    case 'run:started':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, running: true, progress: null, error: null,
        })),
      };

    case 'run:progress':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, progress: { current: action.current, total: action.total },
        })),
      };

    case 'run:complete':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, running: false, progress: null, results: action.results, runCount: action.newRunCount,
        })),
      };

    case 'run:failed':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, running: false, error: action.error,
        })),
      };

    case 'run:stopped':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, running: false,
        })),
      };

    // ── Results ──────────────────────────────────────────────────────────────
    case 'results:cleared':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, results: [], progress: null,
        })),
      };

    case 'pre-load:cleared':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, results: [], progress: null, error: null,
        })),
      };

    // ── Session cleanup ───────────────────────────────────────────────────────
    case 'session:removed': {
      if (!state.resultsBySession.has(action.sessionId)) return state;
      const next = new Map(state.resultsBySession);
      next.delete(action.sessionId);
      return { ...state, resultsBySession: next };
    }

    // ── Processor library ────────────────────────────────────────────────────
    case 'processors:loaded': {
      const next = { ...state, processors: action.processors };
      return action.initialChain !== undefined
        ? withChain(next, action.initialChain, action.initialDisabled ?? [])
        : next;
    }

    case 'processor:installed': {
      const without = state.processors.filter((p) => p.id !== action.processor.id);
      const processors = [...without, action.processor].sort((a, b) => a.name.localeCompare(b.name));
      return { ...state, processors };
    }

    case 'processor:removed': {
      const processors = state.processors.filter((p) => p.id !== action.id);
      const chain = state.pipelineChain.filter((id) => id !== action.id);
      const nextDisabled = state.disabledChainIds.filter((id) => id !== action.id);
      return withChain({ ...state, processors }, chain, nextDisabled);
    }

    case 'packs:loaded':
      return { ...state, packs: action.packs };

    // ── Chain management ─────────────────────────────────────────────────────
    case 'chain:add': {
      if (state.pipelineChain.includes(action.id)) return state;
      let chain: string[];
      if (PINNED_TAIL_IDS.has(action.id)) {
        chain = [...state.pipelineChain, action.id];
      } else {
        const firstPinned = state.pipelineChain.findIndex((x) => PINNED_TAIL_IDS.has(x));
        chain = firstPinned !== -1
          ? [...state.pipelineChain.slice(0, firstPinned), action.id, ...state.pipelineChain.slice(firstPinned)]
          : [...state.pipelineChain, action.id];
      }
      return withChain(state, chain);
    }

    case 'chain:add-pack': {
      // Add all processor IDs not already in the chain, respecting PINNED_TAIL_IDS position
      const newIds = action.processorIds.filter(
        (id) => !state.pipelineChain.includes(id) && !PINNED_TAIL_IDS.has(id),
      );
      // Also handle any pinned IDs in the pack (unlikely, but safe)
      const newPinned = action.processorIds.filter(
        (id) => !state.pipelineChain.includes(id) && PINNED_TAIL_IDS.has(id),
      );
      if (newIds.length === 0 && newPinned.length === 0) return state;
      const firstPinned = state.pipelineChain.findIndex((id) => PINNED_TAIL_IDS.has(id));
      const insertAt = firstPinned >= 0 ? firstPinned : state.pipelineChain.length;
      const newChain = [
        ...state.pipelineChain.slice(0, insertAt),
        ...newIds,
        ...state.pipelineChain.slice(insertAt),
        ...newPinned,
      ];
      return withChain(state, newChain);
    }

    case 'chain:remove': {
      const nextDisabled = state.disabledChainIds.filter((id) => id !== action.id);
      return withChain(state, state.pipelineChain.filter((id) => id !== action.id), nextDisabled);
    }

    case 'chain:toggle-enabled': {
      if (!state.pipelineChain.includes(action.id)) return state;
      const disabledSet = new Set(state.disabledChainIds);
      if (disabledSet.has(action.id)) disabledSet.delete(action.id);
      else disabledSet.add(action.id);
      return withChain(state, state.pipelineChain, [...disabledSet]);
    }

    case 'chain:reorder': {
      if (PINNED_TAIL_IDS.has(state.pipelineChain[action.fromIndex])) return state;
      const firstPinned = state.pipelineChain.findIndex((x) => PINNED_TAIL_IDS.has(x));
      const clampedTo = firstPinned !== -1 ? Math.min(action.toIndex, firstPinned - 1) : action.toIndex;
      return withChain(state, arrayMove(state.pipelineChain, action.fromIndex, clampedTo));
    }

    case 'chain:restore': {
      // Ensure pinned tail IDs stay at the end
      const nonPinned = action.chain.filter((id) => !PINNED_TAIL_IDS.has(id));
      const pinned = action.chain.filter((id) => PINNED_TAIL_IDS.has(id));
      return withChain(state, [...nonPinned, ...pinned], action.disabledChainIds);
    }

    // ── ADB streaming ────────────────────────────────────────────────────────
    case 'adb:results-update': {
      const { sessionId, processorId, matchedLines, emissionCount } = action;
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, sessionId, (s) =>
          mergeProcessorResult(s, processorId, matchedLines, emissionCount),
        ),
      };
    }

    case 'adb:results-batch': {
      // Group by sessionId so we clone the outer Map at most once per session.
      const grouped = new Map<string, typeof action.updates>();
      for (const u of action.updates) {
        const arr = grouped.get(u.sessionId);
        if (arr) arr.push(u);
        else grouped.set(u.sessionId, [u]);
      }
      const map = new Map(state.resultsBySession);
      for (const [sessionId, updates] of grouped) {
        let session = getOrDefault(map, sessionId);
        for (const { processorId, matchedLines, emissionCount } of updates) {
          session = mergeProcessorResult(session, processorId, matchedLines, emissionCount);
        }
        map.set(sessionId, session);
      }
      return { ...state, resultsBySession: map };
    }

    case 'adb:run-count-bump':
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, action.sessionId, (s) => ({
          ...s, runCount: s.runCount + 1,
        })),
      };

    // ── Error ────────────────────────────────────────────────────────────────
    case 'error:set':
      return { ...state, error: action.error };

    case 'error:clear':
      return { ...state, error: null };

    default:
      return state;
  }
}

// ── Sub-context value types ─────────────────────────────────────────────────

interface PipelineLibraryCtxValue {
  processors: ProcessorSummary[];
  packs: PackSummary[];
  error: string | null;
  dispatch: React.Dispatch<PipelineAction>;
}

interface PipelineChainCtxValue {
  pipelineChain: string[];
  disabledChainIds: string[];
  activeProcessorIds: string[];
  dispatch: React.Dispatch<PipelineAction>;
}

interface PipelineResultsCtxValue {
  resultsBySession: Map<string, SessionPipelineState>;
  dispatch: React.Dispatch<PipelineAction>;
}

// ── Public facade interface ──────────────────────────────────────────────────

interface PipelineContextValue extends PipelineState {
  dispatch: React.Dispatch<PipelineAction>;
}

// ── Three internal sub-contexts (not exported from barrel) ──────────────────

const PipelineLibraryCtx = createContext<PipelineLibraryCtxValue | null>(null);
const PipelineChainCtx = createContext<PipelineChainCtxValue | null>(null);
const PipelineResultsCtx = createContext<PipelineResultsCtxValue | null>(null);

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(pipelineReducer, initialState);

  const libraryValue = useMemo<PipelineLibraryCtxValue>(
    () => ({ processors: state.processors, packs: state.packs, error: state.error, dispatch }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.processors, state.packs, state.error],
  );

  const chainValue = useMemo<PipelineChainCtxValue>(
    () => ({
      pipelineChain: state.pipelineChain,
      disabledChainIds: state.disabledChainIds,
      activeProcessorIds: state.activeProcessorIds,
      dispatch,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.pipelineChain, state.disabledChainIds, state.activeProcessorIds],
  );

  const resultsValue = useMemo<PipelineResultsCtxValue>(
    () => ({ resultsBySession: state.resultsBySession, dispatch }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.resultsBySession],
  );

  return (
    <PipelineLibraryCtx.Provider value={libraryValue}>
      <PipelineChainCtx.Provider value={chainValue}>
        <PipelineResultsCtx.Provider value={resultsValue}>
          {children}
        </PipelineResultsCtx.Provider>
      </PipelineChainCtx.Provider>
    </PipelineLibraryCtx.Provider>
  );
}

// ── Narrow hooks (used by selectors.ts — not exported from barrel) ───────────

export function usePipelineLibraryCtx(): PipelineLibraryCtxValue {
  const ctx = useContext(PipelineLibraryCtx);
  if (!ctx) throw new Error('usePipelineLibraryCtx must be used within PipelineProvider');
  return ctx;
}

export function usePipelineChainCtx(): PipelineChainCtxValue {
  const ctx = useContext(PipelineChainCtx);
  if (!ctx) throw new Error('usePipelineChainCtx must be used within PipelineProvider');
  return ctx;
}

export function usePipelineResultsCtx(): PipelineResultsCtxValue {
  const ctx = useContext(PipelineResultsCtx);
  if (!ctx) throw new Error('usePipelineResultsCtx must be used within PipelineProvider');
  return ctx;
}

// ── Facade — reads all 3 sub-contexts, returns combined interface ─────────────
// Used by domain hooks (usePipeline, etc.) that need cross-context access.

export function usePipelineContext(): PipelineContextValue {
  const library = usePipelineLibraryCtx();
  const chain = usePipelineChainCtx();
  const results = usePipelineResultsCtx();
  return {
    processors: library.processors,
    packs: library.packs,
    error: library.error,
    pipelineChain: chain.pipelineChain,
    disabledChainIds: chain.disabledChainIds,
    activeProcessorIds: chain.activeProcessorIds,
    resultsBySession: results.resultsBySession,
    dispatch: chain.dispatch,
  };
}

