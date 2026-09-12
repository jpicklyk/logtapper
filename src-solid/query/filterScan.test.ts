import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type {
  FilterCreateResult,
  FilterCriteria,
  FilteredLinesResult,
  LinePage,
  LineRequest,
  ViewLine,
} from '@bridge/types';
import { FilterScan } from './filterScan';
import type { FilterScanCommands } from './filterScan';

// ── Fakes ──────────────────────────────────────────────────────────────────

type Progress = { filterId: string; matchedSoFar: number; linesScanned: number; totalLines: number; done: boolean };

/** A fake `onFilterProgress` the test drives by hand. */
function createFakeListen() {
  const subscribers: Array<(p: Progress) => void> = [];
  let registrations = 0;
  let unlistens = 0;
  const listen = (cb: (p: Progress) => void): Promise<UnlistenFn> => {
    registrations++;
    subscribers.push(cb);
    return Promise.resolve((() => {
      unlistens++;
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    }) as UnlistenFn);
  };
  return {
    listen: listen as never,
    emit: (p: Partial<Progress> & { filterId: string }) => {
      const full: Progress = { matchedSoFar: 0, linesScanned: 0, totalLines: 0, done: false, ...p };
      for (const cb of [...subscribers]) cb(full);
    },
    get registrations() { return registrations; },
    get unlistens() { return unlistens; },
    get active() { return subscribers.length; },
  };
}

function viewLine(lineNum: number, over: Partial<ViewLine> = {}): ViewLine {
  return {
    lineNum,
    virtualIndex: lineNum,
    raw: `line ${lineNum}`,
    level: 'Error',
    tag: 'Alpha',
    message: `line ${lineNum}`,
    timestamp: lineNum,
    pid: 100,
    tid: 200,
    sourceId: 's1',
    highlights: [],
    matchedBy: [],
    isContext: false,
    ...over,
  };
}

interface FakeCommandOptions {
  /** Lines the backend filter "found", in match order. */
  backendMatches?: ViewLine[];
  /** Every line the source holds, for the `getLines` fallback path. */
  allLines?: ViewLine[];
  createRejects?: Error;
  totalLines?: number;
  /** Resolve `getFilteredLines` manually so the test controls in-flight overlap. */
  deferPages?: boolean;
}

function createFakeCommands(opts: FakeCommandOptions = {}) {
  const log: string[] = [];
  const createdCriteria: FilterCriteria[] = [];
  const pageCalls: Array<{ offset: number; count: number }> = [];
  const lineCalls: LineRequest[] = [];
  const pending: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let filterSeq = 0;

  const commands: FilterScanCommands = {
    createFilter: async (sessionId: string, criteria: FilterCriteria): Promise<FilterCreateResult> => {
      log.push('createFilter');
      createdCriteria.push(criteria);
      if (opts.createRejects) throw opts.createRejects;
      return { filterId: `f${++filterSeq}`, sessionId, totalLines: opts.totalLines ?? 1000 };
    },
    getFilteredLines: async (filterId: string, offset: number, count: number): Promise<FilteredLinesResult> => {
      log.push(`getFilteredLines(${offset},${count})`);
      pageCalls.push({ offset, count });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (opts.deferPages) await new Promise<void>((resolve) => pending.push(resolve));
      inFlight--;
      const all = opts.backendMatches ?? [];
      return {
        filterId,
        totalMatches: all.length,
        lines: all.slice(offset, offset + count),
      } as FilteredLinesResult;
    },
    cancelFilter: async (filterId: string) => { log.push(`cancelFilter(${filterId})`); },
    closeFilter: async (filterId: string) => { log.push(`closeFilter(${filterId})`); },
    getLines: async (request: LineRequest): Promise<LinePage> => {
      log.push(`getLines(${request.offset},${request.count})`);
      lineCalls.push(request);
      const all = opts.allLines ?? [];
      return {
        sessionId: request.sessionId,
        totalLines: all.length,
        offset: request.offset,
        count: request.count,
        truncated: false,
        lines: all.slice(request.offset, request.offset + request.count),
      };
    },
  };

  return {
    commands,
    log,
    createdCriteria,
    pageCalls,
    lineCalls,
    get maxInFlight() { return maxInFlight; },
    /** Release one deferred `getFilteredLines`. */
    releaseOne: () => pending.shift()?.(),
    releaseAll: () => { while (pending.length) pending.shift()?.(); },
    get pendingPages() { return pending.length; },
  };
}

/** Let every already-queued microtask (the serialized handler chain) settle. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('FilterScan', () => {
  let scans: FilterScan[] = [];
  const make = (deps: ConstructorParameters<typeof FilterScan>[0]) => {
    const s = new FilterScan(deps);
    scans.push(s);
    return s;
  };

  beforeEach(() => { scans = []; });
  afterEach(() => { for (const s of scans) s.dispose(); });

  it('runs the happy path: pages applied in order, filter closed on done', async () => {
    const matches = [10, 20, 30, 40].map((n) => viewLine(n));
    const fake = createFakeCommands({ backendMatches: matches });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E');
    expect(scan.phase()).toBe('scanning');
    expect(scan.total()).toBe(1000);

    listener.emit({ filterId: 'f1', matchedSoFar: 2 });
    await settle();
    expect([...scan.lines()!]).toEqual([10, 20]);
    expect(scan.matched()).toBe(2);

    listener.emit({ filterId: 'f1', matchedSoFar: 4, done: true });
    await settle();

    expect([...scan.lines()!]).toEqual([10, 20, 30, 40]);
    expect(scan.matched()).toBe(4);
    expect(scan.phase()).toBe('done');
    // Pages were requested contiguously, in order, with no gaps or overlap.
    expect(fake.pageCalls).toEqual([{ offset: 0, count: 2 }, { offset: 2, count: 2 }]);
    expect(fake.log).toContain('closeFilter(f1)');
    expect(fake.log).not.toContain('cancelFilter(f1)');
    // `done` released the progress listener.
    expect(listener.active).toBe(0);
  });

  it('never has two getFilteredLines in flight, even when progress events burst', async () => {
    const matches = Array.from({ length: 12 }, (_, i) => viewLine(i));
    const fake = createFakeCommands({ backendMatches: matches, deferPages: true });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E');

    // Five events back to back, with the first page still unresolved.
    for (const n of [2, 4, 6, 8, 10]) listener.emit({ filterId: 'f1', matchedSoFar: n });
    await settle();
    expect(fake.pendingPages).toBe(1);
    expect(fake.maxInFlight).toBe(1);

    // Drain the chain one page at a time; each release lets exactly one more start.
    for (let i = 0; i < 5; i++) {
      fake.releaseAll();
      await settle();
      expect(fake.maxInFlight).toBe(1);
    }

    // Each run read the committed `lastFetched`, so the windows tile exactly.
    expect(fake.pageCalls).toEqual([
      { offset: 0, count: 2 }, { offset: 2, count: 2 }, { offset: 4, count: 2 },
      { offset: 6, count: 2 }, { offset: 8, count: 2 },
    ]);
    expect([...scan.lines()!]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('cancel mid-scan bumps the generation: late events ignored, filter cancelled and closed once', async () => {
    const fake = createFakeCommands({ backendMatches: [viewLine(1), viewLine(2)] });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E');
    listener.emit({ filterId: 'f1', matchedSoFar: 1 });
    await settle();
    expect(scan.matched()).toBe(1);

    scan.cancel();
    expect(scan.phase()).toBe('idle');
    expect(scan.lines()).toBeNull();
    expect(fake.log.filter((c) => c === 'cancelFilter(f1)')).toHaveLength(1);
    expect(fake.log.filter((c) => c === 'closeFilter(f1)')).toHaveLength(1);
    expect(listener.active).toBe(0);

    // A late progress event for the dead scan must not resurrect any state.
    const pagesBefore = fake.pageCalls.length;
    listener.emit({ filterId: 'f1', matchedSoFar: 2, done: true });
    await settle();
    expect(fake.pageCalls.length).toBe(pagesBefore);
    expect(scan.lines()).toBeNull();
    expect(scan.phase()).toBe('idle');
  });

  it('a superseding expression drops the old scan and keeps only the new one', async () => {
    const fake = createFakeCommands({ backendMatches: [viewLine(7), viewLine(8)] });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E');
    listener.emit({ filterId: 'f1', matchedSoFar: 1 });
    await settle();

    await scan.setExpression('s1', 'level:W');
    expect(fake.log).toContain('cancelFilter(f1)');
    expect(fake.log).toContain('closeFilter(f1)');
    // Only the new listener is registered.
    expect(listener.active).toBe(1);

    // The superseded filter's late `done` must not close the new one or flip phase.
    listener.emit({ filterId: 'f1', matchedSoFar: 2, done: true });
    await settle();
    expect(scan.phase()).toBe('scanning');

    listener.emit({ filterId: 'f2', matchedSoFar: 2, done: true });
    await settle();
    expect(scan.phase()).toBe('done');
    expect([...scan.lines()!]).toEqual([7, 8]);
    expect(fake.log.filter((c) => c === 'closeFilter(f2)')).toHaveLength(1);
  });

  it('runs the needsJsPass second pass and narrows the backend candidate set', async () => {
    // `level:E tag:Alpha` extracts to logLevels+tags — exact, no JS pass. Use a
    // free-text atom instead, which is a raw-line superset the JS pass narrows.
    const candidates = [
      viewLine(1, { raw: 'boom here', message: 'boom here', tag: 'Alpha' }),
      viewLine(2, { raw: 'boom elsewhere', message: 'boom elsewhere', tag: 'Beta' }),
      viewLine(3, { raw: 'boom again', message: 'boom again', tag: 'Alpha' }),
    ];
    const fake = createFakeCommands({ backendMatches: candidates });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'boom tag:Alpha');
    // The extracted criteria is the AND of the two — but the text atom makes it
    // a superset, so the pass must run.
    expect(fake.createdCriteria[0].textSearch).toBe('boom');
    expect(fake.createdCriteria[0].tags).toEqual(['Alpha']);

    listener.emit({ filterId: 'f1', matchedSoFar: 3, done: true });
    await settle();

    // Line 2's tag is Beta — the backend returned it, JS dropped it.
    expect([...scan.lines()!]).toEqual([1, 3]);
    expect(scan.matched()).toBe(2);
  });

  it('falls back to getLines windows for an expression the backend cannot reduce', async () => {
    const all = [
      viewLine(0, { tid: 7 }),
      viewLine(1, { tid: 9 }),
      viewLine(2, { tid: 7 }),
      viewLine(3, { tid: 9 }),
      viewLine(4, { tid: 7 }),
    ];
    const fake = createFakeCommands({ allLines: all });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen, pageSize: 2 });

    await scan.setExpression('s1', 'tid:7');

    expect(fake.log).not.toContain('createFilter');
    expect(listener.registrations).toBe(0);
    // Windows of pageSize, walking the whole source.
    expect(fake.lineCalls.map((r) => r.offset)).toEqual([0, 2, 4]);
    expect(fake.lineCalls[0].mode).toEqual({ mode: 'Full' });
    expect(fake.lineCalls[0].count).toBe(2);
    expect([...scan.lines()!]).toEqual([0, 2, 4]);
    expect(scan.total()).toBe(5);
    expect(scan.phase()).toBe('done');
  });

  it('surfaces a createFilter rejection as an error phase with the message', async () => {
    const fake = createFakeCommands({ createRejects: new Error('invalid regex: unclosed group') });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E');

    expect(scan.phase()).toBe('error');
    expect(scan.error()).toBe('invalid regex: unclosed group');
    expect(scan.lines()).toBeNull();
    expect(scan.matched()).toBe(0);
    expect(listener.registrations).toBe(0);
  });

  it('surfaces a parse error separately from a backend error', async () => {
    const fake = createFakeCommands();
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E (unclosed');

    expect(scan.phase()).toBe('error');
    expect(scan.parseError()).toMatch(/closing/i);
    expect(scan.error()).toBeNull();
    expect(scan.lines()).toBeNull();
    expect(fake.log).not.toContain('createFilter');
  });

  it('clears everything on an empty expression and closes a live filter', async () => {
    const fake = createFakeCommands({ backendMatches: [viewLine(5)] });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E');
    listener.emit({ filterId: 'f1', matchedSoFar: 1 });
    await settle();
    expect(scan.lines()).not.toBeNull();

    await scan.setExpression('s1', '   ');
    expect(scan.lines()).toBeNull();
    expect(scan.matched()).toBe(0);
    expect(scan.total()).toBe(0);
    expect(scan.phase()).toBe('idle');
    expect(scan.parseError()).toBeNull();
    expect(fake.log).toContain('closeFilter(f1)');
    expect(listener.active).toBe(0);

    // `null` takes the same fast path and starts no scan.
    const before = fake.log.length;
    await scan.setExpression('s1', null);
    expect(fake.log.length).toBe(before);
    expect(scan.phase()).toBe('idle');
  });

  it('dispose cancels a live scan and is idempotent', async () => {
    const fake = createFakeCommands({ backendMatches: [viewLine(1)] });
    const listener = createFakeListen();
    const scan = new FilterScan({ commands: fake.commands, listen: listener.listen });

    await scan.setExpression('s1', 'level:E');
    scan.dispose();

    expect(fake.log).toContain('cancelFilter(f1)');
    expect(fake.log).toContain('closeFilter(f1)');
    expect(listener.active).toBe(0);

    const after = fake.log.length;
    scan.dispose();
    expect(fake.log.length).toBe(after);

    // Late events after dispose are inert.
    listener.emit({ filterId: 'f1', matchedSoFar: 1, done: true });
    await settle();
    expect(fake.pageCalls).toHaveLength(0);
  });

  it('aborts the fallback scan when a newer expression supersedes it', async () => {
    const all = Array.from({ length: 6 }, (_, i) => viewLine(i, { tid: 7 }));
    const fake = createFakeCommands({ allLines: all });
    const listener = createFakeListen();
    const scan = make({ commands: fake.commands, listen: listener.listen, pageSize: 2 });

    const first = scan.setExpression('s1', 'tid:7');
    // Supersede before the first window's promise resolves.
    scan.cancel();
    await first;

    // The loop saw the generation bump and stopped without publishing.
    expect(scan.lines()).toBeNull();
    expect(scan.phase()).toBe('idle');
    expect(fake.lineCalls.length).toBeLessThanOrEqual(1);
  });

  it('resolves package names through the injected resolver, once per name', async () => {
    const all = [viewLine(0, { pid: 42 }), viewLine(1, { pid: 43 })];
    const fake = createFakeCommands({ allLines: all });
    const listener = createFakeListen();
    const resolve = vi.fn(async (names: string[]) => new Map(names.map((n) => [n, [42]])));
    const scan = make({ commands: fake.commands, listen: listener.listen, resolvePackagePids: resolve });

    await scan.setExpression('s1', 'package:com.example');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(['com.example']);
    expect([...scan.lines()!]).toEqual([0]);

    // Cached — a second scan for the same package does not re-resolve.
    await scan.setExpression('s1', 'package:com.example');
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
