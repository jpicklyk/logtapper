import type { SessionChainState } from '../context/PipelineContext';

/**
 * The chain state `usePipelineWiring`'s persist effect diffs against, on
 * consecutive renders, to decide which sessions to notify via a targeted
 * `pipeline:chain-changed` event (root CLAUDE.md principle #6 — bus events
 * must be targeted, not broadcast).
 */
export interface ChainSnapshot {
  chainBySession: Map<string, SessionChainState>;
  defaultChain: SessionChainState;
}

/**
 * Pure diff: given the previous and current chain snapshot (or `null` for
 * "no previous snapshot yet", e.g. on the first initialized render) and the
 * sessionIds currently occupying a pane, returns the set of sessionIds whose
 * EFFECTIVE chain changed.
 *
 * A session's own entry changing (added, edited, or removed from
 * `chainBySession`) always counts. A change to the shared `defaultChain`
 * counts only for sessions that have no chain of their own (they inherit the
 * default) AND are actually occupying a pane right now — a session with no
 * pane isn't rendering anything that needs to hear about it.
 *
 * Extracted from `usePipelineWiring`'s persist effect (verbatim logic) so it
 * is testable without mounting React/Tauri — see `pipelineChainDiff.test.ts`.
 */
export function computeChangedChainSessionIds(
  prev: ChainSnapshot | null,
  next: ChainSnapshot,
  paneSessionIds: Iterable<string | null | undefined>,
): Set<string> {
  const targets = new Set<string>();

  for (const [sid, c] of next.chainBySession) {
    if (prev?.chainBySession.get(sid) !== c) targets.add(sid);
  }

  if (prev?.defaultChain !== next.defaultChain) {
    for (const sid of paneSessionIds) {
      if (sid && !next.chainBySession.has(sid)) targets.add(sid);
    }
  }

  return targets;
}
