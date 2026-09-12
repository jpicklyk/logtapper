/**
 * The analyzer store: the processor catalog, every session's own pipeline
 * chain, and the run/progress/result lifecycle for that chain.
 *
 * Before W4a there was no Solid equivalent of `PipelineContext.tsx` +
 * `usePipelineCommands`/`usePipelineWiring` — this file is that pair,
 * collapsed into one store because Solid has no render-tree context to split
 * across (the "wiring hook vs. action hook" split in `src-next/hooks/CLAUDE.md`
 * exists to stop N mounted copies of an effect; a Solid store already has
 * exactly one instance).
 *
 * What this store deliberately does NOT own:
 *  - Anonymization: `__pii_anonymizer` is backend-appended
 *    (`resolve_effective_chain`) and NEVER user-managed here. `active` (and the
 *    underlying per-session `order`) can never contain it — see
 *    {@link PINNED_TAIL_IDS} — and `pinnedTail()` is the pure display value
 *    W4b renders as a trailing, non-interactive row. Do not reintroduce a
 *    second writer of agent visibility here — see root CLAUDE.md's security
 *    model section.
 *  - Which lines are highlighted/scrolled-to: that is
 *    `src-solid/viewer/controller.ts`'s job. `showMatched`/`clearMatched` are
 *    thin calls into it (`setLineSet(sid, 'filter', …)` + `scrollToLine`).
 *
 * Lifetime: owns a `createRoot` (same pattern as `app/sessions.ts`,
 * `viewer/controller.ts`). `dispose()` unlistens the progress subscription
 * (including a `listen()` promise that settles after disposal) and tears the
 * root down.
 */
import { batch, createEffect, createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, produce, unwrap } from 'solid-js/store';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  listProcessors,
  listPacks,
  loadProcessorFromFile,
  uninstallProcessor,
  setSessionPipelineMeta,
  runPipeline,
  stopPipeline,
  getMatchedLines,
  getCorrelatorEvents,
  getProcessorVars,
} from '@bridge/commands';
import { onPipelineProgress } from '@bridge/events';
import { groupProcessorsByPack } from '@bridge/types';
import type {
  ProcessorSummary,
  PackSummary,
  ProcessorPackGroup,
  PipelineRunResult,
  PipelineRunSummary,
  PipelineProgress,
  MatchedLine,
  CorrelatorResult,
} from '@bridge/types';
// Framework-free localStorage seed for the default chain, shared with the
// React app's key names (`logtapper_pipeline_chain` / `_disabled`) — same
// file the file-level ESLint allow-list on `@hooks` names.
import { loadChainFromStorage, loadDisabledFromStorage } from '@hooks/pipelineChainStorage';

/** Backend-appended, never user-managed. See the module doc's first bullet. */
export const PII_ANONYMIZER_ID = '__pii_anonymizer';

/** Processor IDs that never enter a session's own chain — mirrors
 *  `PipelineContext.tsx`'s `PINNED_TAIL_IDS`, minus the reorder-clamping logic
 *  that set existed to support: since membership itself is refused at `add()`,
 *  a pinned id can never appear in `order` for `reorder`/`toggle` to have to
 *  route around. */
export const PINNED_TAIL_IDS: readonly string[] = [PII_ANONYMIZER_ID];

/** One entry in a session's progress map, straight from the wire payload. */
export interface AnalyzerProgress {
  processorId: string;
  linesProcessed: number;
  totalLines: number;
  percent: number;
}

/** A session's pipeline chain, as W4b reads it. `active` is `order` minus
 *  `disabled`, in `order`'s order — never includes {@link PII_ANONYMIZER_ID}. */
export interface SessionChainSnapshot {
  order: string[];
  disabled: string[];
  active: string[];
}

/** The shape W1a's `createWorkspaceStore({ getPipelineChain })` expects
 *  (`src-solid/workspace/workspaceStore.ts`'s `PipelineChainSnapshot`) — kept
 *  as a structural duplicate rather than an import so this module never
 *  reaches into `../workspace/**`, which is off-limits per the parity plan's
 *  ownership table. */
export interface PipelineChainSnapshot {
  chain: string[];
  disabledIds: string[];
}

/** A workspace restore's chain payload — the shape `WorkspaceRestoredEvent`
 *  (`activeProcessorIds`/`disabledProcessorIds`) and a legacy `.ltw`'s
 *  top-level `pipelineChain`/`disabledChainIds` both reduce to. */
export interface RestoredChain {
  chain: string[];
  disabledChainIds: string[];
}

/** The slice of W0b's session store this store reads — structural, so a test
 *  can pass a literal instead of a real `SessionStore`. Used only to prune
 *  per-session chain/run state when a session closes (mirrors
 *  `PipelineContext`'s `session:removed` action, without a bus: nothing here
 *  keys off session lifecycle events the way `usePipelineWiring` does). */
export interface AnalyzerSessions {
  order(): readonly string[];
}

/** The slice of W0a's `ViewerController` this store drives. Structural on
 *  purpose (see `AnalyzerSessions`) — the real controller satisfies it as-is. */
export interface AnalyzerController {
  setLineSet(sessionId: string, key: 'filter', lines: Set<number> | null): void;
  scrollToLine(sessionId: string, line: number, opts?: { source?: 'user' | 'agent' | 'search' | 'analysis' }): void;
}

/** Bridge commands this store calls, injected so tests never touch real IPC. */
export interface AnalyzerCommands {
  listProcessors(): Promise<ProcessorSummary[]>;
  listPacks(): Promise<PackSummary[]>;
  loadProcessorFromFile(path: string): Promise<ProcessorSummary>;
  uninstallProcessor(id: string): Promise<void>;
  setSessionPipelineMeta(sessionId: string, active: string[], disabled: string[]): Promise<void>;
  runPipeline(sessionId: string, processorIds: string[] | null): Promise<PipelineRunResult>;
  stopPipeline(): Promise<void>;
  getMatchedLines(sessionId: string, processorId: string): Promise<MatchedLine[]>;
  getCorrelatorEvents(sessionId: string, correlatorId: string): Promise<CorrelatorResult>;
  getProcessorVars(sessionId: string, processorId: string): Promise<Record<string, unknown>>;
}

const defaultCommands: AnalyzerCommands = {
  listProcessors,
  listPacks,
  loadProcessorFromFile,
  uninstallProcessor,
  setSessionPipelineMeta,
  runPipeline,
  stopPipeline,
  getMatchedLines,
  getCorrelatorEvents,
  getProcessorVars,
};

export interface AnalyzerStoreDeps {
  sessions: AnalyzerSessions;
  controller: AnalyzerController;
  /** Injected for tests; defaults to `onPipelineProgress`. */
  listen?: (cb: (payload: PipelineProgress) => void) => Promise<UnlistenFn>;
  /** Injected for tests; defaults to the real bridge wrappers. */
  commands?: AnalyzerCommands;
  /** Injected for tests; defaults to the Tauri native dialog. */
  chooseFile?: typeof openDialog;
}

export interface AnalyzerStore {
  // ── Catalog ──────────────────────────────────────────────────────────────
  catalog: Accessor<ProcessorSummary[]>;
  packs: Accessor<PackSummary[]>;
  /** Re-fetch the catalog + packs. Call after install/uninstall/load-from-file. */
  refreshCatalog(): Promise<void>;
  byId(processorId: string): ProcessorSummary | undefined;
  groups(): { packGroups: ProcessorPackGroup[]; standaloneProcessors: ProcessorSummary[] };
  /** Active `state_tracker`s in this session's chain, for W5. */
  trackers(sessionId: string): ProcessorSummary[];

  // ── Per-session chain ────────────────────────────────────────────────────
  /** The display-only trailing row W4b renders — never user-editable here. */
  pinnedTail(): string[];
  chain(sessionId: string): SessionChainSnapshot;
  add(sessionId: string, processorId: string): void;
  remove(sessionId: string, processorId: string): void;
  toggle(sessionId: string, processorId: string): void;
  reorder(sessionId: string, fromIndex: number, toIndex: number): void;
  /** Reset this session's chain back to the shared template. */
  resetToDefault(sessionId: string): void;

  // ── Run lifecycle ────────────────────────────────────────────────────────
  running(sessionId: string): boolean;
  progress(sessionId: string): ReadonlyMap<string, AnalyzerProgress>;
  result(sessionId: string): PipelineRunResult | null;
  lastError(sessionId: string): string | null;
  lastRunAt(sessionId: string): number | null;
  /** Push this session's chain then run it. Bumps the run generation first. */
  run(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;

  // ── Result helpers ───────────────────────────────────────────────────────
  summaryFor(sessionId: string, processorId: string): PipelineRunSummary | undefined;
  /** Cached per run generation — repeat calls within one run reuse the promise. */
  matchedLines(sessionId: string, processorId: string): Promise<MatchedLine[]>;
  /** Cached per run generation, same as {@link matchedLines}. */
  correlatorEvents(sessionId: string, processorId: string): Promise<CorrelatorResult>;
  vars(sessionId: string, processorId: string): Promise<Record<string, unknown>>;
  showMatched(sessionId: string, processorId: string): Promise<void>;
  clearMatched(sessionId: string): void;

  // ── Install flow ─────────────────────────────────────────────────────────
  installFromFile(): Promise<void>;
  /** Removes the id from every session's (and the default's) chain first. */
  uninstall(processorId: string): Promise<void>;

  // ── Providers for other packages ────────────────────────────────────────
  /** What W1a's `createWorkspaceStore({ getPipelineChain })` reads on save. */
  pipelineChainProvider(): PipelineChainSnapshot;
  /**
   * Apply a restored chain. With a `sessionId`, sets that session's own chain
   * (the path every real restore — `WorkspaceRestoredEvent` — takes). With
   * `null`/omitted, this is the legacy single-chain-workspace path from
   * `PipelineContext.tsx`'s `chain:restore` action: it sets the shared
   * template AND back-fills every open session that has no chain of its own,
   * so an old workspace with one global chain restores onto every tab.
   */
  applyWorkspaceChain(chain: RestoredChain, sessionId?: string | null): void;

  dispose(): void;
}

interface SessionChain {
  /** Never contains {@link PII_ANONYMIZER_ID} — enforced at every write site. */
  order: string[];
  disabled: Set<string>;
}

const emptyChain = (): SessionChain => ({ order: [], disabled: new Set() });

function toSnapshot(c: SessionChain): SessionChainSnapshot {
  return {
    order: [...c.order],
    disabled: [...c.disabled],
    active: c.order.filter((id) => !c.disabled.has(id)),
  };
}

interface SessionRun {
  running: boolean;
  runGeneration: number;
  progress: Map<string, AnalyzerProgress>;
  result: PipelineRunResult | null;
  lastError: string | null;
  lastRunAt: number | null;
}

const emptyRun = (): SessionRun => ({
  running: false,
  runGeneration: 0,
  progress: new Map(),
  result: null,
  lastError: null,
  lastRunAt: null,
});

/** `services::pipeline::resolve_effective_chain`'s refusal when a session has
 *  no chain to run — see `usePipelineCommands.ts`'s identical match. Matched
 *  as a substring because the backend interpolates the session id into it. */
const NO_CHAIN_CONFIGURED = 'no pipeline chain configured';

/** One run's result-fetch cache, replaced wholesale when the generation moves
 *  on so a stale promise is never handed to a caller asking about a new run. */
interface RunCache {
  generation: number;
  matchedLines: Map<string, Promise<MatchedLine[]>>;
  correlatorEvents: Map<string, Promise<CorrelatorResult>>;
}

function freshCache(generation: number): RunCache {
  return { generation, matchedLines: new Map(), correlatorEvents: new Map() };
}

export function createAnalyzerStore(deps: AnalyzerStoreDeps): AnalyzerStore {
  const { sessions, controller } = deps;
  const commands = deps.commands ?? defaultCommands;
  const listen = deps.listen ?? onPipelineProgress;
  const chooseFile = deps.chooseFile ?? openDialog;

  return createRoot((disposeRoot) => {
    const [catalog, setCatalog] = createSignal<ProcessorSummary[]>([]);
    const [packs, setPacks] = createSignal<PackSummary[]>([]);
    const [defaultTemplate, setDefaultTemplate] = createSignal<SessionChain>(emptyChain());

    const [chains, setChains] = createStore<Record<string, SessionChain>>({});
    const [runs, setRuns] = createStore<Record<string, SessionRun>>({});
    // Not store-backed: these are fetch-result caches, not render state, and a
    // `Map`/nested-object churn per fetch would just fight `createStore`'s
    // diffing for no reactive benefit (nothing renders directly off a cache).
    const runCaches = new Map<string, RunCache>();

    let disposed = false;
    let templateSeeded = false;
    const unlisteners: UnlistenFn[] = [];

    /** Unlisten-safe subscribe — a promise that settles after `dispose()`
     *  unlistens itself instead of leaking. Same pattern as `app/sessions.ts`. */
    const track = (pending: Promise<UnlistenFn>): void => {
      void pending
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch(() => undefined);
    };

    // ── Catalog ──────────────────────────────────────────────────────────
    const currentChain = (sessionId: string): SessionChain => chains[sessionId] ?? defaultTemplate();
    const currentRun = (sessionId: string): SessionRun => runs[sessionId] ?? emptyRun();

    const refreshCatalog = async (): Promise<void> => {
      const [list, pk] = await Promise.all([commands.listProcessors(), commands.listPacks()]);
      batch(() => {
        setCatalog(list);
        setPacks(pk);
      });
      // Seed the shared default ONCE, from whatever the React app (or a prior
      // Solid session) last persisted — never re-seed on a later refresh, or
      // an install/uninstall would silently reset every un-forked session's
      // effective chain back to the localStorage snapshot.
      if (!templateSeeded) {
        templateSeeded = true;
        const validIds = new Set(list.map((p) => p.id));
        const chainIds = loadChainFromStorage(validIds).filter((id) => id !== PII_ANONYMIZER_ID);
        const disabledIds = loadDisabledFromStorage(new Set(chainIds));
        setDefaultTemplate({ order: chainIds, disabled: new Set(disabledIds) });
      }
    };

    const byId = (processorId: string): ProcessorSummary | undefined =>
      catalog().find((p) => p.id === processorId);

    const groups = (): { packGroups: ProcessorPackGroup[]; standaloneProcessors: ProcessorSummary[] } =>
      groupProcessorsByPack(catalog(), packs());

    const trackers = (sessionId: string): ProcessorSummary[] => {
      const active = new Set(toSnapshot(currentChain(sessionId)).active);
      return catalog().filter((p) => p.processorType === 'state_tracker' && active.has(p.id));
    };

    // ── Per-session chain ────────────────────────────────────────────────
    const pinnedTail = (): string[] => [...PINNED_TAIL_IDS];

    const chain = (sessionId: string): SessionChainSnapshot => toSnapshot(currentChain(sessionId));

    const add = (sessionId: string, processorId: string): void => {
      if (PINNED_TAIL_IDS.includes(processorId)) return; // invariant: never user-added
      const cur = currentChain(sessionId);
      if (cur.order.includes(processorId)) return;
      setChains(sessionId, { order: [...cur.order, processorId], disabled: new Set(cur.disabled) });
    };

    const remove = (sessionId: string, processorId: string): void => {
      const cur = currentChain(sessionId);
      if (!cur.order.includes(processorId)) return;
      const disabled = new Set(cur.disabled);
      disabled.delete(processorId);
      setChains(sessionId, { order: cur.order.filter((id) => id !== processorId), disabled });
    };

    const toggle = (sessionId: string, processorId: string): void => {
      const cur = currentChain(sessionId);
      if (!cur.order.includes(processorId)) return;
      const disabled = new Set(cur.disabled);
      if (disabled.has(processorId)) disabled.delete(processorId);
      else disabled.add(processorId);
      setChains(sessionId, { order: [...cur.order], disabled });
    };

    const reorder = (sessionId: string, fromIndex: number, toIndex: number): void => {
      const cur = currentChain(sessionId);
      const len = cur.order.length;
      if (len === 0) return;
      const from = Math.max(0, Math.min(fromIndex, len - 1));
      const to = Math.max(0, Math.min(toIndex, len - 1));
      if (from === to) return;
      const order = [...cur.order];
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      setChains(sessionId, { order, disabled: new Set(cur.disabled) });
    };

    const resetToDefault = (sessionId: string): void => {
      const tpl = defaultTemplate();
      setChains(sessionId, { order: [...tpl.order], disabled: new Set(tpl.disabled) });
    };

    // ── Run lifecycle ────────────────────────────────────────────────────
    const running = (sessionId: string): boolean => currentRun(sessionId).running;
    const progress = (sessionId: string): ReadonlyMap<string, AnalyzerProgress> => currentRun(sessionId).progress;
    const result = (sessionId: string): PipelineRunResult | null => currentRun(sessionId).result;
    const lastError = (sessionId: string): string | null => currentRun(sessionId).lastError;
    const lastRunAt = (sessionId: string): number | null => currentRun(sessionId).lastRunAt;

    const run = async (sessionId: string): Promise<void> => {
      const own = toSnapshot(currentChain(sessionId));
      const myGeneration = currentRun(sessionId).runGeneration + 1;
      setRuns(sessionId, {
        ...currentRun(sessionId),
        running: true,
        runGeneration: myGeneration,
        progress: new Map(),
        lastError: null,
      });
      try {
        await commands.setSessionPipelineMeta(sessionId, own.active, own.disabled);
        const runResult = await commands.runPipeline(sessionId, null);
        // A newer `run()` call for this session superseded this one while the
        // IPC round trip was in flight — its state must win, not ours.
        if (currentRun(sessionId).runGeneration !== myGeneration) return;
        setRuns(sessionId, { ...currentRun(sessionId), running: false, result: runResult, lastRunAt: Date.now() });
      } catch (e) {
        if (currentRun(sessionId).runGeneration !== myGeneration) return;
        const message = String(e);
        if (message.includes(NO_CHAIN_CONFIGURED)) {
          // Nothing to run — not a failure the user needs a red banner for,
          // same silent treatment as `usePipelineCommands.ts`.
          setRuns(sessionId, { ...currentRun(sessionId), running: false });
          return;
        }
        setRuns(sessionId, { ...currentRun(sessionId), running: false, lastError: message });
      }
    };

    const stop = async (sessionId: string): Promise<void> => {
      try {
        await commands.stopPipeline();
      } finally {
        setRuns(sessionId, { ...currentRun(sessionId), running: false });
      }
    };

    // ── Progress ─────────────────────────────────────────────────────────
    // The wire payload carries no run-generation token, so the guard this can
    // actually enforce is: accept a processor's progress only while THIS store
    // believes a run is in flight for that session (an event for a session
    // this store never started, or one that already settled/stopped, is
    // dropped) — and starting a new run clears the map so stale entries from
    // the previous run never linger into a fresh one. The genuinely stale-
    // generation race (an old run's *settlement* arriving after a newer run
    // started) is guarded separately in `run()`, which compares the captured
    // generation against the session's current one before writing `result`/
    // `lastError`.
    track(
      listen((payload) => {
        if (disposed) return;
        const row = runs[payload.sessionId];
        if (!row || !row.running) return;
        const next = new Map(row.progress);
        next.set(payload.processorId, {
          processorId: payload.processorId,
          linesProcessed: payload.linesProcessed,
          totalLines: payload.totalLines,
          percent: payload.percent,
        });
        setRuns(payload.sessionId, 'progress', next);
      }),
    );

    // ── Result helpers ───────────────────────────────────────────────────
    const summaryFor = (sessionId: string, processorId: string): PipelineRunSummary | undefined =>
      currentRun(sessionId).result?.summaries.find((s) => s.processorId === processorId);

    const ensureCache = (sessionId: string, generation: number): RunCache => {
      const existing = runCaches.get(sessionId);
      if (existing && existing.generation === generation) return existing;
      const cache = freshCache(generation);
      runCaches.set(sessionId, cache);
      return cache;
    };

    const matchedLines = (sessionId: string, processorId: string): Promise<MatchedLine[]> => {
      const cache = ensureCache(sessionId, currentRun(sessionId).runGeneration);
      let p = cache.matchedLines.get(processorId);
      if (!p) {
        p = commands.getMatchedLines(sessionId, processorId);
        cache.matchedLines.set(processorId, p);
      }
      return p;
    };

    const correlatorEvents = (sessionId: string, processorId: string): Promise<CorrelatorResult> => {
      const cache = ensureCache(sessionId, currentRun(sessionId).runGeneration);
      let p = cache.correlatorEvents.get(processorId);
      if (!p) {
        p = commands.getCorrelatorEvents(sessionId, processorId);
        cache.correlatorEvents.set(processorId, p);
      }
      return p;
    };

    const vars = (sessionId: string, processorId: string): Promise<Record<string, unknown>> =>
      commands.getProcessorVars(sessionId, processorId);

    const showMatched = async (sessionId: string, processorId: string): Promise<void> => {
      const lines = await matchedLines(sessionId, processorId);
      const nums = lines.map((l) => l.lineNum).sort((a, b) => a - b);
      controller.setLineSet(sessionId, 'filter', new Set(nums));
      if (nums.length > 0) controller.scrollToLine(sessionId, nums[0], { source: 'user' });
    };

    const clearMatched = (sessionId: string): void => {
      controller.setLineSet(sessionId, 'filter', null);
    };

    // ── Install flow ─────────────────────────────────────────────────────
    const PROCESSOR_FILE_FILTERS = [
      { name: 'Processor YAML', extensions: ['yaml', 'yml'] },
      { name: 'All Files', extensions: ['*'] },
    ];

    const installFromFile = async (): Promise<void> => {
      const selected = await chooseFile({ multiple: false, filters: PROCESSOR_FILE_FILTERS });
      if (typeof selected !== 'string') return;
      await commands.loadProcessorFromFile(selected);
      await refreshCatalog();
    };

    const dropFromEveryChain = (processorId: string): void => {
      batch(() => {
        for (const sessionId of Object.keys(chains)) {
          const cur = chains[sessionId];
          if (!cur.order.includes(processorId)) continue;
          const disabled = new Set(cur.disabled);
          disabled.delete(processorId);
          setChains(sessionId, { order: cur.order.filter((id) => id !== processorId), disabled });
        }
        const tpl = defaultTemplate();
        if (tpl.order.includes(processorId)) {
          const disabled = new Set(tpl.disabled);
          disabled.delete(processorId);
          setDefaultTemplate({ order: tpl.order.filter((id) => id !== processorId), disabled });
        }
      });
    };

    const uninstall = async (processorId: string): Promise<void> => {
      // Every session's chain first — an uninstalled processor must not linger
      // as a dangling id anywhere, mirroring `processor:removed`'s reducer case.
      dropFromEveryChain(processorId);
      await commands.uninstallProcessor(processorId);
      await refreshCatalog();
    };

    // ── Providers for other packages ─────────────────────────────────────
    const pipelineChainProvider = (): PipelineChainSnapshot => {
      const tpl = defaultTemplate();
      return { chain: [...tpl.order], disabledIds: [...tpl.disabled] };
    };

    const applyWorkspaceChain = (restored: RestoredChain, sessionId: string | null = null): void => {
      const cleanOrder = restored.chain.filter((id) => id !== PII_ANONYMIZER_ID);
      const cleanDisabled = new Set(restored.disabledChainIds.filter((id) => cleanOrder.includes(id)));
      const next: SessionChain = { order: cleanOrder, disabled: cleanDisabled };

      if (sessionId) {
        setChains(sessionId, next);
        const active = cleanOrder.filter((id) => !cleanDisabled.has(id));
        void commands.setSessionPipelineMeta(sessionId, active, [...cleanDisabled]).catch(() => undefined);
        return;
      }

      // Legacy path: an old, pre-v4 single-chain workspace. Sets the shared
      // template AND back-fills every open session that has no chain of its
      // own — a session that already diverged keeps its own chain, exactly as
      // `PipelineContext.tsx`'s `chain:restore` reducer case does.
      batch(() => {
        setDefaultTemplate(next);
        for (const id of sessions.order()) {
          if (!chains[id]) setChains(id, { order: [...next.order], disabled: new Set(next.disabled) });
        }
      });
    };

    // ── Session cleanup ──────────────────────────────────────────────────
    // Prunes chain/run state for sessions that have closed, so the two records
    // don't grow unbounded across a long-lived app the way `PipelineContext`'s
    // own `session:removed` action guards against.
    createEffect(() => {
      const known = new Set(sessions.order());
      const staleChains = Object.keys(unwrap(chains)).filter((id) => !known.has(id));
      const staleRuns = Object.keys(unwrap(runs)).filter((id) => !known.has(id));
      if (staleChains.length === 0 && staleRuns.length === 0) return;
      batch(() => {
        if (staleChains.length > 0) {
          setChains(produce((draft) => { for (const id of staleChains) delete draft[id]; }));
        }
        if (staleRuns.length > 0) {
          setRuns(produce((draft) => { for (const id of staleRuns) delete draft[id]; }));
        }
      });
      // A session can be stale in one record and not the other (e.g. `run()`
      // was never called for it), so sweep the union rather than assume the
      // two lists match.
      for (const id of new Set([...staleChains, ...staleRuns])) runCaches.delete(id);
    });

    // Kick off the first catalog load. Fire-and-forget: callers read `catalog()`
    // reactively and see it populate when this resolves.
    void refreshCatalog();

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const fn of unlisteners) fn();
      unlisteners.length = 0;
      runCaches.clear();
      disposeRoot();
    };

    return {
      catalog,
      packs,
      refreshCatalog,
      byId,
      groups,
      trackers,
      pinnedTail,
      chain,
      add,
      remove,
      toggle,
      reorder,
      resetToDefault,
      running,
      progress,
      result,
      lastError,
      lastRunAt,
      run,
      stop,
      summaryFor,
      matchedLines,
      correlatorEvents,
      vars,
      showMatched,
      clearMatched,
      installFromFile,
      uninstall,
      pipelineChainProvider,
      applyWorkspaceChain,
      dispose,
    };
  });
}
