/**
 * Which `FilterScan` a live capture's batches are matched against — keyed by
 * session (H4).
 *
 * A `FilterScan` is private to whichever `QueryBar` constructed it, and one
 * `QueryBar` is mounted per pane, so "the live one" has to be registered from
 * the outside. `App.tsx` used to hold that as a single last-write-wins signal
 * (`{ sessionId, scan }`): every mounted bar overwrote it, so opening a split
 * on a second session re-pointed the binding at a session that was not
 * streaming, `createStreamSession`'s `filterSessionId() === payload.sessionId`
 * guard stopped matching, and the running capture's filtered view silently
 * stopped growing — with no way back short of retyping the expression.
 *
 * Here every pane registers under its own session id and unbinds only its own
 * entry, and the stream hooks resolve through `liveSessionId()` — the session
 * whose batches are actually arriving — so a bar bound for any other session
 * is simply not consulted.
 */
import type { FilterNode } from '@filter/index';
import type { LiveStreamFilterHooks } from '../stream';

/**
 * What a binding target must provide. `FilterScan` satisfies it structurally —
 * stated as an interface rather than the class so a test (and any future
 * non-`FilterScan` match target) can stand in without constructing one.
 */
export interface LiveFilterTarget {
  currentFilter(): { ast: FilterNode | null; packagePids: Map<string, number[]> };
  appendMatches(lineNums: number[]): void;
}

export interface LiveFilterBindings {
  /**
   * Register `target` as the live-match scan for `sessionId`. The returned
   * unbind removes **only this** binding, and only while it is still the one
   * registered — a pane whose entry has already been replaced (a remount
   * racing its own cleanup) can never clobber the newer one.
   */
  bind(sessionId: string, target: LiveFilterTarget): () => void;
  /** Bound sessions, for assertions and diagnostics. */
  boundSessions(): string[];
  /** The hooks a `LiveStreamStore` consumes, resolved per live session. */
  readonly hooks: LiveStreamFilterHooks;
}

/** Shared empty map for "nothing bound" — read-only to every consumer. */
const NO_PACKAGE_PIDS: Map<string, number[]> = new Map();

/**
 * @param liveSessionId The session currently capturing, or `null` when nothing
 * is. Read fresh on every batch, never cached: it is what makes the resolution
 * below "the batch's own session" rather than "whichever pane bound last".
 */
export function createLiveFilterBindings(
  liveSessionId: () => string | null,
): LiveFilterBindings {
  const targets = new Map<string, LiveFilterTarget>();

  /** The scan bound for the capturing session, if any pane has one mounted. */
  const liveTarget = (): LiveFilterTarget | null => {
    const sessionId = liveSessionId();
    return sessionId ? targets.get(sessionId) ?? null : null;
  };

  return {
    bind(sessionId, target) {
      targets.set(sessionId, target);
      return () => {
        if (targets.get(sessionId) === target) targets.delete(sessionId);
      };
    },
    boundSessions: () => [...targets.keys()],
    hooks: {
      filterAst: () => liveTarget()?.currentFilter().ast ?? null,
      // `null` whenever the capturing session has no bar mounted: its
      // `FilterScan` was disposed with the pane, so there is nothing to append
      // to and `createStreamSession` must skip matching entirely rather than
      // fall through to some other session's filter.
      filterSessionId: () => {
        const sessionId = liveSessionId();
        return sessionId !== null && targets.has(sessionId) ? sessionId : null;
      },
      packagePids: () => liveTarget()?.currentFilter().packagePids ?? NO_PACKAGE_PIDS,
      // Addressed by the batch's own session id, so a match can only ever
      // reach the scan that owns that session.
      appendFilterMatches: (sessionId, lineNums) => {
        targets.get(sessionId)?.appendMatches(lineNums);
      },
    },
  };
}
