// @vitest-environment jsdom
/**
 * `usePipelineCommands.run` after the effective-chain resolution moved to Rust.
 *
 * The hook used to compute `active − disabled`, filter it to installed
 * processors and send the result to `run_pipeline`. `services::pipeline::
 * resolve_effective_chain` now owns that, so the hook pushes the session's chain
 * inputs and asks for `null`. Three facts are load-bearing and pinned here:
 *
 * 1. `runPipeline` is called with `null` — never a computed chain.
 * 2. `setSessionPipelineMeta` is pushed FIRST and awaited. `usePipelineWiring`
 *    debounces its own push by 500ms, so without this a user who edits the chain
 *    and immediately hits Run would race the timer and run the previous chain.
 * 3. The `pipeline:completed` payload's hasTrackers/hasReporters/hasCorrelators
 *    are derived from the backend's `effectiveProcessorIds`, not from anything
 *    the hook asked for — that is the whole point of the new return type.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { PipelineRunResult, ProcessorSummary } from '../bridge/types';

const runPipelineMock = vi.fn<(s: string, ids: string[] | null) => Promise<PipelineRunResult>>();
const setMetaMock = vi.fn<(s: string, a: string[], d: string[]) => Promise<void>>();
const calls: string[] = [];

vi.mock('../bridge/commands', () => ({
  listProcessors: () => Promise.resolve([]),
  listPacks: () => Promise.resolve([]),
  loadProcessorYaml: () => Promise.resolve(),
  uninstallProcessor: () => Promise.resolve(),
  getProcessorVars: () => Promise.resolve({}),
  stopPipeline: () => Promise.resolve(),
  runPipeline: (s: string, ids: string[] | null) => {
    calls.push('run');
    return runPipelineMock(s, ids);
  },
  setSessionPipelineMeta: (s: string, a: string[], d: string[]) => {
    calls.push('meta');
    return setMetaMock(s, a, d);
  },
}));

import { usePipelineCommands } from './usePipelineCommands';
import { PipelineProvider, usePipelineContext } from '../context/PipelineContext';
import { bus } from '../events/bus';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(PipelineProvider, null, children);
}

function processor(id: string, processorType: ProcessorSummary['processorType']): ProcessorSummary {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    processorType,
    varsMeta: [],
    hasSchema: false,
    trackerSections: [],
    sourceTypes: [],
  } as unknown as ProcessorSummary;
}

function result(over: Partial<PipelineRunResult> = {}): PipelineRunResult {
  return { sessionId: 's1', effectiveProcessorIds: [], summaries: [], ...over };
}

function setup() {
  return renderHook(
    () => ({ actions: usePipelineCommands(), ctx: usePipelineContext() }),
    { wrapper },
  );
}

describe('usePipelineCommands.run — backend-resolved chain', () => {
  beforeEach(() => {
    calls.length = 0;
    runPipelineMock.mockReset();
    runPipelineMock.mockResolvedValue(result());
    setMetaMock.mockReset();
    setMetaMock.mockResolvedValue(undefined);
    bus.all.clear();
  });

  it('asks for null and lets the backend resolve the chain', async () => {
    const { result: r } = setup();
    await act(async () => { await r.current.actions.run('s1'); });

    expect(runPipelineMock).toHaveBeenCalledWith('s1', null);
  });

  it('pushes the session meta BEFORE running', async () => {
    const { result: r } = setup();
    act(() => {
      r.current.ctx.dispatch({ type: 'chain:add', sessionId: 's1', id: 'p1' });
    });
    await act(async () => { await r.current.actions.run('s1'); });

    expect(calls).toEqual(['meta', 'run']);
    expect(setMetaMock).toHaveBeenCalledWith('s1', ['p1'], []);
  });

  it('pushes the override chain, not the (still unrendered) reducer state', async () => {
    const { result: r } = setup();
    await act(async () => {
      await r.current.actions.run('s1', { chain: ['a', 'b'], disabled: ['b'] });
    });

    expect(setMetaMock).toHaveBeenCalledWith('s1', ['a', 'b'], ['b']);
    expect(runPipelineMock).toHaveBeenCalledWith('s1', null);
  });

  it('derives the completed-event flags from effectiveProcessorIds', async () => {
    runPipelineMock.mockResolvedValue(
      result({ effectiveProcessorIds: ['tracker@x', '__pii_anonymizer'] }),
    );
    const { result: r } = setup();
    act(() => {
      r.current.ctx.dispatch({
        type: 'processors:loaded',
        processors: [
          processor('tracker@x', 'state_tracker'),
          processor('reporter@x', 'reporter'),
          processor('__pii_anonymizer', 'transformer'),
        ],
      });
    });

    const seen: unknown[] = [];
    bus.on('pipeline:completed', (e) => seen.push(e));
    await act(async () => { await r.current.actions.run('s1'); });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: 's1',
      hasTrackers: true,
      // `reporter@x` is installed but NOT in effectiveProcessorIds — the old code
      // read the chain it sent, which could disagree with what actually ran.
      hasReporters: false,
      hasCorrelators: false,
    });
  });

  it('treats "no pipeline chain configured" as a silent no-op, not an error', async () => {
    runPipelineMock.mockRejectedValue('no pipeline chain configured for session s1');
    const { result: r } = setup();
    await act(async () => { await r.current.actions.run('s1'); });

    const state = r.current.ctx.resultsBySession.get('s1');
    expect(state?.error ?? null).toBeNull();
    expect(state?.running).toBe(false);
  });

  it('still surfaces a real failure', async () => {
    runPipelineMock.mockRejectedValue('Session not found: s1');
    const { result: r } = setup();
    await act(async () => { await r.current.actions.run('s1'); });

    expect(r.current.ctx.resultsBySession.get('s1')?.error).toContain('Session not found');
  });
});

describe('usePipelineCommands.activeInstalledFor', () => {
  beforeEach(() => { bus.all.clear(); });

  it('drops chain ids whose processor is no longer installed', () => {
    const { result: r } = setup();
    act(() => {
      r.current.ctx.dispatch({ type: 'chain:add', sessionId: null, id: 'kept@x' });
      r.current.ctx.dispatch({ type: 'chain:add', sessionId: null, id: 'gone@x' });
      // `processors:loaded` is what a pack uninstall triggers; it replaces the
      // library WITHOUT pruning chains, which is exactly how a dangling id
      // survives to reach `start_adb_stream`.
      r.current.ctx.dispatch({
        type: 'processors:loaded',
        processors: [processor('kept@x', 'reporter')],
      });
    });

    expect(r.current.actions.activeInstalledFor(null)).toEqual(['kept@x']);
  });

  it('keeps workspace-local @lts- ids, which the backend also exempts', () => {
    const { result: r } = setup();
    act(() => {
      r.current.ctx.dispatch({ type: 'chain:add', sessionId: null, id: 'wifi@lts-abc' });
      r.current.ctx.dispatch({ type: 'processors:loaded', processors: [] });
    });

    expect(r.current.actions.activeInstalledFor(null)).toEqual(['wifi@lts-abc']);
  });

  it('omits disabled processors', () => {
    const { result: r } = setup();
    act(() => {
      r.current.ctx.dispatch({ type: 'chain:add', sessionId: null, id: 'a@x' });
      r.current.ctx.dispatch({ type: 'chain:add', sessionId: null, id: 'b@x' });
      r.current.ctx.dispatch({ type: 'chain:toggle-enabled', sessionId: null, id: 'b@x' });
      r.current.ctx.dispatch({
        type: 'processors:loaded',
        processors: [processor('a@x', 'reporter'), processor('b@x', 'reporter')],
      });
    });

    expect(r.current.actions.activeInstalledFor(null)).toEqual(['a@x']);
  });
});
