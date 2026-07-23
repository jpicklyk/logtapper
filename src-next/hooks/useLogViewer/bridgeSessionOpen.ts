/**
 * Pure decision logic for handling a bridge-initiated `session-opened` event.
 *
 * Extracted from the `useFileSession` listener so the idempotency + target-pane
 * choice can be unit-tested without React or Tauri. The listener wires in the
 * side effects (tab creation via bus events, session registration).
 *
 * The backend session already exists by the time `session-opened` fires (the MCP
 * bridge opened it), so the frontend must run ONLY the post-load half — it must
 * never re-invoke `load_log_file`, and it must never create a second tab for a
 * session that is already open (an auto-permit reopen re-fires the event with the
 * same deterministic sessionId).
 */

export interface BridgeOpenInputs {
  /** sessionId from the event payload; a session that can't be identified is skipped. */
  sessionId: string | null | undefined;
  /** Currently focused logviewer pane, if any. */
  activeLogPaneId: string | null;
  /** Persisted first pane id (fallback when nothing is focused). */
  storedFirstPaneId: string | null;
  /** Last-resort pane id. */
  defaultPaneId: string;
  /** paneId → sessionId, to decide whether the target pane already holds a session. */
  paneSessionMap: ReadonlyMap<string, string>;
  /**
   * True if a session with this id is already registered (⇒ a tab already exists
   * for it — session-map and tab-map membership move in lockstep). Used as the
   * duplicate-tab guard.
   */
  isSessionOpen: (sessionId: string) => boolean;
}

export type BridgeOpenPlan =
  | { kind: 'skip'; reason: 'missing-session' | 'already-open' }
  | { kind: 'open'; targetPaneId: string; isNewTab: boolean; previousSessionId?: string };

/**
 * Decide how to surface a bridge-opened session in the UI.
 *
 * - No usable sessionId → skip (defensive; malformed payload).
 * - Session already open → skip (idempotent: reopen must not spawn a duplicate tab).
 * - Otherwise open into the focused pane (fallbacks: stored-first → default). When
 *   that pane already holds a session it becomes a new tab alongside it
 *   (`isNewTab`), mirroring the normal `loadFile` semantics.
 */
export function planBridgeSessionOpen(input: BridgeOpenInputs): BridgeOpenPlan {
  const { sessionId } = input;
  if (!sessionId) return { kind: 'skip', reason: 'missing-session' };
  if (input.isSessionOpen(sessionId)) return { kind: 'skip', reason: 'already-open' };

  const targetPaneId = input.activeLogPaneId ?? input.storedFirstPaneId ?? input.defaultPaneId;
  const previousSessionId = input.paneSessionMap.get(targetPaneId);
  return {
    kind: 'open',
    targetPaneId,
    isNewTab: previousSessionId !== undefined,
    previousSessionId,
  };
}
