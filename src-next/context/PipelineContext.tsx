import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { ProcessorSummary, PipelineRunSummary } from '../bridge/types';

/** Processor IDs that must always remain at the tail of the chain. */
const PINNED_TAIL_IDS = new Set(['__pii_anonymizer']);

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
  pipelineChain: string[];
  /** Always mirrors pipelineChain — kept as a separate field for selector stability. */
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
  | { type: 'processors:loaded'; processors: ProcessorSummary[]; initialChain?: string[] }
  | { type: 'processor:installed'; processor: ProcessorSummary }
  | { type: 'processor:removed'; id: string }
  // Chain management (PINNED_TAIL_IDS logic lives in the reducer, not at call sites)
  | { type: 'chain:add'; id: string }
  | { type: 'chain:remove'; id: string }
  | { type: 'chain:reorder'; fromIndex: number; toIndex: number }
  // ADB streaming incremental updates
  | { type: 'adb:results-update'; sessionId: string; processorId: string; matchedLines: number; emissionCount: number }
  | { type: 'adb:run-count-bump'; sessionId: string }
  // Error management
  | { type: 'error:set'; error: string }
  | { type: 'error:clear' };

// ── Reducer ───────────────────────────────────────────────────────────────────

const initialState: PipelineState = {
  processors: [],
  pipelineChain: [],
  activeProcessorIds: [],
  resultsBySession: new Map(),
  error: null,
};

/** Apply a new chain value and keep activeProcessorIds in sync. */
function withChain(state: PipelineState, chain: string[]): PipelineState {
  return { ...state, pipelineChain: chain, activeProcessorIds: chain };
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
      return action.initialChain !== undefined ? withChain(next, action.initialChain) : next;
    }

    case 'processor:installed': {
      const without = state.processors.filter((p) => p.id !== action.processor.id);
      const processors = [...without, action.processor].sort((a, b) => a.name.localeCompare(b.name));
      return { ...state, processors };
    }

    case 'processor:removed': {
      const processors = state.processors.filter((p) => p.id !== action.id);
      const chain = state.pipelineChain.filter((id) => id !== action.id);
      return withChain({ ...state, processors }, chain);
    }

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

    case 'chain:remove':
      return withChain(state, state.pipelineChain.filter((id) => id !== action.id));

    case 'chain:reorder': {
      if (PINNED_TAIL_IDS.has(state.pipelineChain[action.fromIndex])) return state;
      const firstPinned = state.pipelineChain.findIndex((x) => PINNED_TAIL_IDS.has(x));
      const clampedTo = firstPinned !== -1 ? Math.min(action.toIndex, firstPinned - 1) : action.toIndex;
      return withChain(state, arrayMove(state.pipelineChain, action.fromIndex, clampedTo));
    }

    // ── ADB streaming ────────────────────────────────────────────────────────
    case 'adb:results-update': {
      const { sessionId, processorId, matchedLines, emissionCount } = action;
      return {
        ...state,
        resultsBySession: withSessionState(state.resultsBySession, sessionId, (s) => {
          const idx = s.results.findIndex((r) => r.processorId === processorId);
          const updated = {
            processorId,
            matchedLines: (idx >= 0 ? s.results[idx].matchedLines : 0) + matchedLines,
            emissionCount: (idx >= 0 ? s.results[idx].emissionCount : 0) + emissionCount,
          };
          // Preserve array ordering: update in-place if exists, else append
          const results = idx >= 0
            ? s.results.map((r, i) => i === idx ? updated : r)
            : [...s.results, updated];
          return { ...s, results };
        }),
      };
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

// ── Context ───────────────────────────────────────────────────────────────────

interface PipelineContextValue extends PipelineState {
  dispatch: React.Dispatch<PipelineAction>;
}

const PipelineContext = createContext<PipelineContextValue | null>(null);

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(pipelineReducer, initialState);

  const value = useMemo<PipelineContextValue>(
    () => ({ ...state, dispatch }),
    // dispatch is stable — the only trigger for a new context value is state changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );

  return (
    <PipelineContext.Provider value={value}>
      {children}
    </PipelineContext.Provider>
  );
}

export function usePipelineContext(): PipelineContextValue {
  const ctx = useContext(PipelineContext);
  if (!ctx) {
    throw new Error('usePipelineContext must be used within a PipelineProvider');
  }
  return ctx;
}

