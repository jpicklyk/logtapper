import { useCallback, useRef } from 'react';
import {
  listProcessors,
  listPacks,
  loadProcessorYaml,
  uninstallProcessor,
  runPipeline,
  stopPipeline,
  getProcessorVars,
} from '../bridge/commands';
import { usePipelineContext } from '../context/PipelineContext';
import { bus } from '../events';
import { loadChainFromStorage, loadDisabledFromStorage } from './pipelineChainStorage';

export interface PipelineActions {
  loadProcessors: () => Promise<void>;
  installFromYaml: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => Promise<void>;
  run: (sessionId: string, anonymize?: boolean, override?: { chain: string[]; disabled: string[] }) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  getVars: (sessionId: string, processorId: string) => Promise<Record<string, unknown>>;
  clearResults: (sessionId: string) => void;
}

/**
 * The pipeline domain's ACTION surface: stable callbacks over bridge commands
 * and `PipelineContext` dispatch, and nothing else.
 *
 * This hook is deliberately free of `useEffect` — it registers no bus handler,
 * no Tauri listener and no timer — so it is safe to mount in as many components
 * as need it. Every effect in the pipeline domain lives in `usePipelineWiring`,
 * which is mounted exactly once (in `context/HookWiring`).
 *
 * That split is load-bearing. When the effects lived here, each of the four
 * component call sites got its own copy: N `pipeline:adb-processor-batch`
 * handlers each dispatching a Map-cloning `adb:results-batch` on the ~50ms
 * streaming path, N run-count throttles each bumping the non-idempotent
 * `adb:run-count-bump`, N chain-persist effects emitting duplicate
 * `pipeline:chain-changed` and duplicate `setSessionPipelineMeta` IPC, and N
 * `workspace-restored` listeners.
 */
export function usePipelineCommands(): PipelineActions {
  const { processors, chainBySession, defaultChain, resultsBySession, dispatch } = usePipelineContext();

  // Refs for stable access in callbacks without stale closures
  const processorsRef = useRef(processors);
  processorsRef.current = processors;
  const resultsBySessionRef = useRef(resultsBySession);
  resultsBySessionRef.current = resultsBySession;
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

  const loadProcessors = useCallback(async () => {
    try {
      const [list, packs] = await Promise.all([listProcessors(), listPacks()]);
      dispatch({ type: 'packs:loaded', packs });
      // The seed is always passed; the REDUCER decides whether to apply it (first
      // load only, and never over a chain a workspace restore already set). That
      // decision used to live in per-instance refs, so which processors a session
      // started with depended on which mounted copy of this hook happened to run
      // first — the reducer owns it now, which is what lets this stay stateless.
      const initialChain = loadChainFromStorage(new Set(list.map((p) => p.id)));
      const initialDisabled = loadDisabledFromStorage(new Set(initialChain));
      dispatch({ type: 'processors:loaded', processors: list, initialChain, initialDisabled });
    } catch (e) {
      dispatch({ type: 'error:set', error: String(e) });
    }
  }, [dispatch]);

  const installFromYaml = useCallback(async (yaml: string) => {
    dispatch({ type: 'error:clear' });
    try {
      const processor = await loadProcessorYaml(yaml);
      dispatch({ type: 'processor:installed', processor });
    } catch (e) {
      dispatch({ type: 'error:set', error: String(e) });
      throw e;
    }
  }, [dispatch]);

  const removeProcessor = useCallback(async (id: string) => {
    try {
      await uninstallProcessor(id);
      dispatch({ type: 'processor:removed', id });
    } catch (e) {
      dispatch({ type: 'error:set', error: String(e) });
    }
  }, [dispatch]);

  const run = useCallback(
    async (
      sessionId: string,
      anonymize = false,
      override?: { chain: string[]; disabled: string[] },
    ) => {
      let chain: string[];
      let disabled: Set<string>;
      if (override) {
        // Auto-run after a workspace restore: use the session's restored chain
        // directly. `chain:restore` (dispatched by useWorkspaceRestore) only
        // reaches the chain refs on the next render, which has not happened yet
        // when this fires — reading the ref would run a stale/empty chain and
        // no-op (the exact bug §Q2 fixes). Filter to installed processors,
        // mirroring useWorkspaceRestore's chain:restore filter.
        const installed = new Set(processorsRef.current.map((p) => p.id));
        chain = override.chain.filter((id) => installed.has(id) || id.includes('@lts-'));
        disabled = new Set(override.disabled);
      } else {
        // Run THIS session's own chain. Reading the default here would run the
        // wrong processors for any session whose chain has diverged — the exact
        // cross-session bug per-session chains exist to fix.
        const own = chainFor(sessionId);
        chain = own.chain;
        disabled = new Set(own.disabled);
      }
      const effectiveChain = chain.filter((id) => !disabled.has(id));
      if (effectiveChain.length === 0) return;
      dispatch({ type: 'run:started', sessionId });
      try {
        const results = await runPipeline(sessionId, effectiveChain, anonymize);
        // Compute newRunCount before dispatching — the reducer will set runCount to this value.
        const prevState = resultsBySessionRef.current.get(sessionId);
        const newRunCount = (prevState?.runCount ?? 0) + 1;
        dispatch({ type: 'run:complete', sessionId, results, newRunCount });

        // Determine which processor types are active in this run
        const chainSet = new Set(effectiveChain);
        const activeProcessors = processorsRef.current.filter((p) => chainSet.has(p.id));
        bus.emit('pipeline:completed', {
          sessionId,
          runCount: newRunCount,
          hasTrackers: activeProcessors.some((p) => p.processorType === 'state_tracker'),
          hasReporters: activeProcessors.some((p) => p.processorType === 'reporter'),
          hasCorrelators: activeProcessors.some((p) => p.processorType === 'correlator'),
        });
      } catch (e) {
        dispatch({ type: 'run:failed', sessionId, error: String(e) });
      }
    },
    [dispatch, chainFor],
  );

  const clearResults = useCallback((sessionId: string) => {
    dispatch({ type: 'results:cleared', sessionId });
    bus.emit('pipeline:cleared', undefined);
  }, [dispatch]);

  // Note: the backend `stopPipeline()` sets a single global cancellation flag —
  // it does not support per-session cancellation. The sessionId here only scopes
  // the frontend state transition. True per-session stop requires backend changes.
  const stop = useCallback(async (sessionId: string) => {
    try {
      await stopPipeline();
    } finally {
      dispatch({ type: 'run:stopped', sessionId });
    }
  }, [dispatch]);

  const getVars = useCallback(
    async (sessionId: string, processorId: string) => getProcessorVars(sessionId, processorId),
    [],
  );

  return {
    loadProcessors,
    installFromYaml,
    removeProcessor,
    run,
    stop,
    getVars,
    clearResults,
  };
}
