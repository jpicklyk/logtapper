import { useCallback, useRef } from 'react';
import {
  listProcessors,
  listPacks,
  loadProcessorYaml,
  uninstallProcessor,
  runPipeline,
  setSessionPipelineMeta,
  stopPipeline,
  getProcessorVars,
} from '../bridge/commands';
import { usePipelineContext } from '../context/PipelineContext';
import { bus } from '../events';
import { loadChainFromStorage, loadDisabledFromStorage } from './pipelineChainStorage';

/** `services::pipeline::resolve_effective_chain`'s refusal when a session has no
 *  chain to run. Matched as a substring because the backend interpolates the
 *  session id into it. */
const NO_CHAIN_CONFIGURED = 'no pipeline chain configured';

export interface PipelineActions {
  loadProcessors: () => Promise<void>;
  installFromYaml: (yaml: string) => Promise<void>;
  removeProcessor: (id: string) => Promise<void>;
  run: (sessionId: string, override?: { chain: string[]; disabled: string[] }) => Promise<void>;
  /** A session's enabled chain, filtered to processors that are actually installed. */
  activeInstalledFor: (sessionId: string | null) => string[];
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
      override?: { chain: string[]; disabled: string[] },
    ) => {
      // WHICH processors run is the backend's decision now. `resolve_effective_chain`
      // reads `session_pipeline_meta`, subtracts `disabled`, drops ids that are no
      // longer installed (keeping `@lts-` ones) and appends `__pii_anonymizer` when
      // the session's anonymize flag is on — all of which this hook used to
      // duplicate. So: push the session's chain, then ask for `null`.
      //
      // The push is not optional and not a re-derivation. `usePipelineWiring`
      // debounces its own `setSessionPipelineMeta` by 500ms, so a user who edits
      // the chain and immediately hits Run would otherwise race the timer and run
      // the previous chain. And on the restore path the reducer has not rendered
      // yet, which is why `override` carries the chain directly (reading the ref
      // there yields an empty chain — the bug the override argument exists to fix).
      const own = override ?? chainFor(sessionId);
      dispatch({ type: 'run:started', sessionId });
      try {
        await setSessionPipelineMeta(sessionId, own.chain, own.disabled);
        const result = await runPipeline(sessionId, null);
        // Compute newRunCount before dispatching — the reducer will set runCount to this value.
        const prevState = resultsBySessionRef.current.get(sessionId);
        const newRunCount = (prevState?.runCount ?? 0) + 1;
        dispatch({ type: 'run:complete', sessionId, results: result.summaries, newRunCount });

        // Which processor TYPES ran, read off the chain the backend reports it
        // actually used rather than the one we asked for.
        const chainSet = new Set(result.effectiveProcessorIds);
        const activeProcessors = processorsRef.current.filter((p) => chainSet.has(p.id));
        bus.emit('pipeline:completed', {
          sessionId,
          runCount: newRunCount,
          hasTrackers: activeProcessors.some((p) => p.processorType === 'state_tracker'),
          hasReporters: activeProcessors.some((p) => p.processorType === 'reporter'),
          hasCorrelators: activeProcessors.some((p) => p.processorType === 'correlator'),
        });
      } catch (e) {
        const message = String(e);
        if (message.includes(NO_CHAIN_CONFIGURED)) {
          // Nothing to run. Before the resolution moved server-side this was a
          // silent early return on an empty effective chain, and it stays silent —
          // an empty chain is not a failure the user needs a red banner for.
          dispatch({ type: 'run:stopped', sessionId });
          return;
        }
        dispatch({ type: 'run:failed', sessionId, error: message });
      }
    },
    [dispatch, chainFor],
  );

  const activeInstalledFor = useCallback((sessionId: string | null): string[] => {
    // `start_adb_stream` resolves its explicit id list through
    // `resolve_effective_chain`, which REJECTS an id that is not installed —
    // the whole stream start fails with InvalidArg rather than silently
    // skipping it, as the old backend did. A chain can legitimately hold a
    // dangling id: `processors:loaded` (the refresh a pack uninstall triggers)
    // replaces the library without pruning chains, so the filter happens here.
    // `@lts-` ids are workspace-local processors the backend also exempts.
    const installed = new Set(processorsRef.current.map((p) => p.id));
    return chainFor(sessionId).active.filter((id) => installed.has(id) || id.includes('@lts-'));
  }, [chainFor]);

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
    activeInstalledFor,
    stop,
    getVars,
    clearResults,
  };
}
