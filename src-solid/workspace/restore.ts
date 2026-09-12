/**
 * Turning a {@link RestorePlan} into store/actions calls.
 *
 * The pure half of restore already exists and is shared verbatim with React:
 * `@hooks/workspace/restorePlan` decides *which* files to load, in what order,
 * and which manifest artifact payload each load's session should receive;
 * `@hooks/workspace/artifactPairing` pairs each load's produced sessions back
 * to that payload once the loads have resolved. Neither touches React.
 *
 * What React's `restoreCore.ts` adds on top of them is pane-tree
 * reconstruction, bounded-concurrency scheduling keyed by pane, an event-bus
 * handshake and auto-run scheduling — all of it bound to the React pane model
 * that Solid does not have. So this module is the Solid-shaped replacement for
 * that layer only: run the plan's loads through `actions.openPath`, push each
 * paired session's artifacts back with `restore_workspace_session`, and report
 * warnings. It is deliberately sequential — the plan is already ordered
 * (active tabs first, then manifest order) and Solid's tab strip is a flat
 * list, so "restore in plan order" *is* the layout, and concurrency would only
 * scramble it.
 *
 * ## Tab-mirror semantics
 *
 * Solid keeps a localStorage mirror of the open tab paths (see
 * `workspaceStore.ts`, `SOLID_MIRROR_KEY`). It is a **crash-recovery cache,
 * never a source of truth**:
 *
 * - On an **explicit open** of a `.ltw`, the manifest is authoritative: the
 *   mirror is ignored entirely and then overwritten with what the manifest
 *   restored. This is `planExplicitOpen`, which is given no stored tabs at all.
 * - On **startup**, the mirror participates through `planStartupRestore` as
 *   the `storedTabs`/`tabPaths` half of the union: a file opened after the last
 *   `.ltw` flush exists only in the mirror, and dropping it would silently lose
 *   the user's tab. Those extra loads carry `dataIndex: null` — no manifest
 *   artifacts — which is exactly what the planner already encodes.
 * - The mirror is rewritten after every successful restore and on every tab
 *   change, so a hard crash (no clean save, no flush) still reopens what was
 *   on screen.
 */
import { restoreWorkspaceSession } from '@bridge/commands';
import type { LoadWorkspaceSessionData } from '@bridge/types';
import { buildRestoreOutcomes, type RestorePlan } from '@hooks/workspace/restorePlan';
import { pairArtifactsWithSessions } from '@hooks/workspace/artifactPairing';

/** The one piece of IO the plan runner needs injected (tests stub it). */
export interface RestoreIo {
  /** Open one path; resolves to the session ids that load produced. */
  openPath(path: string): Promise<string[]>;
}

export interface RestoreOutcome {
  /** Session ids in plan order, flattened — the tab strip's restore order. */
  sessionIds: string[];
  /** Plan warnings plus pairing/load failures, ready to surface to the user. */
  warnings: string[];
}

/**
 * Execute `plan`, pairing each load's produced sessions with `sessionData`.
 *
 * A load that throws is recorded as producing nothing: its artifacts are
 * dropped by the pairing step (which warns about it) rather than shifting
 * every later entry's artifacts onto the wrong session.
 */
export async function runRestorePlan(
  plan: RestorePlan,
  sessionData: readonly LoadWorkspaceSessionData[],
  io: RestoreIo,
): Promise<RestoreOutcome> {
  const warnings = [...plan.warnings];
  const producedPerLoad: string[][] = [];
  const sessionIds: string[] = [];

  for (const load of plan.loads) {
    let produced: string[] = [];
    try {
      produced = await io.openPath(load.path);
    } catch (e) {
      warnings.push(`Failed to reopen "${load.path}": ${String(e)}`);
    }
    producedPerLoad.push(produced);
    sessionIds.push(...produced);
  }

  const outcomes = buildRestoreOutcomes(plan.loads, producedPerLoad, [...sessionData]);
  const { pairs, warnings: pairingWarnings } = pairArtifactsWithSessions(outcomes);
  warnings.push(...pairingWarnings);

  // Artifact restores are independent — each writes its own session-keyed
  // slices of AppState — so they run together. Failures are per-session.
  await Promise.all(
    pairs.map(async ({ sessionId, data }) => {
      try {
        await restoreWorkspaceSession({
          sessionId,
          bookmarks: data.bookmarks,
          analyses: data.analyses,
          activeProcessorIds: data.activeProcessorIds,
          disabledProcessorIds: data.disabledProcessorIds,
        });
      } catch (e) {
        warnings.push(`Failed to restore artifacts for ${sessionId}: ${String(e)}`);
      }
    }),
  );

  return { sessionIds, warnings };
}
