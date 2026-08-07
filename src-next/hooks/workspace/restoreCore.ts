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
import { bus } from '../../events';
import { restoreWorkspaceSession } from '../../bridge/commands';
import type { AnalysisArtifact, LoadWorkspaceSessionData, LtwEditorTab, SourceType } from '../../bridge/types';
import { basename } from '../../utils';
import { pairArtifactsWithSessions } from './artifactPairing';
import { buildEditorTabEvents } from './workspacePersistence';
import { buildRestoreOutcomes, isLts, type RestorePlan } from './restorePlan';
import { rebuildTreeSkeleton, createPaneResolver, type PaneResolver } from './restoreTreeSkeleton';

/** The `.ltw`-derived data the core consumes (subset of `LoadWorkspaceV4Result`).
 *  For the pure-localStorage fallback the caller passes empty `sessionData` /
 *  `editorTabs`, an empty `analyses`, and a null `layout`. */
export interface RestoreResult {
  workspaceName: string;
  /** The restored `.ltw` path (empty string for a pure-localStorage restore —
   *  `workspace:opened` has no consumers today, so the value is cosmetic). */
  filePath: string;
  sessionData: LoadWorkspaceSessionData[];
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
  /** Workspace-level analyses (`LoadWorkspaceV4Result.analyses`). Replaces the
   *  in-memory workspace analysis store wholesale before any session loads —
   *  see `restoreWorkspace`. Empty for a pure-localStorage restore, which
   *  correctly clears the store (there is nothing to restore it from). */
  analyses: AnalysisArtifact[];
}

export interface RestoreIo {
  /** `useFileSession.loadFile` — accepts the optional persisted tab id at runtime
   *  even though the public `LogViewerActions` type elides it. `sourceType`
   *  replays a persisted override so the session re-detects nothing and resolves
   *  to the same id it had when saved.
   *
   *  `replace` and `loadRequestId` are declared here (rather than omitted) so
   *  their parameter *positions* match the real `useFileSession.loadFile`
   *  implementation exactly — restoreWorkspace always passes `undefined` for
   *  `replace` and its own correlation id for `loadRequestId`; if the position
   *  were wrong, the id would land in the `replace` slot at runtime. */
  loadFile: (
    path: string,
    paneId?: string,
    existingTabId?: string,
    sourceType?: SourceType,
    replace?: boolean,
    loadRequestId?: string,
  ) => Promise<void>;
  /** Triggers (or arms) the pipeline auto-run for a restored session, with that
   *  session's restored chain passed explicitly (see autoRunScheduler for why the
   *  chain is not read from the global ref). */
  scheduleAutoRun: (
    sessionId: string,
    isIndexing: boolean | undefined,
    chain: string[],
    disabled: string[],
  ) => void;
  /** Wholesale-replace the workspace analysis store. Called once, before any
   *  session load, so the per-session artifact restores below (which upsert
   *  by artifact id) land on top of the right base set rather than racing it. */
  setWorkspaceAnalyses: (analyses: AnalysisArtifact[]) => Promise<void>;
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
  const warnings: string[] = [...plan.warnings];
  try {
    // Replace the workspace analysis store wholesale before any session load
    // starts, so the legacy per-pair merges below (restoreWorkspaceSession —
    // backend upserts by artifact id) land on top of the correct base set
    // instead of racing a load that might resolve first. A failure here must
    // not abort the restore — the workspace still has sessions to bring back.
    await io.setWorkspaceAnalyses(result.analyses);
  } catch (e) {
    const msg = `Failed to restore workspace analyses: ${e}`;
    console.warn(`[restoreWorkspace] ${msg}`);
    warnings.push(msg);
  }

  // Rebuild the saved center-tree's split skeleton BEFORE any session load,
  // with fresh pane ids (the saved ones are stale by restore time) — see
  // `restoreTreeSkeleton.ts`. Gated on `plan.applyLtwViewState`, exactly
  // like the editor-tab/layout-blob replay below: when localStorage is
  // already the fresher source (a plain app restart, not a workspace
  // switch/open), its own centerTree already has the right shape AND pane
  // ids that line up with the plan's stored-tab paneIds — replaying the
  // (possibly older) `.ltw` tree here would stomp it. `rebuildTreeSkeleton`
  // itself returns null for a legacy `.ltw` with no saved tree, so that
  // case falls through unchanged to the pre-fix flat behavior.
  //
  // try/catch is load-bearing, not defensive style: this block sits BETWEEN
  // the setWorkspaceAnalyses try/catch above and the loads' own try/finally
  // below — inside neither. `workspace:restore-begin` already fired
  // (suppressing both `useWorkspaceAutoSave`'s gate and
  // `useWorkspaceLayout`'s `persistGateRef`), so an uncaught throw here would
  // propagate straight out of `restoreWorkspace` without ever reaching the
  // loads' `finally` that emits `workspace:restore-end` — leaving both gates
  // stuck suppressed for the rest of the session. Catch locally, warn, and
  // fall back to no resolver (flat/legacy behavior) instead.
  let paneResolver: PaneResolver | null = null;
  if (plan.applyLtwViewState) {
    try {
      const layoutBlob = result.layout as { centerTree?: unknown } | null;
      const skeleton = layoutBlob ? rebuildTreeSkeleton(layoutBlob.centerTree) : null;
      if (skeleton) {
        paneResolver = createPaneResolver(skeleton);
        bus.emit('workspace:restore-tree-skeleton', { tree: skeleton.tree });
      }
    } catch (e) {
      const msg = `Failed to rebuild the saved pane layout: ${e}`;
      console.warn(`[restoreWorkspace] ${msg}`);
      warnings.push(msg);
      paneResolver = null;
    }
  }

  // Correlation id stamped on every loadFile call this restore makes. A user
  // can open a file (via the normal open path) while a restore load is
  // in-flight — the awaited io.loadFile below yields the event loop, and an
  // unrelated session:loaded for that unrelated open would otherwise land in
  // this restore's loadedOrder slice and get attributed the wrong manifest
  // entry's bookmarks/analyses. Filtering on this id in onSessionLoaded scopes
  // attribution to sessions THIS restore produced.
  const loadRequestId = crypto.randomUUID();
  try {
    // session:loaded fires synchronously inside loadFile (before its promise
    // resolves), so slicing this list around each await yields exactly the
    // sessions that load produced, in order — with their isIndexing flag.
    const loadedOrder: Array<{ sessionId: string; isIndexing?: boolean }> = [];
    const onSessionLoaded = (p: { sessionId: string; isIndexing?: boolean; loadRequestId?: string }) => {
      if (p.loadRequestId !== loadRequestId) return; // not from this restore
      loadedOrder.push({ sessionId: p.sessionId, isIndexing: p.isIndexing });
    };
    bus.on('session:loaded', onSessionLoaded);

    // U6: a session's indexing can complete in the gap between its
    // session:loaded (which carries the isIndexing snapshot below) and the
    // scheduleAutoRun call further down, which only runs after an awaited
    // restoreWorkspaceSession per pair. Subscribing before any load starts
    // means we catch that completion instead of missing it — scheduleAutoRun
    // is told below to treat any such session as already-indexed instead of
    // arming a one-shot for an indexing-complete that already fired (which
    // would otherwise wait forever, since the event never fires twice).
    const indexingCompletedIds = new Set<string>();
    const onIndexingComplete = (p: { sessionId: string }) => {
      indexingCompletedIds.add(p.sessionId);
    };
    bus.on('session:indexing-complete', onIndexingComplete);

    const producedSessionIdsPerLoad: string[][] = [];
    try {
      for (const load of plan.loads) {
        const before = loadedOrder.length;
        // Prefer the pane this session occupied when the workspace was
        // saved (matched by the content-stable `sourcePath`, since every
        // pane id in the rebuilt skeleton is fresh), then a straight remap
        // of the plan's own (possibly stale) paneId, then fall back to the
        // plan's paneId as-is (no skeleton, or no match — e.g. a file
        // opened after the last save) so `loadFile` applies its normal
        // active/first-pane default.
        const effectivePaneId = paneResolver
          ? paneResolver.resolve({ sourcePath: load.path, oldPaneId: load.paneId }) ?? load.paneId
          : load.paneId;
        try {
          await io.loadFile(load.path, effectivePaneId, load.existingTabId, load.sourceType as SourceType | undefined, undefined, loadRequestId);
        } catch (e) {
          console.warn(`[restoreWorkspace] Failed to load ${load.path}:`, e);
        }
        producedSessionIdsPerLoad.push(loadedOrder.slice(before).map((x) => x.sessionId));
      }
    } finally {
      bus.off('session:loaded', onSessionLoaded);
    }

    const isIndexingBySession = new Map(loadedOrder.map((x) => [x.sessionId, x.isIndexing]));

    // T8: expected-session-id diagnostic. A manifest entry that recorded the
    // session id it resolved to at save time (`expectedSessionId`) lets restore
    // detect drift: ids are deterministic and content-derived, so if the file at
    // that path changed since the save, this load re-derives a *different* id
    // and every analysis reference keyed to the old one is now unresolved.
    // Silent when the produced id matches, the load failed (nothing was
    // produced — already covered by the pairing warning above), or the entry
    // predates this field (legacy manifest, no `expectedSessionId`).
    const drifted = plan.loads.filter((load, i) => {
      if (!load.expectedSessionId) return false;
      const produced = producedSessionIdsPerLoad[i]?.[0];
      return !!produced && produced !== load.expectedSessionId;
    });

    // Counted in ONE pass over every reference, rather than re-walking the whole
    // analysis set once per drifted load (that was O(loads x artifacts x refs)
    // on the restore critical path, all to produce a warning string). Built
    // lazily: the common no-drift restore touches the analysis set not at all.
    const refCountBySession = new Map<string, number>();
    if (drifted.length > 0) {
      for (const artifact of result.analyses) {
        for (const section of artifact.sections ?? []) {
          for (const ref of section.references ?? []) {
            if (!ref.sessionId) continue;
            refCountBySession.set(ref.sessionId, (refCountBySession.get(ref.sessionId) ?? 0) + 1);
          }
        }
      }
    }

    drifted.forEach((load) => {
      const refCount = refCountBySession.get(load.expectedSessionId!) ?? 0;
      const label = basename(load.path);
      warnings.push(
        refCount > 0
          ? `${label} changed since the workspace was saved; ${refCount} analysis reference(s) for it are now unresolved.`
          : `${label} changed since the workspace was saved.`,
      );
    });

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
    // Append to the outer `warnings` (seeded with plan.warnings + any
    // setWorkspaceAnalyses failure above) rather than rebuilding it, so none
    // of those earlier warnings are lost.
    warnings.push(...pairingWarnings);
    for (const w of pairingWarnings) console.warn(`[restoreWorkspace] ${w}`);

    try {
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
          // If indexing-complete already arrived for this session (raced ahead
          // of us getting here), treat it as not-indexing so scheduleAutoRun
          // runs now instead of arming a one-shot for an event that already
          // fired and will never fire again.
          const isIndexing = indexingCompletedIds.has(sessionId) ? false : isIndexingBySession.get(sessionId);
          io.scheduleAutoRun(
            sessionId,
            isIndexing,
            data.activeProcessorIds,
            data.disabledProcessorIds,
          );
        }
      }));
    } finally {
      // All scheduleAutoRun decisions above have been made (or skipped on
      // error) — stop tracking regardless of outcome.
      bus.off('session:indexing-complete', onIndexingComplete);
    }

    // View-state: editor tabs + layout blob (pane widths, visible panes,
    // etc). Only when localStorage did not already restore them (else they
    // self-restore from their own keys and this would duplicate). The
    // center tree itself was already rebuilt above (before the loads loop)
    // under the same `applyLtwViewState` gate — `workspace:restore-layout`'s
    // handler (`useWorkspaceLayout.onRestoreLayout`) deliberately continues
    // to skip the tree: replaying the raw saved tree here (stale pane ids)
    // would stomp the correctly-remapped live one.
    if (plan.applyLtwViewState) {
      for (const event of buildEditorTabEvents(result.editorTabs)) {
        // Steer this tab at the pane it occupied when saved — matched by the
        // same content-stable `sourcePath`/`filePath` key the logviewer loads
        // above used, via the same resolver (an editor placement, if any,
        // isn't claimed by that earlier loop — it only ever matches `type:
        // 'logviewer'` placements). `undefined` (no resolver, or no match —
        // e.g. an untitled tab, or a legacy `.ltw` with no saved tree) falls
        // back to `openCenterTab`'s normal focused-pane/first-leaf default,
        // same as before this fix.
        const paneId = paneResolver?.resolve({ sourcePath: event.filePath, type: 'editor' }) ?? undefined;
        bus.emit('layout:open-tab', { ...event, paneId });
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
