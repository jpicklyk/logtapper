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
 *
 * ## Live counters (L3, task `2439a7c5`)
 *
 * `applyProcessorUpdates`/`applyProcessorsExcluded` fold a live ADB stream's
 * `AdbProcessorUpdate`/`AdbProcessorsExcluded` Channel messages into the same
 * `SessionRun.result.summaries` shape `run()` produces from a file-mode
 * `PipelineRunResult` — so `AnalyzerCard`'s existing `props.summary?.skipped`
 * / matched-lines rendering needs zero branching for "was this session's
 * result produced by a run or by a stream." This ports React's
 * `PipelineContext.tsx` reducer cases `adb:results-batch` (`mergeProcessorResult`)
 * and `adb:processors-excluded` (`applyExcludedProcessors`, shipped in
 * `38b9ed2`) as pure functions plus two store methods, rather than a second
 * reducer — this store already holds `SessionRun.result` directly (no
 * `useReducer` to dispatch into), so folding is a plain read-modify-write on
 * the `runs` `createStore`. Deliberately NOT gated behind `running(sessionId)`
 * or any run-generation check: a live stream's counters are not a "run" in
 * the `run()`/`guardFor` sense at all (there is no discrete start/settle to
 * race), so `guardFor`/`runCaches` are untouched by either method — matching
 * `matchedLines`/`correlatorEvents`'s existing per-run caches, which simply
 * never get consulted for a session that has no post-mortem run at all.
 * `viewer/createStreamSession.ts` (via `stream/streamStore.ts`) is the sole
 * caller today, batching multiple `AdbProcessorUpdate`s per Channel flush
 * before calling `applyProcessorUpdates` once — see that module's doc.
 *
 * ## The chain is shared session state (F1)
 *
 * The backend's `session_pipeline_meta` is the single source of truth for a
 * session's chain, written by this store AND by an agent (`PUT`/`PATCH
 * …/chain`, or the run-merge of an explicit-ids `run_pipeline`). So:
 *
 *  - **Push on edit.** Every local chain edit (`add`/`remove`/`toggle`/
 *    `reorder`/`resetToDefault`) schedules one microtask-coalesced
 *    `setSessionPipelineMeta(sid, order, disabled)` — a burst of edits in one
 *    tick is one IPC call. `activeProcessorIds` is always the FULL ordered
 *    chain (disabled members included), matching the backend contract and
 *    the React app; sending `active` (= order − disabled) silently dropped
 *    disabled analyzers from the backend's chain and from `.ltw` saves.
 *  - **`chain-update` is applied only for a non-`ui` caller.** Our own writes
 *    are already local state; applying their echo would race an edit that is
 *    still waiting for its coalesced push. An agent's change replaces the
 *    session's chain wholesale (anonymizer stripped), and each id it newly
 *    introduced is remembered in `addedBy` until that id leaves the chain by
 *    any path — that is what `AnalyzerCard`'s "Added" badge reads.
 *  - **Foreign runs** (an agent's `run_pipeline`) are visible here too — see
 *    the progress/complete handlers' comment for the rule.
 */
import { batch, createEffect, createRoot, createSignal, untrack } from 'solid-js';
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
  getSessionChain,
  runPipeline,
  stopPipeline,
  getMatchedLines,
  getCorrelatorEvents,
  getProcessorVars,
} from '@bridge/commands';
import { onPipelineProgress, onChainUpdate, onPipelineComplete, onWorkspaceRestored } from '@bridge/events';
import { groupProcessorsByPack } from '@bridge/types';
import type {
  Caller,
  ProcessorSummary,
  PackSummary,
  ProcessorPackGroup,
  PipelineRunResult,
  PipelineRunSummary,
  PipelineProgress,
  PipelineCompleteEvent,
  ChainUpdateEvent,
  ChainState,
  WorkspaceRestoredEvent,
  MatchedLine,
  CorrelatorResult,
  AdbProcessorUpdate,
  AdbExcludedProcessor,
} from '@bridge/types';
// Framework-free localStorage seed for the default chain, shared with the
// React app's key names (`logtapper_pipeline_chain` / `_disabled`) — same
// file the file-level ESLint allow-list on `@hooks` names.
import { loadChainFromStorage, loadDisabledFromStorage } from '@hooks/pipelineChainStorage';
import { coalesceMicrotask, createGenerationGuard } from '../reactive';
import type { GenerationGuard } from '../reactive';

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
  getSessionChain(sessionId: string): Promise<ChainState>;
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
  getSessionChain,
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
  /** Injected for tests; defaults to `onChainUpdate`. */
  listenChain?: (cb: (payload: ChainUpdateEvent) => void) => Promise<UnlistenFn>;
  /** Injected for tests; defaults to `onPipelineComplete`. */
  listenComplete?: (cb: (payload: PipelineCompleteEvent) => void) => Promise<UnlistenFn>;
  /** Injected for tests; defaults to `onWorkspaceRestored`. */
  listenRestored?: (cb: (payload: WorkspaceRestoredEvent) => void) => Promise<UnlistenFn>;
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
  /** Who introduced `processorId` into this session's chain, when that was
   *  an agent (via a `chain-update` this store applied). `null` for an id
   *  the user added, one restored from a workspace, or one no longer in the
   *  chain. */
  addedBy(sessionId: string, processorId: string): Caller | null;

  // ── Run lifecycle ────────────────────────────────────────────────────────
  running(sessionId: string): boolean;
  progress(sessionId: string): ReadonlyMap<string, AnalyzerProgress>;
  result(sessionId: string): PipelineRunResult | null;
  lastError(sessionId: string): string | null;
  lastRunAt(sessionId: string): number | null;
  /** Push this session's full chain then run it. Bumps the run generation first. */
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

  // ── Live counters (L3) ───────────────────────────────────────────────────
  /** Fold one flush's worth of live `AdbProcessorUpdate`s into this session's
   *  result — see the module doc's "Live counters" section. No-op for an
   *  empty array. */
  applyProcessorUpdates(sessionId: string, updates: AdbProcessorUpdate[]): void;
  /** Fold the current declared-`source_types` exclusion set for a live
   *  stream into this session's result — see the module doc. */
  applyProcessorsExcluded(sessionId: string, excluded: AdbExcludedProcessor[]): void;

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
  progress: Map<string, AnalyzerProgress>;
  result: PipelineRunResult | null;
  lastError: string | null;
  lastRunAt: number | null;
}

const emptyRun = (): SessionRun => ({
  running: false,
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

/** Bookkeeping for one session's own `run()` — see `ownRuns` in the store.
 *  `settled`: the latest own promise has resolved or rejected;
 *  `awaitingCompletes`: `runPipeline` invokes whose `pipeline-complete(ui)`
 *  has not arrived yet. Own mode ends when settled and nothing is awaited. */
interface OwnRunState {
  settled: boolean;
  awaitingCompletes: number;
}

/**
 * Fold one processor's live streaming counters into a summaries array,
 * replacing any pre-existing entry for the same processor (including
 * dropping a stale `skipped` — a real update means the processor did run,
 * not that it was excluded) or appending a new one. Pure — exported for unit
 * tests. Mirrors React's `PipelineContext.tsx`'s `mergeProcessorResult`;
 * `scriptErrors`/`scannedFrom` are 0 because `AdbProcessorUpdate` doesn't
 * carry them, the same "not applicable / not yet known" default file-mode
 * runs use.
 */
export function mergeProcessorResult(
  summaries: readonly PipelineRunSummary[],
  processorId: string,
  matchedLines: number,
  emissionCount: number,
): PipelineRunSummary[] {
  const idx = summaries.findIndex((s) => s.processorId === processorId);
  const updated: PipelineRunSummary = { processorId, matchedLines, emissionCount, scriptErrors: 0, scannedFrom: 0 };
  return idx >= 0
    ? summaries.map((s, i) => (i === idx ? updated : s))
    : [...summaries, updated];
}

/**
 * Fold the backend's current declared-`source_types` exclusion set for a
 * live stream into the same summaries shape, so `AnalyzerCard`'s
 * `props.summary?.skipped` renders the identical n/a row for either path
 * with no stream-specific branch. Pure — exported for unit tests. Mirrors
 * React's `PipelineContext.tsx`'s `applyExcludedProcessors` (shipped
 * `38b9ed2`): `excluded` is the *complete* current set, so every existing
 * entry whose `skipped.reason` is `'source_type_mismatch'` but whose id is
 * no longer in `excluded` is cleared (the processor became eligible again,
 * e.g. after a chain change), and every id in `excluded` gets `skipped` set,
 * creating a new zero-count entry when the processor has not produced any
 * update yet.
 */
export function applyExcludedProcessors(
  summaries: readonly PipelineRunSummary[],
  excluded: readonly AdbExcludedProcessor[],
): PipelineRunSummary[] {
  const excludedIds = new Set(excluded.map((e) => e.processorId));
  const cleared = summaries.map((s) =>
    s.skipped?.reason === 'source_type_mismatch' && !excludedIds.has(s.processorId)
      ? { ...s, skipped: undefined }
      : s,
  );
  let result = cleared;
  for (const { processorId, skip } of excluded) {
    const idx = result.findIndex((s) => s.processorId === processorId);
    result =
      idx >= 0
        ? result.map((s, i) => (i === idx ? { ...s, skipped: skip } : s))
        : [...result, { processorId, matchedLines: 0, emissionCount: 0, scriptErrors: 0, scannedFrom: 0, skipped: skip }];
  }
  return result;
}

export function createAnalyzerStore(deps: AnalyzerStoreDeps): AnalyzerStore {
  const { sessions, controller } = deps;
  const commands = deps.commands ?? defaultCommands;
  const listen = deps.listen ?? onPipelineProgress;
  const listenChain = deps.listenChain ?? onChainUpdate;
  const listenComplete = deps.listenComplete ?? onPipelineComplete;
  const listenRestored = deps.listenRestored ?? onWorkspaceRestored;
  const chooseFile = deps.chooseFile ?? openDialog;

  return createRoot((disposeRoot) => {
    const [catalog, setCatalog] = createSignal<ProcessorSummary[]>([]);
    const [packs, setPacks] = createSignal<PackSummary[]>([]);
    const [defaultTemplate, setDefaultTemplate] = createSignal<SessionChain>(emptyChain());

    const [chains, setChains] = createStore<Record<string, SessionChain>>({});
    // Per session, which chain members an agent introduced (see the module
    // doc's "shared session state" section). Store-backed because a card
    // renders a badge off it. Pruned whenever an id leaves the chain.
    const [addedByAgent, setAddedByAgent] = createStore<Record<string, Record<string, Caller>>>({});
    const [runs, setRuns] = createStore<Record<string, SessionRun>>({});
    // Not store-backed: these are fetch-result caches, not render state, and a
    // `Map`/nested-object churn per fetch would just fight `createStore`'s
    // diffing for no reactive benefit (nothing renders directly off a cache).
    const runCaches = new Map<string, RunCache>();
    // One run-generation guard per session, external to the reactive `runs`
    // store for the same reason `runCaches` is: nothing renders a generation
    // number, so it doesn't belong in store-tracked state.
    const runGuards = new Map<string, GenerationGuard>();
    // The generation token of a foreign (agent-started) run this store is
    // currently mirroring, per session — set when its first progress arrives,
    // consumed by its `pipeline-complete`. A newer own `run()` bumps past it,
    // which is how a late foreign completion is recognised and dropped.
    const foreignRuns = new Map<string, number>();
    // Sessions with an own `run()` "in flight" in the wide sense: from the
    // `run()` call until BOTH its promise has settled AND its
    // `pipeline-complete(ui)` has arrived. `running` alone cannot serve —
    // `stop()` clears it as soon as `stopPipeline()` resolves, but the
    // backend only checks the cancel flag once per chunk AFTER emitting that
    // chunk's progress, so trailing progress lands on an idle row; and an
    // own run's final progress can trail its promise if the event channel
    // lags the invoke response. While a session is in here, progress never
    // starts a foreign run (see the handler). The backend emits the ui
    // complete BEFORE the promise resolves and the event channel is ordered,
    // so "complete seen" bounds every own progress event.
    const ownRuns = new Map<string, OwnRunState>();
    // One coalesced push per session (see `schedulePush`).
    const pushers = new Map<string, () => void>();

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

    const guardFor = (sessionId: string): GenerationGuard => {
      let guard = runGuards.get(sessionId);
      if (!guard) {
        guard = createGenerationGuard();
        runGuards.set(sessionId, guard);
      }
      return guard;
    };

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

    /** The one writer of `chains[sid]`. Also forgets `addedBy` for any id
     *  that is no longer a member — the badge must never outlive the row,
     *  whichever path (user remove, agent replace, reset, restore, uninstall)
     *  took the id out. */
    const setSessionChain = (sessionId: string, next: SessionChain): void => {
      batch(() => {
        setChains(sessionId, next);
        const recorded = addedByAgent[sessionId];
        if (!recorded) return;
        const gone = Object.keys(recorded).filter((id) => !next.order.includes(id));
        if (gone.length === 0) return;
        setAddedByAgent(sessionId, produce((draft) => { for (const id of gone) delete draft[id]; }));
      });
    };

    /** Push this session's chain to the backend once per tick, however many
     *  edits land in that tick. The backend is the source of truth for the
     *  chain (an agent reads and writes it there), so an unpushed local edit
     *  is an edit an agent cannot see. Fire-and-forget: a refused push (an
     *  uninstalled bare id, a session that closed meanwhile) is not a UI
     *  error the user can act on, same as `applyWorkspaceChain`'s. */
    const schedulePush = (sessionId: string): void => {
      let push = pushers.get(sessionId);
      if (!push) {
        push = coalesceMicrotask(() => {
          if (disposed) return;
          // A deferred imperative read, deliberately outside any tracked
          // scope — the microtask is not an effect and must not become one.
          const cur = untrack(() => chains[sessionId]);
          if (!cur) return; // pruned (session closed) before the microtask ran
          void commands.setSessionPipelineMeta(sessionId, [...cur.order], [...cur.disabled]).catch(() => undefined);
        });
        pushers.set(sessionId, push);
      }
      push();
    };

    const add = (sessionId: string, processorId: string): void => {
      if (PINNED_TAIL_IDS.includes(processorId)) return; // invariant: never user-added
      const cur = currentChain(sessionId);
      if (cur.order.includes(processorId)) return;
      setSessionChain(sessionId, { order: [...cur.order, processorId], disabled: new Set(cur.disabled) });
      schedulePush(sessionId);
    };

    const remove = (sessionId: string, processorId: string): void => {
      const cur = currentChain(sessionId);
      if (!cur.order.includes(processorId)) return;
      const disabled = new Set(cur.disabled);
      disabled.delete(processorId);
      setSessionChain(sessionId, { order: cur.order.filter((id) => id !== processorId), disabled });
      schedulePush(sessionId);
    };

    const toggle = (sessionId: string, processorId: string): void => {
      const cur = currentChain(sessionId);
      if (!cur.order.includes(processorId)) return;
      const disabled = new Set(cur.disabled);
      if (disabled.has(processorId)) disabled.delete(processorId);
      else disabled.add(processorId);
      setSessionChain(sessionId, { order: [...cur.order], disabled });
      schedulePush(sessionId);
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
      setSessionChain(sessionId, { order, disabled: new Set(cur.disabled) });
      schedulePush(sessionId);
    };

    const resetToDefault = (sessionId: string): void => {
      const tpl = defaultTemplate();
      setSessionChain(sessionId, { order: [...tpl.order], disabled: new Set(tpl.disabled) });
      schedulePush(sessionId);
    };

    const addedBy = (sessionId: string, processorId: string): Caller | null =>
      addedByAgent[sessionId]?.[processorId] ?? null;

    /** Mirror a chain the backend already holds (a restore, or a read-back)
     *  onto one session. An empty backend chain leaves the session on the
     *  shared template, as it always did. */
    const applyBackendChain = (
      state: { activeProcessorIds: string[]; disabledProcessorIds: string[] },
      sessionId: string,
    ): void => {
      if (state.activeProcessorIds.length === 0) return;
      applyWorkspaceChain({ chain: state.activeProcessorIds, disabledChainIds: state.disabledProcessorIds }, sessionId);
    };

    // A workspace restore put this session's saved chain into the backend
    // (`workspace/restore.ts` → `restoreWorkspaceSession`); mirror it here or
    // the panel shows an empty chain the first edit would then push back over
    // the backend's restored one. React's `useWorkspaceRestore` does the same.
    // A legacy workspace with no per-session chain sends an empty list and
    // leaves the session on the shared template, as it always did.
    track(
      listenRestored((payload) => {
        if (disposed) return;
        applyBackendChain(payload, payload.sessionId);
      }),
    );

    // An agent changed this session's chain (or an explicit-ids agent run
    // merged into it). Replace wholesale — the payload is the whole chain —
    // and remember which ids the agent introduced. A `ui` caller is our own
    // write echoed back: already local, and applying it would race an edit
    // still waiting on its coalesced push. A session this store does not
    // know (never opened here, or already closed) is dropped rather than
    // growing `chains` for a tab that does not exist.
    track(
      listenChain((payload) => {
        if (disposed) return;
        if (payload.caller.kind === 'ui') return;
        if (!sessions.order().includes(payload.sessionId)) return;
        const order = payload.activeProcessorIds.filter((id) => id !== PII_ANONYMIZER_ID);
        const disabled = new Set(payload.disabledProcessorIds.filter((id) => order.includes(id)));
        const before = new Set(currentChain(payload.sessionId).order);
        const introduced = order.filter((id) => !before.has(id));
        batch(() => {
          setSessionChain(payload.sessionId, { order, disabled });
          if (introduced.length > 0) {
            // A plain object write: a session with no row yet has nothing to
            // `produce` on, and `setStore` merges object values into an
            // existing row anyway.
            setAddedByAgent(payload.sessionId, Object.fromEntries(introduced.map((id) => [id, payload.caller])));
          }
        });
      }),
    );

    // ── Run lifecycle ────────────────────────────────────────────────────
    const running = (sessionId: string): boolean => currentRun(sessionId).running;
    const progress = (sessionId: string): ReadonlyMap<string, AnalyzerProgress> => currentRun(sessionId).progress;
    const result = (sessionId: string): PipelineRunResult | null => currentRun(sessionId).result;
    const lastError = (sessionId: string): string | null => currentRun(sessionId).lastError;
    const lastRunAt = (sessionId: string): number | null => currentRun(sessionId).lastRunAt;

    /** Leave own-run mode once the latest own `run()` promise has settled AND
     *  every `pipeline-complete(ui)` it is owed has arrived — see `ownRuns`. */
    const ownRunDone = (sessionId: string): void => {
      const state = ownRuns.get(sessionId);
      if (state && state.settled && state.awaitingCompletes <= 0) ownRuns.delete(sessionId);
    };

    const run = async (sessionId: string): Promise<void> => {
      const own = toSnapshot(currentChain(sessionId));
      const myGeneration = guardFor(sessionId).bump();
      // Fresh own-run state per `run()` (a superseded run's finally checks
      // the generation, not this object, so it cannot end the newer run's
      // own mode) — and a state a lost event might have left behind cannot
      // outlive the next run.
      const state: OwnRunState = { settled: false, awaitingCompletes: 0 };
      ownRuns.set(sessionId, state);
      setRuns(sessionId, {
        ...currentRun(sessionId),
        running: true,
        progress: new Map(),
        lastError: null,
      });
      let invoked = false;
      try {
        // The FULL ordered chain, disabled members included — never `own.active`
        // (see the module doc: that dropped disabled analyzers backend-side).
        await commands.setSessionPipelineMeta(sessionId, own.order, own.disabled);
        invoked = true;
        state.awaitingCompletes += 1;
        const runResult = await commands.runPipeline(sessionId, null);
        // A newer `run()` call for this session superseded this one while the
        // IPC round trip was in flight — its state must win, not ours.
        if (!guardFor(sessionId).isCurrent(myGeneration)) return;
        setRuns(sessionId, { ...currentRun(sessionId), running: false, result: runResult, lastRunAt: Date.now() });
      } catch (e) {
        // A rejected invoke is not guaranteed a `pipeline-complete` (an IPC
        // failure never reaches the backend) — don't wait on one: a failed
        // run has no trailing chunk to emit stale progress for anyway.
        if (invoked) state.awaitingCompletes -= 1;
        if (!guardFor(sessionId).isCurrent(myGeneration)) return;
        const message = String(e);
        if (message.includes(NO_CHAIN_CONFIGURED)) {
          // Nothing to run — not a failure the user needs a red banner for,
          // same silent treatment as `usePipelineCommands.ts`.
          setRuns(sessionId, { ...currentRun(sessionId), running: false });
          return;
        }
        setRuns(sessionId, { ...currentRun(sessionId), running: false, lastError: message });
      } finally {
        if (guardFor(sessionId).isCurrent(myGeneration)) {
          state.settled = true;
          ownRunDone(sessionId);
        }
      }
    };

    const stop = async (sessionId: string): Promise<void> => {
      try {
        await commands.stopPipeline();
      } finally {
        setRuns(sessionId, { ...currentRun(sessionId), running: false });
      }
    };

    // ── Progress + foreign runs ──────────────────────────────────────────
    // `pipeline-progress` carries neither a caller nor a run-generation token,
    // and the backend serialises runs per session, so the rule is:
    //
    //  - Progress for a session this store believes is running (an own
    //    `run()` in flight, or a foreign run already noticed) updates that
    //    run's progress map. Starting any run clears the map, so entries from
    //    the previous run never linger into a fresh one.
    //  - Progress for a session in own-run mode (`ownRuns`) but not running
    //    is an own run's trailing event — after `stop()` cleared `running`,
    //    or after the promise settled but before its ui complete — and is
    //    dropped. It is NEVER the start of a foreign run: the backend
    //    serialises runs per session, so no agent run can emit while ours is
    //    in flight.
    //  - Otherwise, progress for a KNOWN session with no run in flight is the
    //    first sign of a foreign run — an agent's `run_pipeline` — and starts
    //    mirroring it: `running: true`, a fresh progress map, no stale
    //    `lastError`, and a generation bump so `runCaches` reset (the results
    //    that fetch will be this run's, not the previous one's). The bumped
    //    token is kept in `foreignRuns` for the completion below.
    //  - Progress for a session this store does not know (`sessions.order()`)
    //    is dropped: there is no tab to show it in.
    //
    // A foreign run settles through `pipeline-complete` (below), which
    // carries the caller: `ui` is our own run's — `run()` writes its result
    // from the `run_pipeline` promise, so the event never writes run state;
    // it only counts down `ownRuns`'s awaited completes (own-run mode ends
    // once the promise has settled too) — and anything else lands
    // `result`/`lastError`, clears `running`, stamps `lastRunAt` and bumps
    // the generation once more so the caches are keyed to the landed result.
    // Generation guard: a foreign completion whose token was superseded by a
    // newer own `run()` (or by a later foreign start) is dropped, exactly as
    // a stale own settlement is in `run()`; and a completion for a session
    // with no foreign token that is running or in own-run mode is dropped
    // for the same reason (its in-flight row is an own run's). A cancel
    // (`result` with empty `summaries`) and a "no chain configured" failure
    // only clear `running`, matching `run()`.
    track(
      listen((payload) => {
        if (disposed) return;
        const row = runs[payload.sessionId];
        const entry: AnalyzerProgress = {
          processorId: payload.processorId,
          linesProcessed: payload.linesProcessed,
          totalLines: payload.totalLines,
          percent: payload.percent,
        };
        if (row?.running) {
          const next = new Map(row.progress);
          next.set(payload.processorId, entry);
          setRuns(payload.sessionId, 'progress', next);
          return;
        }
        if (ownRuns.has(payload.sessionId)) return; // an own run's trailing progress
        if (!sessions.order().includes(payload.sessionId)) return;
        foreignRuns.set(payload.sessionId, guardFor(payload.sessionId).bump());
        setRuns(payload.sessionId, {
          ...currentRun(payload.sessionId),
          running: true,
          progress: new Map([[payload.processorId, entry]]),
          lastError: null,
        });
      }),
    );

    track(
      listenComplete((payload) => {
        if (disposed) return;
        const sessionId = payload.sessionId;
        if (payload.caller.kind === 'ui') {
          // Our own run's — bookkeeping only, never run state (see above).
          const state = ownRuns.get(sessionId);
          if (state) {
            state.awaitingCompletes -= 1;
            ownRunDone(sessionId);
          }
          return;
        }
        if (!sessions.order().includes(sessionId)) return;
        const token = foreignRuns.get(sessionId);
        if (token !== undefined) {
          foreignRuns.delete(sessionId);
          if (!guardFor(sessionId).isCurrent(token)) return;
        } else if (currentRun(sessionId).running || ownRuns.has(sessionId)) {
          return; // the in-flight row is an own run's — not this completion's
        }
        guardFor(sessionId).bump();
        const cur = currentRun(sessionId);
        if (payload.error !== null) {
          const silent = payload.error.includes(NO_CHAIN_CONFIGURED);
          setRuns(sessionId, { ...cur, running: false, lastError: silent ? cur.lastError : payload.error });
          return;
        }
        if (!payload.result || payload.result.summaries.length === 0) {
          setRuns(sessionId, { ...cur, running: false }); // cancelled — nothing to land
          return;
        }
        setRuns(sessionId, { ...cur, running: false, result: payload.result, lastError: null, lastRunAt: Date.now() });
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
      const cache = ensureCache(sessionId, guardFor(sessionId).current());
      let p = cache.matchedLines.get(processorId);
      if (!p) {
        p = commands.getMatchedLines(sessionId, processorId);
        cache.matchedLines.set(processorId, p);
      }
      return p;
    };

    const correlatorEvents = (sessionId: string, processorId: string): Promise<CorrelatorResult> => {
      const cache = ensureCache(sessionId, guardFor(sessionId).current());
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

    // ── Live counters (L3) ───────────────────────────────────────────────
    /** Live updates target a session that may have no run at all yet — start
     *  from the existing result's shape when there is one (so a live capture
     *  that was also run post-mortem keeps its `effectiveProcessorIds`), or a
     *  minimal synthetic one when there isn't. `effectiveProcessorIds: []` is
     *  never read by any `src-solid` consumer today (only by tests), so it
     *  carries no "this ran nothing" implication a live counter would need
     *  to correct. */
    const liveResultBase = (sessionId: string): PipelineRunResult =>
      currentRun(sessionId).result ?? { sessionId, effectiveProcessorIds: [], summaries: [] };

    const applyProcessorUpdates = (sessionId: string, updates: AdbProcessorUpdate[]): void => {
      if (updates.length === 0) return;
      const base = liveResultBase(sessionId);
      let summaries = base.summaries;
      for (const u of updates) {
        summaries = mergeProcessorResult(summaries, u.processorId, u.matchedLines, u.emissionCount);
      }
      setRuns(sessionId, { ...currentRun(sessionId), result: { ...base, summaries } });
    };

    const applyProcessorsExcluded = (sessionId: string, excluded: AdbExcludedProcessor[]): void => {
      const base = liveResultBase(sessionId);
      const summaries = applyExcludedProcessors(base.summaries, excluded);
      setRuns(sessionId, { ...currentRun(sessionId), result: { ...base, summaries } });
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
          setSessionChain(sessionId, { order: cur.order.filter((id) => id !== processorId), disabled });
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
        setSessionChain(sessionId, next);
        // The full chain, not `order − disabled` — see `run()`.
        void commands.setSessionPipelineMeta(sessionId, [...cleanOrder], [...cleanDisabled]).catch(() => undefined);
        return;
      }

      // Legacy path: an old, pre-v4 single-chain workspace. Sets the shared
      // template AND back-fills every open session that has no chain of its
      // own — a session that already diverged keeps its own chain, exactly as
      // `PipelineContext.tsx`'s `chain:restore` reducer case does. Deliberately
      // no per-session push here: `run()` pushes before every run regardless,
      // and one restore must not fan out into N chain writes.
      batch(() => {
        setDefaultTemplate(next);
        for (const id of sessions.order()) {
          if (!chains[id]) setSessionChain(id, { order: [...next.order], disabled: new Set(next.disabled) });
        }
      });
    };

    // ── Hydration ────────────────────────────────────────────────────────
    // The backend is the chain's source of truth, and not every write there
    // announces itself: a reopen of the same file re-keys the rescued chain
    // in `sessions::RescuedArtifacts` with no event, and an agent may have
    // edited the chain before this tab existed. So the first time a session
    // is known here, read its chain back — and apply it only if the user has
    // not edited locally in the meantime (a local chain already exists), so a
    // slow read can never overwrite a fresh edit. An empty backend chain
    // leaves the session on the shared template exactly as before.
    const hydrated = new Set<string>();
    createEffect(() => {
      for (const sessionId of sessions.order()) {
        if (hydrated.has(sessionId)) continue;
        hydrated.add(sessionId);
        void commands
          .getSessionChain(sessionId)
          .then((state) =>
            // Not a tracked scope — every read here is deliberately untracked.
            untrack(() => {
              if (disposed || chains[sessionId] !== undefined) return;
              if (!sessions.order().includes(sessionId)) return;
              applyBackendChain(state, sessionId);
            }),
          )
          .catch(() => undefined);
      }
    });

    // ── Session cleanup ──────────────────────────────────────────────────
    // Prunes chain/run state for sessions that have closed, so the two records
    // don't grow unbounded across a long-lived app the way `PipelineContext`'s
    // own `session:removed` action guards against.
    createEffect(() => {
      const known = new Set(sessions.order());
      const staleChains = Object.keys(unwrap(chains)).filter((id) => !known.has(id));
      const staleRuns = Object.keys(unwrap(runs)).filter((id) => !known.has(id));
      const staleAdded = Object.keys(unwrap(addedByAgent)).filter((id) => !known.has(id));
      // A session that closed before it was ever edited has no record to
      // prune but must still hydrate afresh if the same id reopens.
      for (const id of [...hydrated]) if (!known.has(id)) hydrated.delete(id);
      if (staleChains.length === 0 && staleRuns.length === 0 && staleAdded.length === 0) return;
      batch(() => {
        if (staleChains.length > 0) {
          setChains(produce((draft) => { for (const id of staleChains) delete draft[id]; }));
        }
        if (staleRuns.length > 0) {
          setRuns(produce((draft) => { for (const id of staleRuns) delete draft[id]; }));
        }
        if (staleAdded.length > 0) {
          setAddedByAgent(produce((draft) => { for (const id of staleAdded) delete draft[id]; }));
        }
      });
      // A session can be stale in one record and not the others (e.g. `run()`
      // was never called for it), so sweep the union rather than assume the
      // lists match.
      for (const id of new Set([...staleChains, ...staleRuns, ...staleAdded])) {
        runCaches.delete(id);
        runGuards.delete(id);
        foreignRuns.delete(id);
        ownRuns.delete(id);
        pushers.delete(id);
      }
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
      runGuards.clear();
      foreignRuns.clear();
      ownRuns.clear();
      pushers.clear();
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
      addedBy,
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
      applyProcessorUpdates,
      applyProcessorsExcluded,
      installFromFile,
      uninstall,
      pipelineChainProvider,
      applyWorkspaceChain,
      dispose,
    };
  });
}
