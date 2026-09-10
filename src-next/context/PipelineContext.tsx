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
  // scriptErrors/scannedFrom are required on the wire type but this streaming
  // update (AdbProcessorUpdate) doesn't carry them — 0 is the "not applicable /
  // not yet known" default the backend itself sends for file-mode runs.
  const updated: PipelineRunSummary = { processorId, matchedLines, emissionCount, scriptErrors: 0, scannedFrom: 0 };
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

/** One session's processor chain: order, disabled subset, and the enabled subset. */
export interface SessionChainState {
  chain: string[];
  /** Processor IDs present in the chain but excluded from execution. */
  disabled: string[];
  /** Enabled subset of `chain` — a separate field for selector stability. */
  active: string[];
}

const EMPTY_CHAIN: SessionChainState = { chain: [], disabled: [], active: [] };

/** Exported for white-box reducer tests; not part of the barrel's public API. */
export interface PipelineState {
  processors: ProcessorSummary[];
  packs: PackSummary[];
  /**
   * Per-session chains, keyed by sessionId. A session with no entry inherits
   * `defaultChain` — that copy-on-write default is what makes a newly opened
   * session start from the last configured chain, and what lets a legacy
   * workspace (which stored ONE global chain) restore onto every session.
   */
  chainBySession: Map<string, SessionChainState>;
  /** Template for sessions with no chain of their own; also the legacy target. */
  defaultChain: SessionChainState;
  /** Per-session pipeline results, keyed by sessionId. */
  resultsBySession: Map<string, SessionPipelineState>;
  /** Global error (processor install/remove failures — not per-session). */
  error: string | null;
  /**
   * True once the processor library has loaded at least once, which is when the
   * chain baseline (localStorage seed or workspace restore) is established.
   * Gates the chain persist/publish effects in `usePipelineWiring`.
   *
   * This is reducer state rather than a hook ref on purpose: `loadProcessors`
   * is called from components (`ProcessorPanel`, `BrowseTab`) while the effects
   * it arms live in the singleton wiring hook, so the flag has to be visible
   * across hook instances.
   */
  chainInitialized: boolean;
  /**
   * True once a workspace restore has authoritatively set a chain
   * (`chain:restore`). Suppresses the localStorage seed so a restored chain is
   * never overwritten by the previous session's default. Reducer-internal — not
   * exposed through any context value.
   */
  chainRestored: boolean;
}

/** Enabled subset of a chain, given its disabled set. */
function computeActive(chain: string[], disabled: string[]): string[] {
  const disabledSet = new Set(disabled);
  return chain.filter((id) => !disabledSet.has(id));
}

/** This session's chain, falling back to the shared default when it has none. */
function getChain(state: PipelineState, sessionId: string | null): SessionChainState {
  if (!sessionId) return state.defaultChain;
  return state.chainBySession.get(sessionId) ?? state.defaultChain;
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
  // Chain management (PINNED_TAIL_IDS logic lives in the reducer, not at call sites).
  // sessionId targets one session's chain; null edits the shared default.
  | { type: 'chain:add'; sessionId: string | null; id: string }
  | { type: 'chain:add-pack'; sessionId: string | null; processorIds: string[] }
  | { type: 'chain:remove'; sessionId: string | null; id: string }
  | { type: 'chain:reorder'; sessionId: string | null; fromIndex: number; toIndex: number }
  | { type: 'chain:toggle-enabled'; sessionId: string | null; id: string }
  // Workspace restore — override a chain with saved state. A null sessionId is
  // the legacy path: it sets the default AND back-fills every session that has
  // no chain of its own, so old single-chain workspaces restore intact.
  | { type: 'chain:restore'; sessionId: string | null; chain: string[]; disabledChainIds: string[] }
  // ADB streaming incremental updates
  | { type: 'adb:results-update'; sessionId: string; processorId: string; matchedLines: number; emissionCount: number }
  | { type: 'adb:results-batch'; updates: Array<{ sessionId: string; processorId: string; matchedLines: number; emissionCount: number }> }
  | { type: 'adb:run-count-bump'; sessionId: string }
  // Error management
  | { type: 'error:set'; error: string }
  | { type: 'error:clear' };

// ── Reducer ───────────────────────────────────────────────────────────────────

export const initialState: PipelineState = {
  processors: [],
  packs: [],
  chainBySession: new Map(),
  defaultChain: EMPTY_CHAIN,
  resultsBySession: new Map(),
  error: null,
  chainInitialized: false,
  chainRestored: false,
};

/**
 * Apply a new chain to one session, keeping its active subset in sync.
 * A null sessionId writes the shared default instead of a session entry.
 */
function withChain(
  state: PipelineState,
  sessionId: string | null,
  chain: string[],
  disabledChainIds?: string[],
): PipelineState {
  const prev = getChain(state, sessionId);
  const disabled = disabledChainIds ?? prev.disabled;
  const next: SessionChainState = { chain, disabled, active: computeActive(chain, disabled) };

  if (!sessionId) return { ...state, defaultChain: next };
  const chainBySession = new Map(state.chainBySession);
  chainBySession.set(sessionId, next);
  return { ...state, chainBySession };
}

/** Apply a mapper to every session's chain and to the default. */
function mapAllChains(
  state: PipelineState,
  fn: (c: SessionChainState) => SessionChainState,
): PipelineState {
  const chainBySession = new Map<string, SessionChainState>();
  for (const [sid, c] of state.chainBySession) chainBySession.set(sid, fn(c));
  return { ...state, chainBySession, defaultChain: fn(state.defaultChain) };
}

export function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
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
      const hadResults = state.resultsBySession.has(action.sessionId);
      const hadChain = state.chainBySession.has(action.sessionId);
      if (!hadResults && !hadChain) return state;
      let next = state;
      if (hadResults) {
        const results = new Map(state.resultsBySession);
        results.delete(action.sessionId);
        next = { ...next, resultsBySession: results };
      }
      // Drop the closed session's chain too, or the Map grows unbounded.
      if (hadChain) {
        const chains = new Map(state.chainBySession);
        chains.delete(action.sessionId);
        next = { ...next, chainBySession: chains };
      }
      return next;
    }

    // ── Processor library ────────────────────────────────────────────────────
    case 'processors:loaded': {
      const next = { ...state, processors: action.processors, chainInitialized: true };
      // The startup chain seeds the DEFAULT, not any one session — sessions may
      // not exist yet at library-load time, and each inherits it until edited.
      //
      // Seeding is the reducer's decision, not the caller's: `loadProcessors`
      // may run from more than one component and more than once, and a workspace
      // restore may have landed first. Apply the seed on the FIRST load only,
      // and never over a restored chain.
      const seed = action.initialChain !== undefined && !state.chainInitialized && !state.chainRestored;
      return seed
        ? withChain(next, null, action.initialChain!, action.initialDisabled ?? [])
        : next;
    }

    case 'processor:installed': {
      const without = state.processors.filter((p) => p.id !== action.processor.id);
      const processors = [...without, action.processor].sort((a, b) => a.name.localeCompare(b.name));
      return { ...state, processors };
    }

    case 'processor:removed': {
      // An uninstalled processor must leave EVERY session's chain, not just the
      // focused one — otherwise a background session keeps a dangling id.
      const processors = state.processors.filter((p) => p.id !== action.id);
      return mapAllChains({ ...state, processors }, (c) => {
        if (!c.chain.includes(action.id)) return c;
        const chain = c.chain.filter((id) => id !== action.id);
        const disabled = c.disabled.filter((id) => id !== action.id);
        return { chain, disabled, active: computeActive(chain, disabled) };
      });
    }

    case 'packs:loaded':
      return { ...state, packs: action.packs };

    // ── Chain management ─────────────────────────────────────────────────────
    case 'chain:add': {
      const cur = getChain(state, action.sessionId).chain;
      if (cur.includes(action.id)) return state;
      let chain: string[];
      if (PINNED_TAIL_IDS.has(action.id)) {
        chain = [...cur, action.id];
      } else {
        const firstPinned = cur.findIndex((x) => PINNED_TAIL_IDS.has(x));
        chain = firstPinned !== -1
          ? [...cur.slice(0, firstPinned), action.id, ...cur.slice(firstPinned)]
          : [...cur, action.id];
      }
      return withChain(state, action.sessionId, chain);
    }

    case 'chain:add-pack': {
      const cur = getChain(state, action.sessionId).chain;
      // Add all processor IDs not already in the chain, respecting PINNED_TAIL_IDS position
      const newIds = action.processorIds.filter(
        (id) => !cur.includes(id) && !PINNED_TAIL_IDS.has(id),
      );
      // Also handle any pinned IDs in the pack (unlikely, but safe)
      const newPinned = action.processorIds.filter(
        (id) => !cur.includes(id) && PINNED_TAIL_IDS.has(id),
      );
      if (newIds.length === 0 && newPinned.length === 0) return state;
      const firstPinned = cur.findIndex((id) => PINNED_TAIL_IDS.has(id));
      const insertAt = firstPinned >= 0 ? firstPinned : cur.length;
      const newChain = [
        ...cur.slice(0, insertAt),
        ...newIds,
        ...cur.slice(insertAt),
        ...newPinned,
      ];
      return withChain(state, action.sessionId, newChain);
    }

    case 'chain:remove': {
      const cur = getChain(state, action.sessionId);
      const nextDisabled = cur.disabled.filter((id) => id !== action.id);
      return withChain(state, action.sessionId, cur.chain.filter((id) => id !== action.id), nextDisabled);
    }

    case 'chain:toggle-enabled': {
      const cur = getChain(state, action.sessionId);
      if (!cur.chain.includes(action.id)) return state;
      const disabledSet = new Set(cur.disabled);
      if (disabledSet.has(action.id)) disabledSet.delete(action.id);
      else disabledSet.add(action.id);
      return withChain(state, action.sessionId, cur.chain, [...disabledSet]);
    }

    case 'chain:reorder': {
      const cur = getChain(state, action.sessionId).chain;
      if (PINNED_TAIL_IDS.has(cur[action.fromIndex])) return state;
      const firstPinned = cur.findIndex((x) => PINNED_TAIL_IDS.has(x));
      const clampedTo = firstPinned !== -1 ? Math.min(action.toIndex, firstPinned - 1) : action.toIndex;
      return withChain(state, action.sessionId, arrayMove(cur, action.fromIndex, clampedTo));
    }

    case 'chain:restore': {
      // Ensure pinned tail IDs stay at the end
      const nonPinned = action.chain.filter((id) => !PINNED_TAIL_IDS.has(id));
      const pinned = action.chain.filter((id) => PINNED_TAIL_IDS.has(id));
      const ordered = [...nonPinned, ...pinned];
      // Mark the chain as restore-owned so a later `processors:loaded` does not
      // seed the default from localStorage on top of it.
      const restored = { ...state, chainRestored: true };
      if (action.sessionId) return withChain(restored, action.sessionId, ordered, action.disabledChainIds);
      // Legacy single-chain workspace: set the default so every session that has
      // no chain of its own inherits it. Sessions with their own chain are left
      // alone — a v4 workspace restores those through the per-session path.
      return withChain(restored, null, ordered, action.disabledChainIds);
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
  chainBySession: Map<string, SessionChainState>;
  defaultChain: SessionChainState;
  /** Flips false→true once, when the processor library first loads. */
  chainInitialized: boolean;
  dispatch: React.Dispatch<PipelineAction>;
}

interface PipelineResultsCtxValue {
  resultsBySession: Map<string, SessionPipelineState>;
  dispatch: React.Dispatch<PipelineAction>;
}

// ── Public facade interface ──────────────────────────────────────────────────

// `chainRestored` is deliberately omitted — it exists only to let the reducer
// suppress the localStorage seed, and no consumer should branch on it.
interface PipelineContextValue extends Omit<PipelineState, 'chainRestored'> {
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
    [state.processors, state.packs, state.error],
  );

  const chainValue = useMemo<PipelineChainCtxValue>(
    () => ({
      chainBySession: state.chainBySession,
      defaultChain: state.defaultChain,
      chainInitialized: state.chainInitialized,
      dispatch,
    }),
    [state.chainBySession, state.defaultChain, state.chainInitialized],
  );

  const resultsValue = useMemo<PipelineResultsCtxValue>(
    () => ({ resultsBySession: state.resultsBySession, dispatch }),
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
// Used by domain hooks (usePipelineCommands, usePipelineWiring, etc.) that need
// cross-context access.

export function usePipelineContext(): PipelineContextValue {
  const library = usePipelineLibraryCtx();
  const chain = usePipelineChainCtx();
  const results = usePipelineResultsCtx();
  return {
    processors: library.processors,
    packs: library.packs,
    error: library.error,
    chainBySession: chain.chainBySession,
    defaultChain: chain.defaultChain,
    chainInitialized: chain.chainInitialized,
    resultsBySession: results.resultsBySession,
    dispatch: chain.dispatch,
  };
}

