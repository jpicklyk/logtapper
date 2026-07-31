/**
 * Tests for the pipeline reducer — the per-session chain in particular.
 *
 * The chain used to be a single global array while results were already keyed
 * by session, so "configure a chain for the dmesg session" silently re-pointed
 * it at the logcat session. These tests pin the isolation that fixed it: an
 * edit to one session's chain must never be observable from another, and a
 * session with no chain of its own inherits `defaultChain` by copy-on-write
 * rather than by sharing a reference.
 *
 * White-box: the reducer is pure, so it is imported and driven directly rather
 * than simulated. No DOM — vitest runs these in the node environment.
 */
import { describe, it, expect } from 'vitest';
import {
  pipelineReducer,
  initialState,
  PINNED_TAIL_IDS,
  type PipelineState,
  type PipelineAction,
} from './PipelineContext';
import type { ProcessorSummary, PipelineRunSummary } from '../bridge/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The one pinned-tail id in the codebase; assert rather than restate it. */
const PINNED = '__pii_anonymizer';

const A = 'session-a';
const B = 'session-b';

function reduce(state: PipelineState, ...actions: PipelineAction[]): PipelineState {
  return actions.reduce(pipelineReducer, state);
}

/** Chain ids for a session, resolving inheritance the way `getChain` does. */
function chainOf(state: PipelineState, sessionId: string | null): string[] {
  if (!sessionId) return state.defaultChain.chain;
  return (state.chainBySession.get(sessionId) ?? state.defaultChain).chain;
}

function entryOf(state: PipelineState, sessionId: string) {
  return state.chainBySession.get(sessionId);
}

function processor(id: string, name = id): ProcessorSummary {
  return {
    id,
    name,
    version: '1.0.0',
    description: '',
    tags: [],
    builtin: id.startsWith('__'),
    processorType: 'reporter',
    group: null,
    varsMeta: [],
    deprecated: false,
    hasSchema: false,
  };
}

function runResult(processorId: string, matchedLines = 1): PipelineRunSummary {
  return { processorId, matchedLines, emissionCount: 0 };
}

// ---------------------------------------------------------------------------
// The pinned-tail invariant this suite depends on
// ---------------------------------------------------------------------------

describe('PINNED_TAIL_IDS', () => {
  it('contains the PII anonymizer', () => {
    // The anonymizer must run last: it rewrites lines, so anything after it
    // would see redacted input. Several tests below encode that assumption.
    expect(PINNED_TAIL_IDS.has(PINNED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-session isolation — the point of the feature
// ---------------------------------------------------------------------------

describe('per-session chain isolation', () => {
  it('keeps one session\'s chain edits out of another session', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: B, id: 'p2' },
    );

    expect(chainOf(state, A)).toEqual(['p1']);
    expect(chainOf(state, B)).toEqual(['p2']);
  });

  it('does not mutate the default when a session edits its own chain', () => {
    const seeded = reduce(initialState, { type: 'chain:add', sessionId: null, id: 'base' });
    const after = reduce(seeded, { type: 'chain:add', sessionId: A, id: 'extra' });

    // A forked from the default; the default itself is untouched.
    expect(chainOf(after, A)).toEqual(['base', 'extra']);
    expect(after.defaultChain.chain).toEqual(['base']);
    expect(after.defaultChain).toBe(seeded.defaultChain);
  });

  it('inherits the default for a session with no chain of its own', () => {
    const state = reduce(initialState, { type: 'chain:add', sessionId: null, id: 'base' });

    expect(entryOf(state, B)).toBeUndefined();
    expect(chainOf(state, B)).toEqual(['base']);
  });

  it('forks the default on first edit rather than sharing its array', () => {
    const seeded = reduce(initialState, { type: 'chain:add', sessionId: null, id: 'base' });
    const after = reduce(seeded, { type: 'chain:add', sessionId: A, id: 'p1' });

    // Copy-on-write: A now has its own entry, distinct from the default object.
    expect(entryOf(after, A)).toBeDefined();
    expect(entryOf(after, A)).not.toBe(after.defaultChain);
    expect(entryOf(after, A)!.chain).not.toBe(after.defaultChain.chain);
  });

  it('routes a null sessionId to the default, not to any session', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: null, id: 'shared' },
    );

    expect(state.defaultChain.chain).toEqual(['shared']);
    expect(chainOf(state, A)).toEqual(['p1']);
  });

  it('isolates disabled sets per session', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: B, id: 'p1' },
      { type: 'chain:toggle-enabled', sessionId: A, id: 'p1' },
    );

    expect(entryOf(state, A)!.disabled).toEqual(['p1']);
    expect(entryOf(state, A)!.active).toEqual([]);
    expect(entryOf(state, B)!.disabled).toEqual([]);
    expect(entryOf(state, B)!.active).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// chain:add
// ---------------------------------------------------------------------------

describe('chain:add', () => {
  it('appends a processor to the end', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: A, id: 'p2' },
    );
    expect(chainOf(state, A)).toEqual(['p1', 'p2']);
  });

  it('returns the identical state for a duplicate id', () => {
    const once = reduce(initialState, { type: 'chain:add', sessionId: A, id: 'p1' });
    const twice = pipelineReducer(once, { type: 'chain:add', sessionId: A, id: 'p1' });

    // Reference equality matters: a new object here would re-render consumers.
    expect(twice).toBe(once);
  });

  it('inserts a normal processor before the pinned tail', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: PINNED },
      { type: 'chain:add', sessionId: A, id: 'p1' },
    );
    expect(chainOf(state, A)).toEqual(['p1', PINNED]);
  });

  it('keeps a pinned processor at the tail when added last', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: A, id: PINNED },
    );
    expect(chainOf(state, A)).toEqual(['p1', PINNED]);
  });

  it('maintains the pinned tail across several later additions', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: PINNED },
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: A, id: 'p2' },
    );
    expect(chainOf(state, A)).toEqual(['p1', 'p2', PINNED]);
  });

  it('tracks the active subset alongside the chain', () => {
    const state = reduce(initialState, { type: 'chain:add', sessionId: A, id: 'p1' });
    expect(entryOf(state, A)!.active).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// chain:add-pack
// ---------------------------------------------------------------------------

describe('chain:add-pack', () => {
  it('adds every processor in the pack', () => {
    const state = reduce(initialState, {
      type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2', 'p3'],
    });
    expect(chainOf(state, A)).toEqual(['p1', 'p2', 'p3']);
  });

  it('skips ids already in the chain', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
    );
    expect(chainOf(state, A)).toEqual(['p1', 'p2']);
  });

  it('inserts the pack before an existing pinned tail', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: PINNED },
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
    );
    expect(chainOf(state, A)).toEqual(['p1', 'p2', PINNED]);
  });

  it('places a pinned id from the pack at the tail', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p2', PINNED] },
    );
    expect(chainOf(state, A)).toEqual(['p1', 'p2', PINNED]);
  });

  it('returns the identical state when every id is already present', () => {
    const once = reduce(initialState, {
      type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'],
    });
    const twice = pipelineReducer(once, {
      type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'],
    });
    expect(twice).toBe(once);
  });

  it('applies to one session only', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: B, id: 'keep' },
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
    );
    expect(chainOf(state, B)).toEqual(['keep']);
  });
});

// ---------------------------------------------------------------------------
// chain:remove
// ---------------------------------------------------------------------------

describe('chain:remove', () => {
  it('removes the processor from the chain', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
      { type: 'chain:remove', sessionId: A, id: 'p1' },
    );
    expect(chainOf(state, A)).toEqual(['p2']);
  });

  it('drops the id from the disabled set too', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
      { type: 'chain:toggle-enabled', sessionId: A, id: 'p1' },
      { type: 'chain:remove', sessionId: A, id: 'p1' },
    );

    // A stale disabled entry would silently disable the processor if it were
    // ever re-added.
    expect(entryOf(state, A)!.disabled).toEqual([]);
    expect(entryOf(state, A)!.active).toEqual(['p2']);
  });

  it('leaves other sessions untouched', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: B, id: 'p1' },
      { type: 'chain:remove', sessionId: A, id: 'p1' },
    );
    expect(chainOf(state, A)).toEqual([]);
    expect(chainOf(state, B)).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// chain:toggle-enabled
// ---------------------------------------------------------------------------

describe('chain:toggle-enabled', () => {
  it('disables then re-enables a processor', () => {
    const added = reduce(initialState, { type: 'chain:add', sessionId: A, id: 'p1' });

    const off = pipelineReducer(added, { type: 'chain:toggle-enabled', sessionId: A, id: 'p1' });
    expect(entryOf(off, A)!.disabled).toEqual(['p1']);
    expect(entryOf(off, A)!.active).toEqual([]);

    const on = pipelineReducer(off, { type: 'chain:toggle-enabled', sessionId: A, id: 'p1' });
    expect(entryOf(on, A)!.disabled).toEqual([]);
    expect(entryOf(on, A)!.active).toEqual(['p1']);
  });

  it('keeps the disabled processor in the chain', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
      { type: 'chain:toggle-enabled', sessionId: A, id: 'p1' },
    );
    // Disabled means "present but excluded from execution", not "removed".
    expect(chainOf(state, A)).toEqual(['p1', 'p2']);
    expect(entryOf(state, A)!.active).toEqual(['p2']);
  });

  it('returns the identical state for an id not in the chain', () => {
    const added = reduce(initialState, { type: 'chain:add', sessionId: A, id: 'p1' });
    const same = pipelineReducer(added, { type: 'chain:toggle-enabled', sessionId: A, id: 'absent' });
    expect(same).toBe(added);
  });
});

// ---------------------------------------------------------------------------
// chain:reorder
// ---------------------------------------------------------------------------

describe('chain:reorder', () => {
  it('moves a processor to a new index', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2', 'p3'] },
      { type: 'chain:reorder', sessionId: A, fromIndex: 0, toIndex: 2 },
    );
    expect(chainOf(state, A)).toEqual(['p2', 'p3', 'p1']);
  });

  it('refuses to move the pinned processor', () => {
    const added = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
      { type: 'chain:add', sessionId: A, id: PINNED },
    );
    const same = pipelineReducer(added, { type: 'chain:reorder', sessionId: A, fromIndex: 2, toIndex: 0 });

    expect(same).toBe(added);
    expect(chainOf(same, A)).toEqual(['p1', 'p2', PINNED]);
  });

  it('clamps a move that would land past the pinned tail', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
      { type: 'chain:add', sessionId: A, id: PINNED },
      // Try to drop p1 onto the pinned slot; it must stop just before it.
      { type: 'chain:reorder', sessionId: A, fromIndex: 0, toIndex: 2 },
    );
    expect(chainOf(state, A)).toEqual(['p2', 'p1', PINNED]);
  });

  it('reorders one session without disturbing another', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['p1', 'p2'] },
      { type: 'chain:add-pack', sessionId: B, processorIds: ['p1', 'p2'] },
      { type: 'chain:reorder', sessionId: A, fromIndex: 0, toIndex: 1 },
    );
    expect(chainOf(state, A)).toEqual(['p2', 'p1']);
    expect(chainOf(state, B)).toEqual(['p1', 'p2']);
  });
});

// ---------------------------------------------------------------------------
// chain:restore — including the legacy single-chain workspace path
// ---------------------------------------------------------------------------

describe('chain:restore', () => {
  it('restores a chain onto a specific session', () => {
    const state = reduce(initialState, {
      type: 'chain:restore', sessionId: A, chain: ['p1', 'p2'], disabledChainIds: ['p2'],
    });

    expect(chainOf(state, A)).toEqual(['p1', 'p2']);
    expect(entryOf(state, A)!.disabled).toEqual(['p2']);
    expect(entryOf(state, A)!.active).toEqual(['p1']);
  });

  it('forces pinned ids to the tail regardless of saved order', () => {
    const state = reduce(initialState, {
      type: 'chain:restore', sessionId: A, chain: [PINNED, 'p1', 'p2'], disabledChainIds: [],
    });
    expect(chainOf(state, A)).toEqual(['p1', 'p2', PINNED]);
  });

  // NOTE: the two `sessionId: null` cases below cover the REDUCER branch only.
  // No production code dispatches `chain:restore` with a null sessionId today —
  // `useWorkspaceRestore.ts:75` always passes a concrete session, and a legacy
  // workspace instead reaches the default via `processors:loaded`, whose chain
  // comes from localStorage rather than the `.ltw`. So these prove the branch
  // works, NOT that legacy restore works end to end. See the open gap noted with
  // work item f541e816.
  it('restores a legacy global chain onto the default (reducer branch only)', () => {
    // A v3 workspace stored ONE chain with no session key; it arrives with a
    // null sessionId and must become the template every session inherits.
    const state = reduce(initialState, {
      type: 'chain:restore', sessionId: null, chain: ['p1', 'p2'], disabledChainIds: [],
    });

    expect(state.defaultChain.chain).toEqual(['p1', 'p2']);
    expect(state.chainBySession.size).toBe(0);
    expect(chainOf(state, A)).toEqual(['p1', 'p2']);
    expect(chainOf(state, B)).toEqual(['p1', 'p2']);
  });

  it('leaves a session that already has its own chain out of the legacy path', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'mine' },
      { type: 'chain:restore', sessionId: null, chain: ['legacy'], disabledChainIds: [] },
    );

    expect(chainOf(state, A)).toEqual(['mine']);
    expect(chainOf(state, B)).toEqual(['legacy']);
  });
});

// ---------------------------------------------------------------------------
// Processor library interaction
// ---------------------------------------------------------------------------

describe('processors:loaded', () => {
  it('seeds the default chain rather than any session', () => {
    // Sessions may not exist yet at library-load time.
    const state = reduce(initialState, {
      type: 'processors:loaded',
      processors: [processor('p1')],
      initialChain: ['p1'],
      initialDisabled: [],
    });

    expect(state.defaultChain.chain).toEqual(['p1']);
    expect(state.chainBySession.size).toBe(0);
  });

  it('leaves chains alone when no initial chain is supplied', () => {
    const seeded = reduce(initialState, { type: 'chain:add', sessionId: A, id: 'p1' });
    const state = pipelineReducer(seeded, {
      type: 'processors:loaded', processors: [processor('p1')],
    });

    expect(chainOf(state, A)).toEqual(['p1']);
    expect(state.defaultChain).toBe(seeded.defaultChain);
    expect(state.processors).toHaveLength(1);
  });

  // The seed decision moved out of `usePipeline`'s per-instance refs and into
  // the reducer when the hook was split into wiring + actions: `loadProcessors`
  // now runs from several components and passes the localStorage seed every
  // time, so only the reducer can know whether it is still the first load.
  it('applies the localStorage seed on the first load only', () => {
    const first = reduce(initialState, {
      type: 'processors:loaded',
      processors: [processor('p1'), processor('p2')],
      initialChain: ['p1'],
      initialDisabled: [],
    });
    expect(first.chainInitialized).toBe(true);

    // A second component calling loadProcessors must not re-seed over a chain
    // the user has edited since.
    const edited = reduce(first, { type: 'chain:add', sessionId: null, id: 'p2' });
    const second = pipelineReducer(edited, {
      type: 'processors:loaded',
      processors: [processor('p1'), processor('p2')],
      initialChain: ['p1'],
      initialDisabled: [],
    });

    expect(second.defaultChain.chain).toEqual(['p1', 'p2']);
    expect(second.defaultChain).toBe(edited.defaultChain);
  });

  it('never seeds over a chain a workspace restore already set', () => {
    // Restore can land before the library finishes loading. The seed carries the
    // PREVIOUS workspace's chain, so applying it here would silently swap the
    // restored session's processors.
    const state = reduce(
      initialState,
      { type: 'chain:restore', sessionId: A, chain: ['restored'], disabledChainIds: [] },
      {
        type: 'processors:loaded',
        processors: [processor('restored'), processor('stale')],
        initialChain: ['stale'],
        initialDisabled: [],
      },
    );

    expect(chainOf(state, A)).toEqual(['restored']);
    expect(state.defaultChain.chain).toEqual([]);
  });
});

describe('processor:removed', () => {
  it('removes the processor from every session chain and the default', () => {
    // A background session must not keep a dangling id for something that is
    // no longer installed.
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: null, id: 'gone' },
      { type: 'chain:add-pack', sessionId: A, processorIds: ['gone', 'p1'] },
      { type: 'chain:add-pack', sessionId: B, processorIds: ['p2', 'gone'] },
      { type: 'processor:removed', id: 'gone' },
    );

    expect(chainOf(state, A)).toEqual(['p1']);
    expect(chainOf(state, B)).toEqual(['p2']);
    expect(state.defaultChain.chain).toEqual([]);
  });

  it('clears the removed id from disabled sets as well', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add-pack', sessionId: A, processorIds: ['gone', 'p1'] },
      { type: 'chain:toggle-enabled', sessionId: A, id: 'gone' },
      { type: 'processor:removed', id: 'gone' },
    );

    expect(entryOf(state, A)!.disabled).toEqual([]);
    expect(entryOf(state, A)!.active).toEqual(['p1']);
  });

  it('drops it from the installed processor list', () => {
    const state = reduce(
      initialState,
      { type: 'processors:loaded', processors: [processor('gone'), processor('p1')] },
      { type: 'processor:removed', id: 'gone' },
    );
    expect(state.processors.map((p) => p.id)).toEqual(['p1']);
  });
});

describe('processor:installed', () => {
  it('inserts the processor in name order', () => {
    const state = reduce(
      initialState,
      { type: 'processors:loaded', processors: [processor('a', 'Alpha'), processor('c', 'Charlie')] },
      { type: 'processor:installed', processor: processor('b', 'Bravo') },
    );
    expect(state.processors.map((p) => p.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('replaces an existing entry with the same id', () => {
    const state = reduce(
      initialState,
      { type: 'processors:loaded', processors: [processor('a', 'Alpha')] },
      { type: 'processor:installed', processor: { ...processor('a', 'Alpha'), version: '2.0.0' } },
    );
    expect(state.processors).toHaveLength(1);
    expect(state.processors[0].version).toBe('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('session:removed', () => {
  it('drops the closed session\'s chain', () => {
    // Without this the Map grows unbounded across a long session.
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'session:removed', sessionId: A },
    );
    expect(state.chainBySession.has(A)).toBe(false);
  });

  it('drops the closed session\'s results', () => {
    const state = reduce(
      initialState,
      { type: 'run:complete', sessionId: A, results: [runResult('p1')], newRunCount: 1 },
      { type: 'session:removed', sessionId: A },
    );
    expect(state.resultsBySession.has(A)).toBe(false);
  });

  it('leaves other sessions and the default intact', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: null, id: 'base' },
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'chain:add', sessionId: B, id: 'p2' },
      { type: 'session:removed', sessionId: A },
    );

    // B forked from the seeded default, so it keeps `base` alongside its own
    // addition — closing A must not disturb either.
    expect(chainOf(state, B)).toEqual(['base', 'p2']);
    expect(state.defaultChain.chain).toEqual(['base']);
  });

  it('returns the identical state for a session it never tracked', () => {
    const seeded = reduce(initialState, { type: 'chain:add', sessionId: A, id: 'p1' });
    const same = pipelineReducer(seeded, { type: 'session:removed', sessionId: 'never-seen' });
    expect(same).toBe(seeded);
  });
});

// ---------------------------------------------------------------------------
// Results stay per-session — regression cover for the chain refactor
// ---------------------------------------------------------------------------

describe('per-session results', () => {
  it('scopes a completed run to its own session', () => {
    const state = reduce(
      initialState,
      { type: 'run:complete', sessionId: A, results: [runResult('p1', 5)], newRunCount: 1 },
    );

    expect(state.resultsBySession.get(A)!.results).toEqual([runResult('p1', 5)]);
    expect(state.resultsBySession.has(B)).toBe(false);
  });

  it('tracks running state independently across sessions', () => {
    const state = reduce(
      initialState,
      { type: 'run:started', sessionId: A },
      { type: 'run:complete', sessionId: A, results: [], newRunCount: 1 },
      { type: 'run:started', sessionId: B },
    );

    expect(state.resultsBySession.get(A)!.running).toBe(false);
    expect(state.resultsBySession.get(B)!.running).toBe(true);
  });

  it('keeps a run failure out of the other session', () => {
    const state = reduce(
      initialState,
      { type: 'run:started', sessionId: B },
      { type: 'run:failed', sessionId: A, error: 'boom' },
    );

    expect(state.resultsBySession.get(A)!.error).toBe('boom');
    expect(state.resultsBySession.get(B)!.error).toBeNull();
  });

  it('applies a batched ADB update to each session separately', () => {
    const state = reduce(initialState, {
      type: 'adb:results-batch',
      updates: [
        { sessionId: A, processorId: 'p1', matchedLines: 3, emissionCount: 1 },
        { sessionId: B, processorId: 'p1', matchedLines: 7, emissionCount: 2 },
        { sessionId: A, processorId: 'p2', matchedLines: 4, emissionCount: 0 },
      ],
    });

    expect(state.resultsBySession.get(A)!.results).toEqual([
      { processorId: 'p1', matchedLines: 3, emissionCount: 1 },
      { processorId: 'p2', matchedLines: 4, emissionCount: 0 },
    ]);
    expect(state.resultsBySession.get(B)!.results).toEqual([
      { processorId: 'p1', matchedLines: 7, emissionCount: 2 },
    ]);
  });

  it('overwrites a processor\'s counts rather than appending on ADB update', () => {
    // The backend sends accumulated totals, not deltas.
    const state = reduce(
      initialState,
      { type: 'adb:results-update', sessionId: A, processorId: 'p1', matchedLines: 3, emissionCount: 1 },
      { type: 'adb:results-update', sessionId: A, processorId: 'p1', matchedLines: 9, emissionCount: 4 },
    );

    expect(state.resultsBySession.get(A)!.results).toEqual([
      { processorId: 'p1', matchedLines: 9, emissionCount: 4 },
    ]);
  });

  it('clears results without touching the session\'s chain', () => {
    const state = reduce(
      initialState,
      { type: 'chain:add', sessionId: A, id: 'p1' },
      { type: 'run:complete', sessionId: A, results: [runResult('p1')], newRunCount: 1 },
      { type: 'results:cleared', sessionId: A },
    );

    expect(state.resultsBySession.get(A)!.results).toEqual([]);
    expect(chainOf(state, A)).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// Global error channel
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('sets and clears the global error', () => {
    const set = reduce(initialState, { type: 'error:set', error: 'install failed' });
    expect(set.error).toBe('install failed');

    const cleared = pipelineReducer(set, { type: 'error:clear' });
    expect(cleared.error).toBeNull();
  });

  it('keeps the global error off the per-session error field', () => {
    // Install/remove failures are global; run failures are per-session.
    const state = reduce(
      initialState,
      { type: 'run:started', sessionId: A },
      { type: 'error:set', error: 'install failed' },
    );

    expect(state.error).toBe('install failed');
    expect(state.resultsBySession.get(A)!.error).toBeNull();
  });
});
