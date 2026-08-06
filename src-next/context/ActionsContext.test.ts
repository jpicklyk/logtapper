import { describe, it, expect, vi } from 'vitest';
import { tracked, trackMutations, MUTATION_ACTION_KEYS, ARTIFACT_MUTATION_ACTION_KEYS } from './ActionsContext';

// ---------------------------------------------------------------------------
// tracked() — wraps a function with a post-execution callback
// ---------------------------------------------------------------------------
describe('tracked', () => {
  it('calls onMutate after a sync function', () => {
    const onMutate = vi.fn();
    const fn = vi.fn(() => 42);
    const wrapped = tracked(fn, onMutate);

    const result = wrapped();
    expect(fn).toHaveBeenCalledOnce();
    expect(result).toBe(42);
    expect(onMutate).toHaveBeenCalledOnce();
  });

  it('calls onMutate after an async function resolves', async () => {
    const onMutate = vi.fn();
    const fn = vi.fn(async () => 'done');
    const wrapped = tracked(fn, onMutate);

    const result = await wrapped();
    expect(result).toBe('done');
    expect(onMutate).toHaveBeenCalledOnce();
  });

  it('passes arguments through to the wrapped function', () => {
    const onMutate = vi.fn();
    const fn = vi.fn((a: number, b: string) => `${a}-${b}`);
    const wrapped = tracked(fn, onMutate);

    expect(wrapped(5, 'hello')).toBe('5-hello');
    expect(fn).toHaveBeenCalledWith(5, 'hello');
  });

  it('does not call onMutate if async function rejects', async () => {
    const onMutate = vi.fn();
    const fn = vi.fn(async () => { throw new Error('fail'); });
    const wrapped = tracked(fn, onMutate);

    await expect(wrapped()).rejects.toThrow('fail');
    expect(onMutate).not.toHaveBeenCalled();
  });

  it('calls onMutate for void functions', () => {
    const onMutate = vi.fn();
    const fn = vi.fn(() => { /* void */ });
    const wrapped = tracked(fn, onMutate);

    wrapped();
    expect(onMutate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// trackMutations() — wraps mutation actions, leaves view actions unchanged
// ---------------------------------------------------------------------------
describe('trackMutations', () => {
  it('wraps mutation actions with the markDirty callback', () => {
    const markDirty = vi.fn();
    const loadFile = vi.fn(async () => {});
    const actions = trackMutations({ loadFile }, markDirty);

    // loadFile is a mutation action — should be wrapped
    expect(actions.loadFile).not.toBe(loadFile);
    actions.loadFile!('test.log');
    // The original function should be called
    expect(loadFile).toHaveBeenCalledWith('test.log');
  });

  it('does not wrap view actions', () => {
    const markDirty = vi.fn();
    const jumpToLine = vi.fn();
    const actions = trackMutations({ jumpToLine }, markDirty);

    // jumpToLine is a view action — should pass through unchanged
    expect(actions.jumpToLine).toBe(jumpToLine);
  });

  it('calls markDirty after sync mutation completes', () => {
    const markDirty = vi.fn();
    const addToChain = vi.fn();
    const actions = trackMutations({ addToChain }, markDirty);

    actions.addToChain!('proc-1');
    expect(addToChain).toHaveBeenCalledWith('proc-1');
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it('calls markDirty after async mutation resolves', async () => {
    const markDirty = vi.fn();
    const closeSession = vi.fn(async () => {});
    const actions = trackMutations({ closeSession }, markDirty);

    await actions.closeSession!('pane-1');
    expect(closeSession).toHaveBeenCalledWith('pane-1');
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it('does not call markDirty for non-mutation actions', () => {
    const markDirty = vi.fn();
    const jumpToLine = vi.fn();
    const openTab = vi.fn();
    const actions = trackMutations({ jumpToLine, openTab }, markDirty);

    actions.jumpToLine!(42);
    actions.openTab!('logviewer');
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('handles mixed mutation and view actions', () => {
    const markDirty = vi.fn();
    const removeFromChain = vi.fn();
    const jumpToLine = vi.fn();
    const actions = trackMutations({ removeFromChain, jumpToLine }, markDirty);

    actions.jumpToLine!(10);
    expect(markDirty).not.toHaveBeenCalled();

    actions.removeFromChain!('proc-1');
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it('does not wrap workspace lifecycle actions (they handle dirty internally)', () => {
    const markDirty = vi.fn();
    const newWorkspace = vi.fn();
    const saveWorkspace = vi.fn(async () => {});
    const actions = trackMutations({ newWorkspace, saveWorkspace }, markDirty);

    // These are NOT in MUTATION_ACTION_KEYS — they manage clean/dirty themselves
    expect(actions.newWorkspace).toBe(newWorkspace);
    expect(actions.saveWorkspace).toBe(saveWorkspace);
  });
});

// ---------------------------------------------------------------------------
// trackMutations() — artifact-tracked actions (analysis mutations)
// ---------------------------------------------------------------------------
describe('trackMutations — artifact-tracked actions', () => {
  it('wraps publishAnalysis and calls markDirty after it resolves', async () => {
    const markDirty = vi.fn();
    const publishAnalysis = vi.fn(async () => ({ id: 'art-1' }));
    const actions = trackMutations({ publishAnalysis } as never, markDirty);

    expect(actions.publishAnalysis).not.toBe(publishAnalysis);
    await actions.publishAnalysis!('title', []);
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it('wraps updateAnalysis and deleteAnalysis', async () => {
    const markDirty = vi.fn();
    const updateAnalysis = vi.fn(async () => ({ id: 'art-1' }));
    const deleteAnalysis = vi.fn(async () => {});
    const actions = trackMutations({ updateAnalysis, deleteAnalysis } as never, markDirty);

    await actions.updateAnalysis!('art-1', 'new title');
    await actions.deleteAnalysis!('art-1');
    expect(markDirty).toHaveBeenCalledTimes(2);
  });

  it('emits workspace:mutated with source "artifact" for artifact-tracked actions', async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    // Spy on the real bus (mitt) rather than mocking the module — trackMutations
    // imports `bus` directly, so intercepting emit here observes exactly what
    // it calls.
    const { bus } = await import('../events');
    const onAny = (payload: unknown) => emitted.push({ event: 'workspace:mutated', payload });
    bus.on('workspace:mutated', onAny);

    const markDirty = vi.fn();
    const deleteAnalysis = vi.fn(async () => {});
    const actions = trackMutations({ deleteAnalysis } as never, markDirty);
    await actions.deleteAnalysis!('art-1');

    bus.off('workspace:mutated', onAny);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({ source: 'artifact' });
  });

  it('emits workspace:mutated with source "workspace" for workspace-tracked actions', async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const { bus } = await import('../events');
    const onAny = (payload: unknown) => emitted.push({ event: 'workspace:mutated', payload });
    bus.on('workspace:mutated', onAny);

    const markDirty = vi.fn();
    const addToChain = vi.fn();
    const actions = trackMutations({ addToChain }, markDirty);
    actions.addToChain!('proc-1');

    bus.off('workspace:mutated', onAny);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({ source: 'workspace' });
  });
});

// ---------------------------------------------------------------------------
// ARTIFACT_MUTATION_ACTION_KEYS — registry completeness + disjointness
// ---------------------------------------------------------------------------
describe('ARTIFACT_MUTATION_ACTION_KEYS', () => {
  it('contains exactly the analysis mutation actions', () => {
    const set = ARTIFACT_MUTATION_ACTION_KEYS as ReadonlySet<string>;
    expect(set.size).toBe(3);
    expect(set.has('publishAnalysis')).toBe(true);
    expect(set.has('updateAnalysis')).toBe(true);
    expect(set.has('deleteAnalysis')).toBe(true);
  });

  it('is disjoint from MUTATION_ACTION_KEYS', () => {
    const artifactKeys = ARTIFACT_MUTATION_ACTION_KEYS as ReadonlySet<string>;
    const workspaceKeys = MUTATION_ACTION_KEYS as ReadonlySet<string>;
    const intersection = [...artifactKeys].filter((k) => workspaceKeys.has(k));
    expect(intersection).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MUTATION_ACTION_KEYS — registry completeness
// ---------------------------------------------------------------------------
describe('MUTATION_ACTION_KEYS', () => {
  it('contains only valid WorkspaceMutationActions keys', () => {
    // Ensure the set is non-empty and has the expected size
    expect(MUTATION_ACTION_KEYS.size).toBeGreaterThan(0);
    expect(MUTATION_ACTION_KEYS.size).toBe(11);
  });

  it('does not contain workspace lifecycle actions', () => {
    // These manage their own clean/dirty transitions
    const set = MUTATION_ACTION_KEYS as ReadonlySet<string>;
    expect(set.has('newWorkspace')).toBe(false);
    expect(set.has('openWorkspace')).toBe(false);
    expect(set.has('saveWorkspace')).toBe(false);
    expect(set.has('saveWorkspaceAs')).toBe(false);
  });

  it('does not contain view actions', () => {
    const set = MUTATION_ACTION_KEYS as ReadonlySet<string>;
    expect(set.has('jumpToLine')).toBe(false);
    expect(set.has('setStreamFilter')).toBe(false);
    expect(set.has('openTab')).toBe(false);
    expect(set.has('runPipeline')).toBe(false);
  });

  it('contains all expected mutation actions', () => {
    const expected = [
      'loadFile', 'startStream', 'closeSession',
      'installProcessor', 'removeProcessor',
      'addToChain', 'addPackToChain', 'removeFromChain', 'reorderChain', 'toggleChainEnabled',
    ];
    for (const key of expected) {
      expect(MUTATION_ACTION_KEYS.has(key as never)).toBe(true);
    }
  });
});
