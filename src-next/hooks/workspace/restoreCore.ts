/**
 * The single restore engine (design: `plans/workspace-restore-design.md` §Q2,
 * design 2A). Extracted verbatim-in-spirit from the body of `doLoadWorkspace`
 * so that both the explicit-open path and the startup orchestrator drive the
 * exact same sequence: begin/end auto-save bracket, sequential loads recording
 * per-entry produced session ids, keyed artifact pairing, per-session artifact
 * restore, targeted auto-run, optional `.ltw` view-state replay, `workspace:opened`.
 *
 * The only IO the caller must inject is `loadFile` and the auto-run scheduler
 * (both depend on live React state); everything else (`restore_workspace_session`,
 * the bus, the pure planner/pairing helpers) is imported directly.
 */
import { bus } from '../../events/bus';
import { restoreWorkspaceSession } from '../../bridge/commands';
import type { LoadWorkspaceSessionData, LtwEditorTab } from '../../bridge/types';
import { pairArtifactsWithSessions } from './artifactPairing';
import { buildEditorTabEvents } from './workspacePersistence';
import { buildRestoreOutcomes, isLts, type RestorePlan } from './restorePlan';

/** The `.ltw`-derived data the core consumes (subset of `LoadWorkspaceV4Result`).
 *  For the pure-localStorage fallback the caller passes empty `sessionData` /
 *  `editorTabs` and a null `layout`. */
export interface RestoreResult {
  workspaceName: string;
  /** The restored `.ltw` path (empty string for a pure-localStorage restore —
   *  `workspace:opened` has no consumers today, so the value is cosmetic). */
  filePath: string;
  sessionData: LoadWorkspaceSessionData[];
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
}

export interface RestoreIo {
  /** `useFileSession.loadFile` — accepts the optional persisted tab id at runtime
   *  even though the public `LogViewerActions` type elides it. */
  loadFile: (path: string, paneId?: string, existingTabId?: string) => Promise<void>;
  /** Triggers (or arms) the pipeline auto-run for a restored session, with that
   *  session's restored chain passed explicitly (see autoRunScheduler for why the
   *  chain is not read from the global ref). */
  scheduleAutoRun: (
    sessionId: string,
    isIndexing: boolean | undefined,
    chain: string[],
    disabled: string[],
  ) => void;
}

/**
 * Run a restore plan. Returns the collected warnings (planner divergences +
 * pairing skips) so the caller can surface them in the restore notice.
 */
export async function restoreWorkspace(
  result: RestoreResult,
  plan: RestorePlan,
  io: RestoreIo,
): Promise<string[]> {
  // loadFile is a tracked mutation; without this bracket the restore would
  // schedule an auto-save of itself and, on a partial failure, overwrite the good
  // `.ltw` with the partial set. Reference-counted gate; end MUST run in finally.
  bus.emit('workspace:restore-begin');
  try {
    // session:loaded fires synchronously inside loadFile (before its promise
    // resolves), so slicing this list around each await yields exactly the
    // sessions that load produced, in order — with their isIndexing flag.
    const loadedOrder: Array<{ sessionId: string; isIndexing?: boolean }> = [];
    const onSessionLoaded = (p: { sessionId: string; isIndexing?: boolean }) => {
      loadedOrder.push({ sessionId: p.sessionId, isIndexing: p.isIndexing });
    };
    bus.on('session:loaded', onSessionLoaded);

    const producedSessionIdsPerLoad: string[][] = [];
    try {
      for (const load of plan.loads) {
        const before = loadedOrder.length;
        try {
          await io.loadFile(load.path, load.paneId, load.existingTabId);
        } catch (e) {
          console.warn(`[restoreWorkspace] Failed to load ${load.path}:`, e);
        }
        producedSessionIdsPerLoad.push(loadedOrder.slice(before).map((x) => x.sessionId));
      }
    } finally {
      bus.off('session:loaded', onSessionLoaded);
    }

    const isIndexingBySession = new Map(loadedOrder.map((x) => [x.sessionId, x.isIndexing]));

    // Sessions produced by a `.lts` load are auto-run by useWorkspaceRestore on
    // the backend's `source: "lts"` emission (which carries the `.lts`'s own
    // per-session chain and covers embedded sessions beyond the first, which
    // pairing drops). The core owns only non-`.lts` (`source: "workspace"`)
    // sessions — so it must NOT also schedule `.lts`-backed ones, or the pipeline
    // would run twice. The scheduler's swallow is the belt to this braces.
    const ltsSessionIds = new Set<string>();
    plan.loads.forEach((load, i) => {
      if (isLts(load.path)) {
        for (const sid of producedSessionIdsPerLoad[i] ?? []) ltsSessionIds.add(sid);
      }
    });

    const outcomes = buildRestoreOutcomes(plan.loads, producedSessionIdsPerLoad, result.sessionData);
    const { pairs, warnings: pairingWarnings } = pairArtifactsWithSessions(outcomes);
    const warnings = [...plan.warnings, ...pairingWarnings];
    for (const w of warnings) console.warn(`[restoreWorkspace] ${w}`);

    // Restore artifacts per session, then trigger that session's own auto-run.
    // Restores are independent — each targets its own session_id-keyed slices of
    // AppState (bookmarks/analyses/pipeline meta) and emits its own scoped
    // workspace-restored event, so run them in parallel. What must stay ordered
    // is local to each pair: "this session's restore resolves before this
    // session's own auto-run is scheduled" — Promise.all over per-pair async
    // callbacks preserves that while letting sessions restore concurrently.
    await Promise.all(pairs.map(async ({ sessionId, data }) => {
      try {
        await restoreWorkspaceSession({
          sessionId,
          bookmarks: data.bookmarks,
          analyses: data.analyses,
          activeProcessorIds: data.activeProcessorIds,
          disabledProcessorIds: data.disabledProcessorIds,
        });
      } catch (e) {
        console.warn(`[restoreWorkspace] Failed to restore artifacts for ${sessionId}:`, e);
        return;
      }
      // Only sessions with a restored chain, and not owned by the `.lts` path.
      if (data.activeProcessorIds.length > 0 && !ltsSessionIds.has(sessionId)) {
        io.scheduleAutoRun(
          sessionId,
          isIndexingBySession.get(sessionId),
          data.activeProcessorIds,
          data.disabledProcessorIds,
        );
      }
    }));

    // View-state: editor tabs + layout blob. Only when localStorage did not
    // already restore them (else they self-restore from their own keys and this
    // would duplicate). Center tree is intentionally rebuilt by session loads.
    if (plan.applyLtwViewState) {
      for (const event of buildEditorTabEvents(result.editorTabs)) {
        bus.emit('layout:open-tab', event);
      }
      if (result.layout) {
        bus.emit('workspace:restore-layout', { layout: result.layout });
      }
    }

    bus.emit('workspace:opened', { name: result.workspaceName, filePath: result.filePath });
    return warnings;
  } finally {
    // Must run even on failure — a missed end suppresses auto-save for the rest
    // of the session.
    bus.emit('workspace:restore-end');
  }
}
