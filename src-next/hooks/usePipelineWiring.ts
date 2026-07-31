import { useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AdbProcessorUpdate, PipelineProgress } from '../bridge/types';
import { useSessionCoreCtx, useSessionPaneCtx } from '../context/SessionContext';
import {
  listProcessors,
  listPacks,
  setMcpAnonymize,
  setSessionPipelineMeta,
} from '../bridge/commands';
import { usePipelineContext } from '../context/PipelineContext';
import { bus } from '../events/bus';
import { useWorkspaceRestore } from './useWorkspaceRestore';
import { usePipelineCommands, type PipelineActions } from './usePipelineCommands';
import { saveChainToStorage } from './pipelineChainStorage';

/**
 * SINGLETON. Mount this exactly once — in `context/HookWiring` — and nowhere
 * else. It owns every effect in the pipeline domain: the `pipeline-progress`
 * Tauri listener, the bus subscriptions (`stream:started`,
 * `pipeline:adb-processor-batch`, `pipeline:adb-tracker-update`,
 * `session:pre-load`, `session:closed`, marketplace refresh), the shared
 * run-count throttle timer, the chain persist/publish effect, and the
 * `workspace-restored` listener via `useWorkspaceRestore`.
 *
 * Components that need pipeline actions mount `usePipelineCommands` instead,
 * which is effect-free and therefore duplicable. Adding an effect here is free;
 * adding one to `usePipelineCommands` multiplies it by the number of mounted
 * components, which is the bug this split exists to prevent.
 *
 * Returns the same `PipelineActions` surface so `HookWiring` needs only this
 * one hook.
 */
export function usePipelineWiring(
  scheduleAutoRun: (sessionId: string, isIndexing: boolean | undefined, chain: string[], disabled: string[]) => void,
): PipelineActions {
  const actions = usePipelineCommands();
  const { processors, chainBySession, defaultChain, chainInitialized, dispatch } = usePipelineContext();

  // localStorage and the chain-changed bus event describe the DEFAULT chain —
  // the template a new session inherits. Per-session chains are persisted
  // through setSessionPipelineMeta below, and by the backend's per-session
  // pipeline-meta.json, not through these global keys.
  const pipelineChain = defaultChain.chain;
  const disabledChainIds = defaultChain.disabled;

  // Track the focused pane so session:pre-load can resolve the outgoing sessionId.
  const { paneSessionMap } = useSessionCoreCtx();
  const { activeLogPaneId } = useSessionPaneCtx();
  const activeLogPaneIdRef = useRef(activeLogPaneId);
  activeLogPaneIdRef.current = activeLogPaneId;
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  const chainBySessionRef = useRef(chainBySession);
  chainBySessionRef.current = chainBySession;
  const defaultChainRef = useRef(defaultChain);
  defaultChainRef.current = defaultChain;

  /** A session's own chain, falling back to the shared default. */
  const chainFor = useCallback(
    (sessionId: string | null) =>
      (sessionId ? chainBySessionRef.current.get(sessionId) : null) ?? defaultChainRef.current,
    [],
  );

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const metaSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Previous chain state, for diffing which sessions to notify. */
  const prevChainsRef = useRef<{ byS: typeof chainBySession; def: typeof defaultChain } | null>(null);
  /** Sessions with a chain edit awaiting the debounced backend meta push. */
  const pendingMetaRef = useRef<Set<string>>(new Set());

  // `chainInitialized` is reducer state (PipelineContext), not a per-hook ref.
  // It has to be shared: the component that calls `loadProcessors` is not the
  // one that owns this effect, so a per-instance ref left the persist effect
  // permanently disarmed on the wiring instance (and armed on whichever
  // component happened to load the library first).
  const chainInitializedRef = useRef(chainInitialized);
  chainInitializedRef.current = chainInitialized;

  // Persist chain + disabled state to localStorage + backend whenever they change
  useEffect(() => {
    if (!chainInitialized) return;
    saveChainToStorage(pipelineChain, disabledChainIds);

    // Emit one TARGETED event per session whose chain actually changed. Resolving
    // a single sessionId from the focused pane (as this once did) pushed the
    // focused session's chain into whichever session was streaming — a
    // cross-session write that only became possible once chains went per-session.
    // Broadcasting and letting the consumer filter by ref is forbidden outright
    // (root CLAUDE.md principle #6), which is why the sessionId is in the payload.
    const prev = prevChainsRef.current;
    const targets = new Set<string>();
    for (const [sid, c] of chainBySession) {
      if (prev?.byS.get(sid) !== c) targets.add(sid);
    }
    // A change to the default reaches every session that has no chain of its own.
    if (prev?.def !== defaultChain) {
      for (const sid of paneSessionMapRef.current.values()) {
        if (sid && !chainBySession.has(sid)) targets.add(sid);
      }
    }
    prevChainsRef.current = { byS: chainBySession, def: defaultChain };
    for (const sid of targets) {
      bus.emit('pipeline:chain-changed', { sessionId: sid, chain: chainFor(sid).chain });
    }

    // Push the MCP-bridge per-session anonymize flag immediately (not
    // debounced) — it's the security boundary the bridge consults on every
    // raw-line request, unlike the meta sync below which only feeds
    // workspace persistence. Resolved the same way setSessionPipelineMeta's
    // sessionId is below.
    const anonymizeSessionId = paneSessionMapRef.current.get(activeLogPaneIdRef.current ?? '');
    if (anonymizeSessionId) {
      // The anonymizer flag is a per-session security boundary, so it must be
      // read from that session's OWN chain, not the default.
      const own = chainFor(anonymizeSessionId);
      setMcpAnonymize(anonymizeSessionId, own.chain.includes('__pii_anonymizer')).catch(() => {});
    }

    // Debounced push to backend for workspace persistence (500ms).
    // The target sessions are captured HERE, at edit time — resolving them when
    // the timer fires loses the edit entirely if focus moves within the window
    // (the edit would be attributed to whichever session became active instead).
    for (const sid of targets) pendingMetaRef.current.add(sid);
    if (targets.size === 0) {
      const focused = paneSessionMapRef.current.get(activeLogPaneIdRef.current ?? '');
      if (focused) pendingMetaRef.current.add(focused);
    }
    if (metaSyncTimerRef.current) clearTimeout(metaSyncTimerRef.current);
    metaSyncTimerRef.current = setTimeout(() => {
      metaSyncTimerRef.current = null;
      const pending = pendingMetaRef.current;
      pendingMetaRef.current = new Set();
      for (const sid of pending) {
        const own = chainFor(sid);
        setSessionPipelineMeta(sid, own.chain, own.disabled).catch(() => {});
      }
    }, 500);
    // chainBySession is a dependency because a per-session edit must re-push
    // that session's meta, not just changes to the default.
  }, [chainInitialized, pipelineChain, disabledChainIds, chainBySession, defaultChain, chainFor]);

  // Push chain to backend when a session becomes active (handles the case where
  // the chain was initialized from localStorage before any session was loaded).
  useEffect(() => {
    if (!chainInitialized) return;
    const sessionId = paneSessionMap.get(activeLogPaneId ?? '');
    if (!sessionId) return;
    // Push the session's OWN chain. Pushing the default here would clobber a
    // diverged session's backend pipeline-meta the moment it gains focus, and
    // would override its per-session __pii_anonymizer flag — the flag the MCP
    // bridge consults on every raw-line request.
    const own = chainFor(sessionId);
    setSessionPipelineMeta(sessionId, own.chain, own.disabled).catch(() => {});
    setMcpAnonymize(sessionId, own.chain.includes('__pii_anonymizer')).catch(() => {});
  }, [chainInitialized, activeLogPaneId, paneSessionMap, chainFor]);

  // Cleanup debounce timer on unmount
  useEffect(() => () => {
    if (metaSyncTimerRef.current) clearTimeout(metaSyncTimerRef.current);
  }, []);

  // When a new stream starts, re-emit pipeline:chain-changed so that
  // useSessionTabManager registers trackers/transformers/reporters for the new
  // session. Without this, if the chain hasn't changed since load (common case),
  // the chain-changed effect never fires and the new session has no processors.
  useEffect(() => {
    const handleStreamStarted = (e: { sessionId: string }) => {
      if (!chainInitializedRef.current) return;
      // Use the event's own sessionId. `paneSessionMapRef` is still one render
      // behind here — `stream:started` fires synchronously right after the
      // registerSession dispatch — so resolving through the pane map yields the
      // session the pane held BEFORE the stream, and pushes its chain instead.
      bus.emit('pipeline:chain-changed', { sessionId: e.sessionId, chain: chainFor(e.sessionId).chain });
    };
    bus.on('stream:started', handleStreamStarted);
    return () => { bus.off('stream:started', handleStreamStarted); };
  }, [chainFor]);

  // Subscribe to pipeline-progress events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    listen<PipelineProgress>('pipeline-progress', (event) => {
      if (cancelled) return;
      const { sessionId } = event.payload;
      dispatch({ type: 'run:progress', sessionId, current: event.payload.linesProcessed, total: event.payload.totalLines });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, [dispatch]);

  // Subscribe to batched streaming processor updates (forwarded from Channel by useStreamSession).
  // One dispatch per batch instead of N. runCount is throttled to at most once per 2s.
  const streamRunCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRunCountBumpRef = useRef<string | null>(null);

  useEffect(() => {
    // Shared trailing-throttle for runCount bumps — coalesces processor and tracker
    // updates into one dispatch per 2s window. `adb:run-count-bump` is NOT
    // idempotent (the reducer does runCount + 1), so exactly one throttle may
    // exist per app — hence this effect living in the singleton wiring hook.
    const scheduleRunCountBump = (sessionId: string) => {
      pendingRunCountBumpRef.current = sessionId;
      if (!streamRunCountTimerRef.current) {
        streamRunCountTimerRef.current = setTimeout(() => {
          streamRunCountTimerRef.current = null;
          const pending = pendingRunCountBumpRef.current;
          if (pending) {
            pendingRunCountBumpRef.current = null;
            dispatch({ type: 'adb:run-count-bump', sessionId: pending });
          }
        }, 2000);
      }
    };

    const processorHandler = (updates: AdbProcessorUpdate[]) => {
      if (updates.length === 0) return;
      dispatch({ type: 'adb:results-batch', updates });
      scheduleRunCountBump(updates[0].sessionId);
    };

    const trackerHandler = (payload: { sessionId: string }) => {
      scheduleRunCountBump(payload.sessionId);
    };

    bus.on('pipeline:adb-processor-batch', processorHandler);
    bus.on('pipeline:adb-tracker-update', trackerHandler);
    return () => {
      bus.off('pipeline:adb-processor-batch', processorHandler);
      bus.off('pipeline:adb-tracker-update', trackerHandler);
      if (streamRunCountTimerRef.current) {
        clearTimeout(streamRunCountTimerRef.current);
        streamRunCountTimerRef.current = null;
      }
    };
  }, [dispatch]);

  // Subscribe to session:pre-load to auto-clear results for the outgoing session.
  useEffect(() => {
    const handlePreLoad = (e: { paneId: string }) => {
      if (e.paneId === activeLogPaneIdRef.current) {
        const sessionId = paneSessionMapRef.current.get(e.paneId);
        if (sessionId) {
          dispatch({ type: 'pre-load:cleared', sessionId });
        }
      }
    };
    bus.on('session:pre-load', handlePreLoad);
    return () => { bus.off('session:pre-load', handlePreLoad); };
  }, [dispatch]);

  // Subscribe to session:closed to clean up Map entry
  useEffect(() => {
    const handleSessionClosed = (e: { sessionId: string }) => {
      dispatch({ type: 'session:removed', sessionId: e.sessionId });
    };
    bus.on('session:closed', handleSessionClosed);
    return () => { bus.off('session:closed', handleSessionClosed); };
  }, [dispatch]);

  // Refresh processor list and packs when a marketplace processor is installed or updated
  useEffect(() => {
    const refresh = () => {
      Promise.all([listProcessors(), listPacks()]).then(([list, packs]) => {
        dispatch({ type: 'packs:loaded', packs });
        dispatch({ type: 'processors:loaded', processors: list });
      }).catch(() => {});
    };
    bus.on('marketplace:processor-installed', refresh);
    bus.on('marketplace:processor-updated', refresh);
    return () => {
      bus.off('marketplace:processor-installed', refresh);
      bus.off('marketplace:processor-updated', refresh);
    };
  }, [dispatch]);

  // ── Workspace restore: set pipeline chain (all sources) + own the .lts-path
  //    auto-run through the shared scheduler. The .ltw path's auto-run is owned
  //    by the restore core; useWorkspaceRestore acts only on `source: "lts"`.
  useWorkspaceRestore(dispatch, processors, scheduleAutoRun);

  return actions;
}
