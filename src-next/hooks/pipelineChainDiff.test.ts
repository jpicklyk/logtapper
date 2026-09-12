/**
 * Coverage for the pure diff-and-emit step behind `usePipelineWiring`'s
 * chain-persist effect: which sessions get a targeted `pipeline:chain-changed`
 * event when `chainBySession`/`defaultChain` change between renders.
 *
 * Extracted so this can run in vitest's node environment (no jsdom, no
 * React render) — see `src-next/context/CLAUDE.md` on why the React suite
 * runs in node by design.
 */
import { describe, it, expect } from 'vitest';
import { computeChangedChainSessionIds, type ChainSnapshot } from './pipelineChainDiff';
import type { SessionChainState } from '../context/PipelineContext';

function chain(ids: string[], disabled: string[] = []): SessionChainState {
  const disabledSet = new Set(disabled);
  return { chain: ids, disabled, active: ids.filter((id) => !disabledSet.has(id)) };
}

const DEFAULT_CHAIN = chain(['default']);

describe('computeChangedChainSessionIds', () => {
  it('emits exactly one target for the session whose own chain changed, and nothing for an unchanged session', () => {
    const chainA1 = chain(['p1']);
    const chainB = chain(['p2']);
    const prev: ChainSnapshot = {
      chainBySession: new Map([['A', chainA1], ['B', chainB]]),
      defaultChain: DEFAULT_CHAIN,
    };
    const chainA2 = chain(['p1', 'p3']); // A's chain actually edited
    const next: ChainSnapshot = {
      // B's entry is the SAME reference — untouched.
      chainBySession: new Map([['A', chainA2], ['B', chainB]]),
      defaultChain: DEFAULT_CHAIN,
    };

    const targets = computeChangedChainSessionIds(prev, next, ['A', 'B']);

    expect(targets).toEqual(new Set(['A']));
    expect(targets.has('B')).toBe(false);
  });

  it('produces no targets when nothing changed', () => {
    const chainA = chain(['p1']);
    const snapshot: ChainSnapshot = { chainBySession: new Map([['A', chainA]]), defaultChain: DEFAULT_CHAIN };

    const targets = computeChangedChainSessionIds(snapshot, snapshot, ['A']);

    expect(targets.size).toBe(0);
  });

  it('a default-chain change reaches only chainless sessions occupying a pane', () => {
    const chainA = chain(['mine']);
    const prev: ChainSnapshot = { chainBySession: new Map([['A', chainA]]), defaultChain: chain(['old']) };
    const next: ChainSnapshot = { chainBySession: new Map([['A', chainA]]), defaultChain: chain(['new']) };

    // B has no entry in chainBySession — it inherits the default and is present in a pane.
    const targets = computeChangedChainSessionIds(prev, next, ['A', 'B']);

    expect(targets).toEqual(new Set(['B']));
  });

  it('ignores a default-chain change for a session with no pane (not currently displayed)', () => {
    const prev: ChainSnapshot = { chainBySession: new Map(), defaultChain: chain(['old']) };
    const next: ChainSnapshot = { chainBySession: new Map(), defaultChain: chain(['new']) };

    // No paneSessionIds supplied at all — nothing is occupying a pane right now.
    const targets = computeChangedChainSessionIds(prev, next, []);

    expect(targets.size).toBe(0);
  });

  it('skips null/undefined pane entries (an empty pane) when diffing the default', () => {
    const prev: ChainSnapshot = { chainBySession: new Map(), defaultChain: chain(['old']) };
    const next: ChainSnapshot = { chainBySession: new Map(), defaultChain: chain(['new']) };

    const targets = computeChangedChainSessionIds(prev, next, [null, undefined, 'C']);

    expect(targets).toEqual(new Set(['C']));
  });

  it('treats every current per-session entry as changed when there is no previous snapshot (first render)', () => {
    const chainA = chain(['p1']);
    const next: ChainSnapshot = { chainBySession: new Map([['A', chainA]]), defaultChain: DEFAULT_CHAIN };

    const targets = computeChangedChainSessionIds(null, next, ['A', 'C']);

    // A has its own entry (always "new" with no prior snapshot); C has none of
    // its own but is occupying a pane, so it also picks up the (also "new")
    // default.
    expect(targets).toEqual(new Set(['A', 'C']));
  });

  it('a chain removal (session id present in prev but absent from next) does not crash and is not itself a target', () => {
    const chainA = chain(['p1']);
    const prev: ChainSnapshot = { chainBySession: new Map([['A', chainA]]), defaultChain: DEFAULT_CHAIN };
    const next: ChainSnapshot = { chainBySession: new Map(), defaultChain: DEFAULT_CHAIN };

    // The diff only iterates `next.chainBySession`, so a session removed from
    // the map produces no target for itself — that session no longer has any
    // chain state to notify about (it inherits the default going forward, and
    // the default itself did not change here).
    const targets = computeChangedChainSessionIds(prev, next, ['A']);

    expect(targets.size).toBe(0);
  });
});
