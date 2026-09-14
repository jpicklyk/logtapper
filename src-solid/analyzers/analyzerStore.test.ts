import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProcessorSummary,
  PackSummary,
  PipelineRunResult,
  PipelineProgress,
  MatchedLine,
} from '@bridge/types';
import {
  createAnalyzerStore,
  PII_ANONYMIZER_ID,
  PINNED_TAIL_IDS,
  mergeProcessorResult,
  applyExcludedProcessors,
} from './analyzerStore';
import type { AnalyzerStore, AnalyzerCommands, AnalyzerSessions } from './analyzerStore';

// The store imports `@tauri-apps/plugin-dialog` for its default `chooseFile` —
// every test injects its own, but the module-level import must still resolve.
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const tick = (): Promise<void> => Promise.resolve().then(() => Promise.resolve());

function processor(id: string, overrides: Partial<ProcessorSummary> = {}): ProcessorSummary {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    tags: [],
    builtin: false,
    processorType: 'reporter',
    group: null,
    varsMeta: [],
    deprecated: false,
    hasSchema: false,
    trackerSections: [],
    sourceTypes: [],
    ...overrides,
  };
}

function pack(id: string, processorIds: string[]): PackSummary {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    tags: [],
    category: null,
    license: null,
    repository: null,
    deprecated: false,
    processorIds,
  };
}

function runResult(sessionId: string, summaries: PipelineRunResult['summaries'] = []): PipelineRunResult {
  return { sessionId, effectiveProcessorIds: summaries.map((s) => s.processorId), summaries };
}

function summary(processorId: string, overrides: Partial<PipelineRunResult['summaries'][number]> = {}) {
  return { processorId, matchedLines: 0, emissionCount: 0, scriptErrors: 0, scannedFrom: 0, ...overrides };
}

/** A promise plus its settlers, for controlling exactly when IPC "resolves". */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCommands(overrides: Partial<AnalyzerCommands> = {}): AnalyzerCommands {
  return {
    listProcessors: vi.fn(async () => []),
    listPacks: vi.fn(async () => []),
    loadProcessorFromFile: vi.fn(async () => processor('installed')),
    uninstallProcessor: vi.fn(async () => undefined),
    setSessionPipelineMeta: vi.fn(async () => undefined),
    runPipeline: vi.fn(async (sessionId: string) => runResult(sessionId)),
    stopPipeline: vi.fn(async () => undefined),
    getMatchedLines: vi.fn(async () => []),
    getCorrelatorEvents: vi.fn(async () => ({ guidance: null, events: [] })),
    getProcessorVars: vi.fn(async () => ({})),
    ...overrides,
  };
}

interface Harness {
  store: AnalyzerStore;
  commands: AnalyzerCommands;
  controller: { setLineSet: ReturnType<typeof vi.fn>; scrollToLine: ReturnType<typeof vi.fn> };
  unlisten: ReturnType<typeof vi.fn>;
  chooseFile: ReturnType<typeof vi.fn>;
  fireProgress: (payload: PipelineProgress) => void;
  setOrder: (ids: string[]) => void;
}

function mount(commandOverrides: Partial<AnalyzerCommands> = {}): Harness {
  const [order, setOrderSignal] = createSignal<readonly string[]>([]);
  const commands = makeCommands(commandOverrides);
  const controller = { setLineSet: vi.fn(), scrollToLine: vi.fn() };
  const unlisten = vi.fn();
  const chooseFile = vi.fn(async () => null);
  let progressCb: ((payload: PipelineProgress) => void) | null = null;
  const listen = vi.fn((cb: (payload: PipelineProgress) => void) => {
    progressCb = cb;
    return Promise.resolve(unlisten);
  });
  const sessions: AnalyzerSessions = { order: () => order() };

  const store = createAnalyzerStore({ sessions, controller, listen, commands, chooseFile });

  return {
    store,
    commands,
    controller,
    unlisten,
    chooseFile,
    fireProgress: (payload) => progressCb?.(payload),
    setOrder: (ids) => setOrderSignal(ids),
  };
}

describe('analyzerStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Anonymizer invariant ─────────────────────────────────────────────────

  describe('the __pii_anonymizer invariant', () => {
    it('pinnedTail reports exactly the backend-appended id', () => {
      const { store } = mount();
      expect(store.pinnedTail()).toEqual(['__pii_anonymizer']);
      expect(PINNED_TAIL_IDS).toEqual([PII_ANONYMIZER_ID]);
    });

    it('add() is a no-op for the anonymizer id', () => {
      const { store } = mount();
      store.add('s1', PII_ANONYMIZER_ID);
      expect(store.chain('s1').order).toEqual([]);
      expect(store.chain('s1').active).toEqual([]);
    });

    it('reorder never has to route around the anonymizer, because it can never enter the chain', () => {
      const { store } = mount();
      store.add('s1', 'a');
      store.add('s1', PII_ANONYMIZER_ID);
      store.add('s1', 'b');
      expect(store.chain('s1').order).toEqual(['a', 'b']);
      store.reorder('s1', 0, 1);
      expect(store.chain('s1').order).toEqual(['b', 'a']);
    });

    it('applyWorkspaceChain strips the anonymizer id from a restored chain', () => {
      const { store } = mount();
      store.applyWorkspaceChain({ chain: ['a', PII_ANONYMIZER_ID], disabledChainIds: [] }, 's1');
      expect(store.chain('s1').order).toEqual(['a']);
    });
  });

  // ── Chain mutation ───────────────────────────────────────────────────────

  describe('chain mutation', () => {
    it('add/remove/toggle keep active in sync with order and disabled', () => {
      const { store } = mount();
      store.add('s1', 'a');
      store.add('s1', 'b');
      expect(store.chain('s1')).toEqual({ order: ['a', 'b'], disabled: [], active: ['a', 'b'] });

      store.toggle('s1', 'a');
      expect(store.chain('s1')).toEqual({ order: ['a', 'b'], disabled: ['a'], active: ['b'] });

      store.toggle('s1', 'a');
      expect(store.chain('s1').disabled).toEqual([]);

      store.remove('s1', 'a');
      expect(store.chain('s1')).toEqual({ order: ['b'], disabled: [], active: ['b'] });
    });

    it('add is idempotent and toggle/remove of an absent id is a no-op', () => {
      const { store } = mount();
      store.add('s1', 'a');
      store.add('s1', 'a');
      expect(store.chain('s1').order).toEqual(['a']);

      store.toggle('s1', 'missing');
      store.remove('s1', 'missing');
      expect(store.chain('s1')).toEqual({ order: ['a'], disabled: [], active: ['a'] });
    });

    it('sessions are independent', () => {
      const { store } = mount();
      store.add('s1', 'a');
      store.add('s2', 'b');
      expect(store.chain('s1').order).toEqual(['a']);
      expect(store.chain('s2').order).toEqual(['b']);
    });

    it('reorder clamps out-of-range indices instead of throwing', () => {
      const { store } = mount();
      store.add('s1', 'a');
      store.add('s1', 'b');
      store.add('s1', 'c');
      store.reorder('s1', -5, 500); // clamps to (0, 2)
      expect(store.chain('s1').order).toEqual(['b', 'c', 'a']);
    });

    it('reorder is a no-op once clamping makes from === to', () => {
      const { store } = mount();
      store.add('s1', 'only');
      store.reorder('s1', 0, 99); // both clamp to index 0
      expect(store.chain('s1').order).toEqual(['only']);
    });

    it('reorder on an empty chain is a no-op', () => {
      const { store } = mount();
      store.reorder('s1', 0, 3);
      expect(store.chain('s1').order).toEqual([]);
    });

    it('resetToDefault restores the shared template', async () => {
      localStorage.setItem('logtapper_pipeline_chain', JSON.stringify(['p1']));
      localStorage.setItem('logtapper_pipeline_disabled', JSON.stringify([]));
      const { store } = mount({ listProcessors: vi.fn(async () => [processor('p1')]) });
      await tick();

      store.add('s1', 'p1');
      store.toggle('s1', 'p1');
      store.add('s1', 'extra');
      expect(store.chain('s1').order).toEqual(['p1', 'extra']);

      store.resetToDefault('s1');
      expect(store.chain('s1')).toEqual({ order: ['p1'], disabled: [], active: ['p1'] });
    });
  });

  // ── Default template round-trip ──────────────────────────────────────────

  describe('default template', () => {
    it('round-trips through the shared React storage keys, filtered to installed ids', async () => {
      localStorage.setItem('logtapper_pipeline_chain', JSON.stringify(['p1', 'p2', 'ghost']));
      localStorage.setItem('logtapper_pipeline_disabled', JSON.stringify(['p2']));
      const { store } = mount({
        listProcessors: vi.fn(async () => [processor('p1'), processor('p2'), processor('p3')]),
      });
      await tick();

      // 'ghost' is not installed, so it never enters the template; a session
      // with no chain of its own reads straight through to it.
      expect(store.chain('brand-new-session')).toEqual({
        order: ['p1', 'p2'],
        disabled: ['p2'],
        active: ['p1'],
      });
      expect(store.pipelineChainProvider()).toEqual({ chain: ['p1', 'p2'], disabledIds: ['p2'] });
    });

    it('a later refreshCatalog does not re-seed the template even if localStorage moves on', async () => {
      localStorage.setItem('logtapper_pipeline_chain', JSON.stringify(['p1']));
      const { store, commands } = mount({ listProcessors: vi.fn(async () => [processor('p1')]) });
      await tick();
      expect(store.pipelineChainProvider().chain).toEqual(['p1']);

      // Simulate localStorage moving on (e.g. the React app changed it, or an
      // install ran) — a second refreshCatalog must not pull this in and
      // silently reset every un-forked session's effective chain.
      localStorage.setItem('logtapper_pipeline_chain', JSON.stringify(['p2']));
      (commands.listProcessors as ReturnType<typeof vi.fn>).mockResolvedValue([processor('p1'), processor('p2')]);
      await store.refreshCatalog();

      expect(store.pipelineChainProvider().chain).toEqual(['p1']);
    });
  });

  // ── Catalog helpers ──────────────────────────────────────────────────────

  describe('catalog helpers', () => {
    it('byId, groups and trackers read the fetched catalog', async () => {
      const tracker = processor('t1', { processorType: 'state_tracker' });
      const reporter = processor('r1', { processorType: 'reporter' });
      const { store } = mount({
        listProcessors: vi.fn(async () => [tracker, reporter]),
        listPacks: vi.fn(async () => [pack('pack1', ['t1'])]),
      });
      await tick();

      expect(store.byId('t1')).toBe(tracker);
      expect(store.byId('missing')).toBeUndefined();

      const { packGroups, standaloneProcessors } = store.groups();
      expect(packGroups).toHaveLength(1);
      expect(packGroups[0].processors).toEqual([tracker]);
      expect(standaloneProcessors).toEqual([reporter]);

      store.add('s1', 't1');
      store.add('s1', 'r1');
      expect(store.trackers('s1')).toEqual([tracker]);
    });
  });

  // ── run() lifecycle ──────────────────────────────────────────────────────

  describe('run()', () => {
    it('pushes setSessionPipelineMeta before runPipeline, with the session\'s active/disabled sets', async () => {
      const order: string[] = [];
      const { store, commands } = mount({
        setSessionPipelineMeta: vi.fn(async () => {
          order.push('meta');
        }),
        runPipeline: vi.fn(async (sessionId: string) => {
          order.push('run');
          return runResult(sessionId);
        }),
      });
      store.add('s1', 'a');
      store.add('s1', 'b');
      store.toggle('s1', 'b');

      await store.run('s1');

      expect(order).toEqual(['meta', 'run']);
      expect(commands.setSessionPipelineMeta).toHaveBeenCalledWith('s1', ['a'], ['b']);
      expect(commands.runPipeline).toHaveBeenCalledWith('s1', null);
    });

    it('sets running/result on resolve and clears them appropriately', async () => {
      const result = runResult('s1', [summary('a', { matchedLines: 3 })]);
      const { store } = mount({ runPipeline: vi.fn(async () => result) });
      const p = store.run('s1');
      expect(store.running('s1')).toBe(true);
      await p;
      expect(store.running('s1')).toBe(false);
      // A store-store value comes back through a solid-js/store proxy, not the
      // literal reference `runPipeline` resolved with — compare by value.
      expect(store.result('s1')).toEqual(result);
      expect(store.lastError('s1')).toBeNull();
      expect(store.lastRunAt('s1')).not.toBeNull();
    });

    it('sets lastError on rejection and clears running', async () => {
      const { store } = mount({ runPipeline: vi.fn(async () => { throw new Error('boom'); }) });
      await store.run('s1');
      expect(store.running('s1')).toBe(false);
      expect(store.lastError('s1')).toContain('boom');
      expect(store.result('s1')).toBeNull();
    });

    it('treats "no pipeline chain configured" as a silent no-op, not an error', async () => {
      const { store } = mount({
        runPipeline: vi.fn(async () => { throw new Error('no pipeline chain configured for session s1'); }),
      });
      await store.run('s1');
      expect(store.running('s1')).toBe(false);
      expect(store.lastError('s1')).toBeNull();
    });

    it('a stale run\'s late resolution does not overwrite a newer run\'s result', async () => {
      const first = deferred<PipelineRunResult>();
      const second = deferred<PipelineRunResult>();
      let call = 0;
      const { store } = mount({
        runPipeline: vi.fn(() => (++call === 1 ? first.promise : second.promise)),
      });

      const p1 = store.run('s1');
      const p2 = store.run('s1'); // supersedes the first before it settles

      second.resolve(runResult('s1', [summary('newer')]));
      await p2;
      expect(store.result('s1')?.summaries[0].processorId).toBe('newer');

      first.resolve(runResult('s1', [summary('stale')]));
      await p1;
      // The late, superseded resolution must not have clobbered the newer state.
      expect(store.result('s1')?.summaries[0].processorId).toBe('newer');
      expect(store.running('s1')).toBe(false);
    });

    it('a stale run\'s late rejection does not overwrite a newer run\'s error state', async () => {
      const first = deferred<PipelineRunResult>();
      const second = deferred<PipelineRunResult>();
      let call = 0;
      const { store } = mount({
        runPipeline: vi.fn(() => (++call === 1 ? first.promise : second.promise)),
      });

      const p1 = store.run('s1');
      const p2 = store.run('s1');
      second.resolve(runResult('s1', [summary('newer')]));
      await p2;

      first.reject(new Error('late failure'));
      await p1;
      expect(store.lastError('s1')).toBeNull();
      expect(store.result('s1')?.summaries[0].processorId).toBe('newer');
    });
  });

  describe('stop()', () => {
    it('calls stopPipeline and clears running', async () => {
      const { store, commands } = mount({ runPipeline: vi.fn(() => new Promise<PipelineRunResult>(() => {})) });
      void store.run('s1');
      expect(store.running('s1')).toBe(true);
      await store.stop('s1');
      expect(commands.stopPipeline).toHaveBeenCalledTimes(1);
      expect(store.running('s1')).toBe(false);
    });

    it('still clears running when stopPipeline rejects', async () => {
      const { store } = mount({ stopPipeline: vi.fn(async () => { throw new Error('no'); }) });
      await expect(store.stop('s1')).rejects.toThrow('no');
      expect(store.running('s1')).toBe(false);
    });
  });

  // ── Progress guard ───────────────────────────────────────────────────────

  describe('progress', () => {
    function progressPayload(sessionId: string, processorId: string, percent = 50): PipelineProgress {
      return { sessionId, processorId, linesProcessed: 5, totalLines: 10, percent };
    }

    it('accepts an update for a session mid-run', async () => {
      const { store, fireProgress } = mount({ runPipeline: vi.fn(() => new Promise<PipelineRunResult>(() => {})) });
      void store.run('s1');
      fireProgress(progressPayload('s1', 'a', 42));
      expect(store.progress('s1').get('a')).toEqual({ processorId: 'a', linesProcessed: 5, totalLines: 10, percent: 42 });
    });

    it('ignores an update for a session this store never started running', () => {
      const { store, fireProgress } = mount();
      fireProgress(progressPayload('other-session', 'a'));
      expect(store.progress('other-session').size).toBe(0);
    });

    it('ignores an update once the run has already settled', async () => {
      const { store, fireProgress } = mount({ runPipeline: vi.fn(async () => runResult('s1')) });
      await store.run('s1');
      fireProgress(progressPayload('s1', 'a'));
      expect(store.progress('s1').size).toBe(0);
    });

    it('starting a new run clears the previous run\'s progress', async () => {
      const { store, fireProgress } = mount({ runPipeline: vi.fn(() => new Promise<PipelineRunResult>(() => {})) });
      void store.run('s1');
      fireProgress(progressPayload('s1', 'a'));
      expect(store.progress('s1').size).toBe(1);

      void store.run('s1');
      expect(store.progress('s1').size).toBe(0);
    });
  });

  // ── Result helpers ───────────────────────────────────────────────────────

  describe('result helpers', () => {
    it('summaryFor reads the last result', async () => {
      const { store } = mount({ runPipeline: vi.fn(async (sid: string) => runResult(sid, [summary('a', { matchedLines: 7 })])) });
      await store.run('s1');
      expect(store.summaryFor('s1', 'a')?.matchedLines).toBe(7);
      expect(store.summaryFor('s1', 'missing')).toBeUndefined();
    });

    it('matchedLines and correlatorEvents cache within a run generation and invalidate on the next one', async () => {
      const { store, commands } = mount({ runPipeline: vi.fn(async (sid: string) => runResult(sid)) });
      await store.run('s1');

      await store.matchedLines('s1', 'a');
      await store.matchedLines('s1', 'a');
      expect(commands.getMatchedLines).toHaveBeenCalledTimes(1);

      await store.correlatorEvents('s1', 'c1');
      await store.correlatorEvents('s1', 'c1');
      expect(commands.getCorrelatorEvents).toHaveBeenCalledTimes(1);

      await store.run('s1'); // bumps the generation
      await store.matchedLines('s1', 'a');
      expect(commands.getMatchedLines).toHaveBeenCalledTimes(2);
    });

    it('vars is a direct, uncached passthrough', async () => {
      const { store, commands } = mount();
      (commands.getProcessorVars as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      await expect(store.vars('s1', 'a')).resolves.toEqual({ count: 1 });
      await store.vars('s1', 'a');
      expect(commands.getProcessorVars).toHaveBeenCalledTimes(2);
    });

    it('showMatched sets the filter line set and scrolls to the first match', async () => {
      const lines: MatchedLine[] = [
        { lineNum: 20, raw: 'b' },
        { lineNum: 5, raw: 'a' },
      ];
      const { store, controller } = mount({ getMatchedLines: vi.fn(async () => lines) });
      await store.showMatched('s1', 'a');
      expect(controller.setLineSet).toHaveBeenCalledWith('s1', 'filter', new Set([5, 20]));
      expect(controller.scrollToLine).toHaveBeenCalledWith('s1', 5, { source: 'user' });
    });

    it('showMatched with no matches sets an empty filter and does not scroll', async () => {
      const { store, controller } = mount({ getMatchedLines: vi.fn(async () => []) });
      await store.showMatched('s1', 'a');
      expect(controller.setLineSet).toHaveBeenCalledWith('s1', 'filter', new Set());
      expect(controller.scrollToLine).not.toHaveBeenCalled();
    });

    it('clearMatched clears the filter line set', () => {
      const { store, controller } = mount();
      store.clearMatched('s1');
      expect(controller.setLineSet).toHaveBeenCalledWith('s1', 'filter', null);
    });
  });

  // ── Install flow ─────────────────────────────────────────────────────────

  describe('install flow', () => {
    it('installFromFile loads the chosen path then refreshes the catalog', async () => {
      const installed = processor('new-one');
      const { store, commands, chooseFile } = mount({
        loadProcessorFromFile: vi.fn(async () => installed),
        listProcessors: vi.fn(async () => [installed]),
      });
      chooseFile.mockResolvedValue('C:/procs/new-one.yaml');

      await store.installFromFile();

      expect(commands.loadProcessorFromFile).toHaveBeenCalledWith('C:/procs/new-one.yaml');
      expect(store.byId('new-one')).toEqual(installed);
    });

    it('installFromFile is a no-op when the dialog is cancelled', async () => {
      const { store, commands, chooseFile } = mount();
      chooseFile.mockResolvedValue(null);
      await store.installFromFile();
      expect(commands.loadProcessorFromFile).not.toHaveBeenCalled();
    });

    it('uninstall removes the id from every session\'s chain and the default template first', async () => {
      localStorage.setItem('logtapper_pipeline_chain', JSON.stringify(['p1']));
      const { store, commands } = mount({ listProcessors: vi.fn(async () => [processor('p1'), processor('p2')]) });
      await tick();

      store.add('s1', 'p1');
      store.add('s2', 'p1');
      store.add('s2', 'p2');

      (commands.listProcessors as ReturnType<typeof vi.fn>).mockResolvedValue([processor('p2')]);
      await store.uninstall('p1');

      expect(commands.uninstallProcessor).toHaveBeenCalledWith('p1');
      expect(store.chain('s1').order).toEqual([]);
      expect(store.chain('s2').order).toEqual(['p2']);
      expect(store.chain('brand-new').order).toEqual([]); // default template lost p1 too
    });
  });

  // ── Workspace chain provider / restore ───────────────────────────────────

  describe('workspace chain provider and restore', () => {
    it('applyWorkspaceChain with a sessionId sets only that session and pushes meta', () => {
      const { store, commands } = mount();
      store.applyWorkspaceChain({ chain: ['a', 'b'], disabledChainIds: ['b'] }, 's1');
      expect(store.chain('s1')).toEqual({ order: ['a', 'b'], disabled: ['b'], active: ['a'] });
      expect(commands.setSessionPipelineMeta).toHaveBeenCalledWith('s1', ['a'], ['b']);
    });

    it('applyWorkspaceChain with no sessionId back-fills sessions with no chain of their own', () => {
      const { store, setOrder } = mount();
      setOrder(['A', 'B']);
      store.add('B', 'own-choice'); // B has already diverged

      store.applyWorkspaceChain({ chain: ['p1', 'p2'], disabledChainIds: ['p2'] });

      expect(store.chain('A')).toEqual({ order: ['p1', 'p2'], disabled: ['p2'], active: ['p1'] });
      expect(store.chain('B').order).toEqual(['own-choice']); // untouched
      expect(store.pipelineChainProvider()).toEqual({ chain: ['p1', 'p2'], disabledIds: ['p2'] });
    });
  });

  // ── Session cleanup ──────────────────────────────────────────────────────

  it('prunes chain and run state once a session leaves sessions.order()', async () => {
    const { store, setOrder, commands } = mount({ runPipeline: vi.fn(async (sid: string) => runResult(sid)) });
    setOrder(['s1']);
    store.add('s1', 'a');
    await store.run('s1');
    await store.matchedLines('s1', 'a');

    setOrder([]);
    await tick();

    // The session no longer has its own chain, so it reads through to the
    // (still empty) default template rather than remembering 'a'.
    expect(store.chain('s1').order).toEqual([]);
    expect(store.result('s1')).toBeNull();

    // And the matched-lines cache for it was dropped, not just the chain/run
    // state — reopening the same id and re-running must hit the backend again
    // rather than resolve the old (deleted) cache's stale promise, which would
    // coincidentally carry the same generation number (both start at 1).
    setOrder(['s1']);
    await tick();
    await store.run('s1');
    await store.matchedLines('s1', 'a');
    expect(commands.getMatchedLines).toHaveBeenCalledTimes(2);
  });

  // ── Live counters (L3) ───────────────────────────────────────────────────

  describe('mergeProcessorResult (pure)', () => {
    it('appends a new entry for a processor with no prior summary', () => {
      const out = mergeProcessorResult([], 'p1', 5, 2);
      expect(out).toEqual([{ processorId: 'p1', matchedLines: 5, emissionCount: 2, scriptErrors: 0, scannedFrom: 0 }]);
    });

    it('replaces the existing entry for the same processor, dropping any skipped flag', () => {
      const existing = [
        summary('p1', { matchedLines: 1, skipped: { reason: 'source_type_mismatch', declared: ['Bugreport'], actual: 'Logcat' } }),
        summary('p2', { matchedLines: 9 }),
      ];
      const out = mergeProcessorResult(existing, 'p1', 10, 3);
      expect(out).toEqual([
        { processorId: 'p1', matchedLines: 10, emissionCount: 3, scriptErrors: 0, scannedFrom: 0 },
        summary('p2', { matchedLines: 9 }),
      ]);
    });
  });

  describe('applyExcludedProcessors (pure)', () => {
    function skip(actual = 'Logcat'): { reason: string; declared: string[]; actual: string } {
      return { reason: 'source_type_mismatch', declared: ['Bugreport'], actual };
    }

    it('creates a zero-count skipped entry for a processor with no prior summary', () => {
      const out = applyExcludedProcessors([], [{ processorId: 'p1', skip: skip() }]);
      expect(out).toEqual([{ processorId: 'p1', matchedLines: 0, emissionCount: 0, scriptErrors: 0, scannedFrom: 0, skipped: skip() }]);
    });

    it('marks an existing entry skipped without discarding its counts', () => {
      const out = applyExcludedProcessors([summary('p1', { matchedLines: 4 })], [{ processorId: 'p1', skip: skip() }]);
      expect(out).toEqual([summary('p1', { matchedLines: 4, skipped: skip() })]);
    });

    it('clears a stale exclusion once the processor is no longer in the excluded set', () => {
      const out = applyExcludedProcessors([summary('p1', { skipped: skip() })], []);
      expect(out).toEqual([summary('p1', { skipped: undefined })]);
    });

    it('never clears a skip reason this mechanism did not set', () => {
      const otherReason = { reason: 'source_type_filter_excluded', declared: ['Bugreport'], actual: 'Logcat' };
      const out = applyExcludedProcessors([summary('p1', { skipped: otherReason })], []);
      expect(out).toEqual([summary('p1', { skipped: otherReason })]);
    });
  });

  describe('applyProcessorUpdates / applyProcessorsExcluded (store methods)', () => {
    it('folds live counters into summaryFor with no prior run, and keeps updating them', async () => {
      const { store } = mount();
      expect(store.summaryFor('s1', 'p1')).toBeUndefined();

      store.applyProcessorUpdates('s1', [{ sessionId: 's1', processorId: 'p1', matchedLines: 1, emissionCount: 0 }]);
      expect(store.summaryFor('s1', 'p1')?.matchedLines).toBe(1);

      store.applyProcessorUpdates('s1', [{ sessionId: 's1', processorId: 'p1', matchedLines: 4, emissionCount: 1 }]);
      expect(store.summaryFor('s1', 'p1')?.matchedLines).toBe(4);
    });

    it('is a no-op for an empty updates array', async () => {
      const { store } = mount();
      store.applyProcessorUpdates('s1', []);
      expect(store.result('s1')).toBeNull();
    });

    it('folds an exclusion set into summaryFor, reachable by AnalyzerCard as `skipped`', async () => {
      const { store } = mount();
      store.applyProcessorsExcluded('s1', [
        { processorId: 'p1', skip: { reason: 'source_type_mismatch', declared: ['Bugreport'], actual: 'Logcat' } },
      ]);
      expect(store.summaryFor('s1', 'p1')?.skipped?.actual).toBe('Logcat');
    });

    it('preserves a prior file-mode run result while layering live updates on top', async () => {
      const { store } = mount({
        runPipeline: vi.fn(async (sessionId: string) => runResult(sessionId, [summary('p1', { matchedLines: 2 })])),
      });
      await store.run('s1');
      expect(store.result('s1')?.effectiveProcessorIds).toEqual(['p1']);

      store.applyProcessorUpdates('s1', [{ sessionId: 's1', processorId: 'p1', matchedLines: 7, emissionCount: 0 }]);
      expect(store.result('s1')?.effectiveProcessorIds).toEqual(['p1']);
      expect(store.summaryFor('s1', 'p1')?.matchedLines).toBe(7);
    });
  });

  // ── Disposal ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('unlistens the progress subscription and ignores further events', async () => {
      const { store, unlisten, fireProgress } = mount({ runPipeline: vi.fn(() => new Promise<PipelineRunResult>(() => {})) });
      void store.run('s1');
      await tick();
      store.dispose();
      expect(unlisten).toHaveBeenCalledTimes(1);
      expect(() => fireProgress({ sessionId: 's1', processorId: 'a', linesProcessed: 1, totalLines: 2, percent: 50 })).not.toThrow();
      expect(store.progress('s1').size).toBe(0);
    });

    it('is idempotent', async () => {
      const { store, unlisten } = mount();
      await tick(); // let the listen() promise settle and attach the unlisten fn
      store.dispose();
      store.dispose();
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it('unlistens even when the listen() promise settles after dispose', async () => {
      let resolveListen!: (fn: () => void) => void;
      const late = new Promise<() => void>((res) => { resolveListen = res; });
      const lateUnlisten = vi.fn();
      const store = createAnalyzerStore({
        sessions: { order: () => [] },
        controller: { setLineSet: vi.fn(), scrollToLine: vi.fn() },
        listen: () => late,
        commands: makeCommands(),
      });
      store.dispose();
      resolveListen(lateUnlisten);
      await tick();
      expect(lateUnlisten).toHaveBeenCalledTimes(1);
    });
  });
});
