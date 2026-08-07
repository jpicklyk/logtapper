/**
 * Pure helper for `closeAllSessions` (context/index.tsx).
 *
 * `paneSessionMap` holds exactly one ACTIVE session per pane, but a pane's
 * inactive tabs (other open sessions not currently shown) have backend
 * sessions too — those aren't reachable through `paneSessionMap` at all, only
 * through the full `sessions` map (`SessionCoreCtx.sessions`, registered by
 * every `registerSession` call regardless of active/inactive). A workspace
 * teardown that closes only the panes' active sessions leaks every inactive
 * tab's backend session — invisibly, since nothing in the frontend ever
 * looks for them again once the tree is reset.
 *
 * Extracted as a pure function (no React, no bridge calls) so the
 * enumeration logic — the part that actually decides what needs closing —
 * is unit-testable without rendering `HookWiring`.
 */
export interface SessionsToClose {
  /** Pane ids to close via their active session (closeSession(paneId)). */
  paneIds: string[];
  /** Session ids with no active-tab pane reference — inactive tabs' sessions,
   *  closed directly by id (closeSession(undefined, undefined, sessionId)). */
  inactiveSessionIds: string[];
}

export function collectSessionsToClose(
  paneSessionMap: Map<string, string>,
  sessions: Map<string, unknown>,
): SessionsToClose {
  const paneIds = [...paneSessionMap.keys()];
  const activeSessionIds = new Set(paneSessionMap.values());
  const inactiveSessionIds = [...sessions.keys()].filter((id) => !activeSessionIds.has(id));
  return { paneIds, inactiveSessionIds };
}
