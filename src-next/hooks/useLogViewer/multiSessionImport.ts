/**
 * Pure function for computing multi-session .lts import actions.
 *
 * Extracted from useFileSession so the logic can be tested directly
 * without React, Tauri, or bus dependencies.
 */
import { isBugreportLike } from '../../bridge/types';

/** Minimal session info needed from a LoadResult. */
export interface ImportedSession {
  sessionId: string;
  sourceName: string;
  sourceType: string;
}

/** An action the hook should execute after computing the import plan. */
export type ImportAction =
  | { type: 'loading'; paneId: string; tabId: string; label: string }
  | { type: 'register'; paneId: string; session: ImportedSession }
  | { type: 'activate'; paneId: string; sessionId: string }
  | { type: 'loaded'; paneId: string; tabId: string; session: ImportedSession; previousSessionId: string; readOnly: boolean }
  | { type: 'persistTabPath'; tabId: string };

/**
 * Given the extra sessions from a multi-session .lts import (everything after
 * the primary session), compute the ordered list of actions the hook must
 * execute. Each extra session gets its own tab within the same pane.
 *
 * The caller is responsible for generating tab IDs (injected via `makeTabId`)
 * so that tests can supply deterministic values.
 *
 * After all extra-session actions, a final `activate` action re-selects the
 * primary session so it remains visible.
 */
export function planExtraSessionImport(
  paneId: string,
  primarySessionId: string,
  extraSessions: ImportedSession[],
  makeTabId: () => string,
): ImportAction[] {
  if (extraSessions.length === 0) return [];

  const actions: ImportAction[] = [];

  for (const session of extraSessions) {
    const tabId = makeTabId();
    const label = session.sourceName || 'Untitled';

    actions.push({ type: 'loading', paneId, tabId, label });
    actions.push({ type: 'register', paneId, session });
    actions.push({ type: 'activate', paneId, sessionId: session.sessionId });
    actions.push({
      type: 'loaded',
      paneId,
      tabId,
      session,
      previousSessionId: primarySessionId,
      readOnly: isBugreportLike(session.sourceType),
    });
    actions.push({ type: 'persistTabPath', tabId });
  }

  // Re-activate primary session so it stays visible after all extras are registered.
  actions.push({ type: 'activate', paneId, sessionId: primarySessionId });

  return actions;
}
