import { describe, it, expect, vi } from 'vitest';
import { tracked, trackMutations, MUTATION_ACTION_KEYS } from './ActionsContext';

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
    const setSearch = vi.fn();
    const actions = trackMutations({ jumpToLine, setSearch }, markDirty);

    actions.jumpToLine!(42);
    actions.setSearch!(null);
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
// MUTATION_ACTION_KEYS — registry completeness
// ---------------------------------------------------------------------------
describe('MUTATION_ACTION_KEYS', () => {
  it('contains only valid WorkspaceMutationActions keys', () => {
    // Ensure the set is non-empty and has the expected size
    expect(MUTATION_ACTION_KEYS.size).toBeGreaterThan(0);
    expect(MUTATION_ACTION_KEYS.size).toBe(10);
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
    expect(set.has('setSearch')).toBe(false);
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
