import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { ProcessorSummary, PipelineRunSummary } from '../bridge/types';

/** Processor IDs that must always remain at the tail of the chain. */
const PINNED_TAIL_IDS = new Set(['__pii_anonymizer']);

// ── State ─────────────────────────────────────────────────────────────────────

interface PipelineState {
  processors: ProcessorSummary[];
  pipelineChain: string[];
  /** Always mirrors pipelineChain — kept as a separate field for selector stability. */
  activeProcessorIds: string[];
  running: boolean;
  progress: { current: number; total: number } | null;
  lastResults: PipelineRunSummary[];
  runCount: number;
  error: string | null;
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type PipelineAction =
  // Run lifecycle — each action encodes a valid transition
  | { type: 'run:started' }
  | { type: 'run:progress'; current: number; total: number }
  | { type: 'run:complete'; results: PipelineRunSummary[]; newRunCount: number }
  | { type: 'run:failed'; error: string }
  | { type: 'run:stopped' }
  // Results management
  | { type: 'results:cleared' }
  | { type: 'pre-load:cleared' }
  // Processor library
  | { type: 'processors:loaded'; processors: ProcessorSummary[]; initialChain?: string[] }
  | { type: 'processor:installed'; processor: ProcessorSummary }
  | { type: 'processor:removed'; id: string }
  // Chain management (PINNED_TAIL_IDS logic lives in the reducer, not at call sites)
  | { type: 'chain:add'; id: string }
  | { type: 'chain:remove'; id: string }
  | { type: 'chain:reorder'; fromIndex: number; toIndex: number }
  // ADB streaming incremental updates
  | { type: 'adb:results-update'; processorId: string; matchedLines: number; emissionCount: number }
  | { type: 'adb:run-count-bump' }
  // Error management
  | { type: 'error:set'; error: string }
  | { type: 'error:clear' };

// ── Reducer ───────────────────────────────────────────────────────────────────

const initialState: PipelineState = {
  processors: [],
  pipelineChain: [],
  activeProcessorIds: [],
  running: false,
  progress: null,
  lastResults: [],
  runCount: 0,
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
      return { ...state, running: true, progress: null, error: null };

    case 'run:progress':
      return { ...state, progress: { current: action.current, total: action.total } };

    case 'run:complete':
      return { ...state, running: false, progress: null, lastResults: action.results, runCount: action.newRunCount };

    case 'run:failed':
      return { ...state, running: false, error: action.error };

    case 'run:stopped':
      return { ...state, running: false };

    // ── Results ──────────────────────────────────────────────────────────────
    case 'results:cleared':
      return { ...state, lastResults: [], progress: null };

    case 'pre-load:cleared':
      return { ...state, lastResults: [], progress: null, error: null };

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
      const { processorId, matchedLines, emissionCount } = action;
      const existing = state.lastResults.find((r) => r.processorId === processorId);
      const without = state.lastResults.filter((r) => r.processorId !== processorId);
      return {
        ...state,
        lastResults: [
          ...without,
          {
            processorId,
            matchedLines: (existing?.matchedLines ?? 0) + matchedLines,
            emissionCount: (existing?.emissionCount ?? 0) + emissionCount,
          },
        ],
      };
    }

    case 'adb:run-count-bump':
      return { ...state, runCount: state.runCount + 1 };

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
