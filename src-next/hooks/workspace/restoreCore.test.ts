import { describe, it, expect, vi, beforeEach } from 'vitest';

// restoreCore.ts pulls in bridge/commands, events, and workspacePersistence
// (which reaches components/EditorTab and eventually ThemeContext's
// module-load `window.matchMedia` — hazardous in this project's non-jsdom
// vitest environment, see restoreSourceType.test.ts). Mock every real
// dependency so only restoreCore's own control flow is under test.
const mockBusEmit = vi.fn();
const mockBusOn = vi.fn();
const mockBusOff = vi.fn();
vi.mock('../../events', () => ({
  bus: {
    emit: (...args: unknown[]) => mockBusEmit(...args),
    on: (...args: unknown[]) => mockBusOn(...args),
    off: (...args: unknown[]) => mockBusOff(...args),
  },
}));

const mockRestoreWorkspaceSession = vi.fn();
vi.mock('../../bridge/commands', () => ({
  restoreWorkspaceSession: (...args: unknown[]) => mockRestoreWorkspaceSession(...args),
}));

const mockPairArtifactsWithSessions = vi.fn();
vi.mock('./artifactPairing', () => ({
  pairArtifactsWithSessions: (...args: unknown[]) => mockPairArtifactsWithSessions(...args),
}));

const mockBuildEditorTabEvents = vi.fn();
vi.mock('./workspacePersistence', () => ({
  buildEditorTabEvents: (...args: unknown[]) => mockBuildEditorTabEvents(...args),
}));

const mockBuildRestoreOutcomes = vi.fn();
const mockIsLts = vi.fn();
vi.mock('./restorePlan', () => ({
  buildRestoreOutcomes: (...args: unknown[]) => mockBuildRestoreOutcomes(...args),
  isLts: (...args: unknown[]) => mockIsLts(...args),
}));

import { restoreWorkspace, type RestoreIo, type RestoreResult } from './restoreCore';
import type { RestorePlan } from './restorePlan';
import { allPanes } from './splitTreeHelpers';
import type { SplitNode, Tab } from './workspaceTypes';

function makeIo(overrides?: Partial<RestoreIo>): RestoreIo & {
  calls: string[];
  setWorkspaceAnalysesArgs: unknown[][];
} {
  const calls: string[] = [];
  const setWorkspaceAnalysesArgs: unknown[][] = [];
  return {
    calls,
    setWorkspaceAnalysesArgs,
    loadFile: vi.fn(async (path: string) => { calls.push(`loadFile:${path}`); return []; }),
    scheduleAutoRun: vi.fn(),
    setWorkspaceAnalyses: vi.fn(async (analyses: unknown[]) => {
      calls.push('setWorkspaceAnalyses');
      setWorkspaceAnalysesArgs.push([analyses]);
    }),
    ...overrides,
  };
}

function makeResult(overrides?: Partial<RestoreResult>): RestoreResult {
  return {
    workspaceName: 'ws',
    filePath: '/ws.ltw',
    sessionData: [],
    editorTabs: [],
    layout: null,
    analyses: [],
    ...overrides,
  };
}

function makePlan(overrides?: Partial<RestorePlan>): RestorePlan {
  return {
    loads: [],
    applyLtwViewState: false,
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildRestoreOutcomes.mockReturnValue([]);
  mockPairArtifactsWithSessions.mockReturnValue({ pairs: [], warnings: [] });
  mockIsLts.mockReturnValue(false);
  mockBuildEditorTabEvents.mockReturnValue([]);
});

describe('restoreWorkspace — workspace analyses replacement', () => {
  it('replaces workspace analyses before loading any session', async () => {
    const analyses = [{ id: 'art-1' } as never];
    const io = makeIo();
    const plan = makePlan({ loads: [{ path: '/a.log', dataIndex: null }] });

    await restoreWorkspace(makeResult({ analyses }), plan, io);

    expect(io.calls).toEqual(['setWorkspaceAnalyses', 'loadFile:/a.log']);
    expect(io.setWorkspaceAnalysesArgs[0][0]).toBe(analyses);
  });

  it('passes an empty list through unchanged (localStorage-only restore correctly clears)', async () => {
    const io = makeIo();
    const plan = makePlan();

    await restoreWorkspace(makeResult({ analyses: [] }), plan, io);

    expect(io.setWorkspaceAnalyses).toHaveBeenCalledWith([]);
  });

  it('is called exactly once regardless of how many loads the plan has', async () => {
    const io = makeIo();
    const plan = makePlan({
      loads: [
        { path: '/a.log', dataIndex: null },
        { path: '/b.log', dataIndex: null },
      ],
    });

    await restoreWorkspace(makeResult(), plan, io);

    expect(io.setWorkspaceAnalyses).toHaveBeenCalledTimes(1);
  });

  it('a setWorkspaceAnalyses failure warns and does not abort the restore', async () => {
    const io = makeIo({
      setWorkspaceAnalyses: vi.fn(async () => { throw new Error('backend unreachable'); }),
    });
    const plan = makePlan({ loads: [{ path: '/a.log', dataIndex: null }] });

    const warnings = await restoreWorkspace(makeResult(), plan, io);

    // Restore continues: the load still runs and workspace:opened still fires.
    expect(io.loadFile).toHaveBeenCalledWith(
      '/a.log', undefined, undefined, undefined, undefined, expect.any(String),
    );
    expect(mockBusEmit).toHaveBeenCalledWith(
      'workspace:opened', expect.objectContaining({ name: 'ws' }),
    );
    expect(warnings.some((w) => w.includes('backend unreachable'))).toBe(true);
  });

  it('a setWorkspaceAnalyses failure does not drop pre-existing plan warnings', async () => {
    const io = makeIo({
      setWorkspaceAnalyses: vi.fn(async () => { throw new Error('boom'); }),
    });
    const plan = makePlan({ warnings: ['pre-existing planner warning'] });

    const warnings = await restoreWorkspace(makeResult(), plan, io);

    expect(warnings).toContain('pre-existing planner warning');
    expect(warnings.some((w) => w.includes('boom'))).toBe(true);
  });

  it('still emits workspace:restore-begin and workspace:restore-end around a failure', async () => {
    const io = makeIo({
      setWorkspaceAnalyses: vi.fn(async () => { throw new Error('boom'); }),
    });
    const plan = makePlan();

    await restoreWorkspace(makeResult(), plan, io);

    const events = mockBusEmit.mock.calls.map((c) => c[0]);
    expect(events).toContain('workspace:restore-begin');
    expect(events).toContain('workspace:restore-end');
    // begin must precede end
    expect(events.indexOf('workspace:restore-begin')).toBeLessThan(events.lastIndexOf('workspace:restore-end'));
  });
});

describe('restoreWorkspace — expected-session-id diagnostic (T8)', () => {
  /** An `io.loadFile` that produces a fixed session id per path, by RETURN
   *  VALUE — the mechanism `restoreWorkspace` now uses to learn what session
   *  id a load produced (no `session:loaded` event involved — see the
   *  "attribution by return value" describe block below for that guarantee
   *  under concurrency). */
  function makeIoProducing(pathToSessionId: Record<string, string>): RestoreIo {
    return {
      loadFile: vi.fn(async (path: string) => {
        const sessionId = pathToSessionId[path];
        return sessionId ? [sessionId] : [];
      }),
      scheduleAutoRun: vi.fn(),
      setWorkspaceAnalyses: vi.fn(async () => {}),
    };
  }

  /** A single-artifact, single-section analyses list with `count` references
   *  all pointing at `sessionId`. */
  function makeAnalysesReferencing(sessionId: string, count: number) {
    return [
      {
        id: 'art-1',
        title: 'Investigation',
        createdAt: 0,
        sections: [
          {
            heading: 'h',
            body: 'b',
            severity: null,
            references: Array.from({ length: count }, (_, i) => ({
              lineNumber: i,
              endLine: null,
              label: `ref-${i}`,
              highlightType: { type: 'Search' },
              sessionId,
            })),
          },
        ],
      },
    ] as never;
  }

  it('warns when the produced session id differs from the expected id', async () => {
    const io = makeIoProducing({ '/logs/a.log': 'f-new123' });
    const plan = makePlan({
      loads: [{ path: '/logs/a.log', dataIndex: null, expectedSessionId: 'f-old456' }],
    });

    const warnings = await restoreWorkspace(makeResult(), plan, io);

    expect(warnings.some((w) => w.startsWith('a.log changed since the workspace was saved'))).toBe(true);
  });

  it('is silent when the produced id matches the expected id', async () => {
    const io = makeIoProducing({ '/logs/a.log': 'f-same' });
    const plan = makePlan({
      loads: [{ path: '/logs/a.log', dataIndex: null, expectedSessionId: 'f-same' }],
    });

    const warnings = await restoreWorkspace(makeResult(), plan, io);

    expect(warnings).toEqual([]);
  });

  it('is silent for a legacy manifest entry with no expectedSessionId', async () => {
    const io = makeIoProducing({ '/logs/a.log': 'f-whatever' });
    const plan = makePlan({
      loads: [{ path: '/logs/a.log', dataIndex: null }],
    });

    const warnings = await restoreWorkspace(makeResult(), plan, io);

    expect(warnings).toEqual([]);
  });

  it('includes the unresolved-reference count when workspace analyses reference the old id', async () => {
    const io = makeIoProducing({ '/logs/a.log': 'f-new123' });
    const plan = makePlan({
      loads: [{ path: '/logs/a.log', dataIndex: null, expectedSessionId: 'f-old456' }],
    });
    const analyses = makeAnalysesReferencing('f-old456', 3);

    const warnings = await restoreWorkspace(makeResult({ analyses }), plan, io);

    expect(warnings).toContain(
      'a.log changed since the workspace was saved; 3 analysis reference(s) for it are now unresolved.',
    );
  });

  it('omits the reference clause when no analyses reference the old id', async () => {
    const io = makeIoProducing({ '/logs/a.log': 'f-new123' });
    const plan = makePlan({
      loads: [{ path: '/logs/a.log', dataIndex: null, expectedSessionId: 'f-old456' }],
    });

    const warnings = await restoreWorkspace(makeResult({ analyses: [] }), plan, io);

    expect(warnings).toContain('a.log changed since the workspace was saved.');
  });

  it('does not count references belonging to a different session id', async () => {
    const io = makeIoProducing({ '/logs/a.log': 'f-new123' });
    const plan = makePlan({
      loads: [{ path: '/logs/a.log', dataIndex: null, expectedSessionId: 'f-old456' }],
    });
    const analyses = makeAnalysesReferencing('f-unrelated', 5);

    const warnings = await restoreWorkspace(makeResult({ analyses }), plan, io);

    expect(warnings).toContain('a.log changed since the workspace was saved.');
  });
});

describe('restoreWorkspace — bounded-concurrency loads (workspace-restore-performance)', () => {
  /** `buildRestoreOutcomes` is mocked (module-level `vi.mock('./restorePlan', ...)`
   *  above) — the most direct seam to inspect exactly what `producedSessionIdsPerLoad`
   *  restoreCore built, positionally aligned to `plan.loads`. */
  function capturedProducedSessionIds(): unknown {
    return mockBuildRestoreOutcomes.mock.calls[0]?.[1];
  }

  it('attributes each load its OWN produced session id by return value, correctly positioned even when loads resolve out of order', async () => {
    const resolvers: Record<string, (ids: string[]) => void> = {};
    const io = makeIo({
      loadFile: vi.fn((path: string) => new Promise<string[]>((resolve) => { resolvers[path] = resolve; })),
    });
    const plan = makePlan({
      loads: [
        { path: '/a.log', paneId: 'pane-a', dataIndex: null },
        { path: '/b.log', paneId: 'pane-b', dataIndex: null },
      ],
    });

    const restorePromise = restoreWorkspace(makeResult(), plan, io);

    // Both loads target DIFFERENT panes, so both should be dispatched
    // concurrently — wait for both to be in flight before resolving either.
    await vi.waitFor(() => {
      expect(resolvers['/a.log']).toBeDefined();
      expect(resolvers['/b.log']).toBeDefined();
    });

    // Resolve OUT OF ORDER: the second load (`/b.log`) settles first.
    resolvers['/b.log']!(['s-b']);
    await Promise.resolve();
    resolvers['/a.log']!(['s-a']);

    await restorePromise;

    // producedSessionIdsPerLoad must stay aligned to plan.loads' ORIGINAL
    // order (index 0 -> /a.log's id, index 1 -> /b.log's id), regardless of
    // which one's promise actually settled first.
    expect(capturedProducedSessionIds()).toEqual([['s-a'], ['s-b']]);
  });

  it('a multi-session .lts load returns all its session ids in order', async () => {
    const io = makeIo({
      loadFile: vi.fn(async () => ['primary-id', 'extra-1', 'extra-2']),
    });
    const plan = makePlan({ loads: [{ path: '/bundle.lts', dataIndex: null }] });

    await restoreWorkspace(makeResult(), plan, io);

    expect(capturedProducedSessionIds()).toEqual([['primary-id', 'extra-1', 'extra-2']]);
  });

  it('runs loads targeting DIFFERENT panes concurrently', async () => {
    const active = new Set<string>();
    let maxActive = 0;
    const io = makeIo({
      loadFile: vi.fn(async (path: string) => {
        active.add(path);
        maxActive = Math.max(maxActive, active.size);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active.delete(path);
        return [`s-${path}`];
      }),
    });
    const plan = makePlan({
      loads: [
        { path: '/a.log', paneId: 'pane-a', dataIndex: null },
        { path: '/b.log', paneId: 'pane-b', dataIndex: null },
        { path: '/c.log', paneId: 'pane-c', dataIndex: null },
      ],
    });

    await restoreWorkspace(makeResult(), plan, io);

    expect(maxActive).toBeGreaterThan(1);
  });

  it('serializes loads that target the SAME pane — the second is never dispatched before the first settles', async () => {
    const callOrder: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const io = makeIo({
      loadFile: vi.fn(async (path: string) => {
        callOrder.push(`start:${path}`);
        if (path === '/a.log') {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        callOrder.push(`end:${path}`);
        return [path === '/a.log' ? 's-a' : 's-b'];
      }),
    });
    const plan = makePlan({
      loads: [
        { path: '/a.log', paneId: 'same-pane', dataIndex: null },
        { path: '/b.log', paneId: 'same-pane', dataIndex: null },
      ],
    });

    const restorePromise = restoreWorkspace(makeResult(), plan, io);

    await vi.waitFor(() => expect(callOrder).toContain('start:/a.log'));
    // Give the scheduler every chance to (incorrectly) start the second load
    // too while the first is still pending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callOrder).not.toContain('start:/b.log');

    releaseFirst!();
    await restorePromise;

    expect(callOrder).toEqual(['start:/a.log', 'end:/a.log', 'start:/b.log', 'end:/b.log']);
  });

  it('two loads with no resolvable pane (both undefined) are also serialized, not raced', async () => {
    const callOrder: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const io = makeIo({
      loadFile: vi.fn(async (path: string) => {
        callOrder.push(`start:${path}`);
        if (path === '/a.log') {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        callOrder.push(`end:${path}`);
        return [];
      }),
    });
    // Neither load carries a paneId, and there is no paneResolver (no saved
    // layout) — both fall back to `loadFile`'s own "active pane" default,
    // exactly the ambiguous-destination case the scheduler must serialize.
    const plan = makePlan({
      loads: [
        { path: '/a.log', dataIndex: null },
        { path: '/b.log', dataIndex: null },
      ],
    });

    const restorePromise = restoreWorkspace(makeResult(), plan, io);

    await vi.waitFor(() => expect(callOrder).toContain('start:/a.log'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callOrder).not.toContain('start:/b.log');

    releaseFirst!();
    await restorePromise;

    expect(callOrder).toEqual(['start:/a.log', 'end:/a.log', 'start:/b.log', 'end:/b.log']);
  });

  it('a load that throws still lets the restore proceed, with an empty produced-id list at its position', async () => {
    const io = makeIo({
      loadFile: vi.fn(async (path: string) => {
        if (path === '/bad.log') throw new Error('boom');
        return ['s-good'];
      }),
    });
    const plan = makePlan({
      loads: [
        { path: '/bad.log', paneId: 'pane-a', dataIndex: null },
        { path: '/good.log', paneId: 'pane-b', dataIndex: null },
      ],
    });

    await restoreWorkspace(makeResult(), plan, io);

    expect(capturedProducedSessionIds()).toEqual([[], ['s-good']]);
  });
});

describe('restoreWorkspace — center-tree skeleton rebuild (f5d0e527)', () => {
  function logviewerTab(id: string, sourcePath: string): Tab {
    return { id, type: 'logviewer', label: 'log', closable: true, sourcePath };
  }
  function leaf(paneId: string, tabs: Tab[]): SplitNode {
    return { type: 'leaf', id: `leaf-${paneId}`, pane: { id: paneId, tabs, activeTabId: tabs[0]?.id ?? '' } };
  }
  function split(left: SplitNode, right: SplitNode): SplitNode {
    return { type: 'split', id: 'split-1', direction: 'horizontal', children: [left, right], ratio: 0.5 };
  }

  /** Pull the tree argument off the `workspace:restore-tree-skeleton` emit, if any. */
  function emittedSkeletonTree(): SplitNode | undefined {
    const call = mockBusEmit.mock.calls.find((c) => c[0] === 'workspace:restore-tree-skeleton');
    return (call?.[1] as { tree: SplitNode } | undefined)?.tree;
  }

  it('steers each load at its remapped pane, matched by sourcePath, and emits the skeleton before any load', async () => {
    const savedTree = split(
      leaf('old-1', [logviewerTab('t1', '/device-a/dumpstate.txt')]),
      leaf('old-2', [logviewerTab('t2', '/device-b/dumpstate.txt')]),
    );
    const io = makeIo();
    const plan = makePlan({
      applyLtwViewState: true,
      loads: [
        { path: '/device-a/dumpstate.txt', dataIndex: null },
        { path: '/device-b/dumpstate.txt', dataIndex: null },
      ],
    });

    await restoreWorkspace(makeResult({ layout: { centerTree: savedTree } }), plan, io);

    const tree = emittedSkeletonTree();
    expect(tree).toBeDefined();
    const validPaneIds = new Set(allPanes(tree!).map((p) => p.id));

    const loadFileMock = io.loadFile as unknown as { mock: { calls: unknown[][] } };
    const [callA, callB] = loadFileMock.mock.calls as Array<[string, string | undefined, ...unknown[]]>;
    expect(callA[0]).toBe('/device-a/dumpstate.txt');
    expect(callB[0]).toBe('/device-b/dumpstate.txt');
    const paneIdA = callA[1];
    const paneIdB = callB[1];

    // Each load landed in a real leaf of the rebuilt tree...
    expect(paneIdA).toBeDefined();
    expect(paneIdB).toBeDefined();
    expect(validPaneIds.has(paneIdA!)).toBe(true);
    expect(validPaneIds.has(paneIdB!)).toBe(true);
    // ...and in DIFFERENT panes — grouping survived, nothing flattened.
    expect(paneIdA).not.toBe(paneIdB);

    // The skeleton must be emitted strictly before either load runs.
    const skeletonOrder = mockBusEmit.mock.invocationCallOrder[
      mockBusEmit.mock.calls.findIndex((c) => c[0] === 'workspace:restore-tree-skeleton')
    ];
    const firstLoadOrder = (io.loadFile as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(skeletonOrder).toBeLessThan(firstLoadOrder);
  });

  it('a legacy layout with no saved tree leaves paneId untouched (flat behavior preserved)', async () => {
    const io = makeIo();
    const plan = makePlan({
      applyLtwViewState: true,
      loads: [{ path: '/a.log', dataIndex: null }],
    });

    await restoreWorkspace(makeResult({ layout: { someOtherField: true } }), plan, io);

    expect(emittedSkeletonTree()).toBeUndefined();
    expect(io.loadFile).toHaveBeenCalledWith(
      '/a.log', undefined, undefined, undefined, undefined, expect.any(String),
    );
  });

  it('does not rebuild the tree when localStorage is already the fresher source (applyLtwViewState=false)', async () => {
    const savedTree = split(leaf('old-1', [logviewerTab('t1', '/a.log')]), leaf('old-2', []));
    const io = makeIo();
    // A stale paneId the plan itself already resolved (e.g. from stored tabs) —
    // must be passed straight through unchanged, not remapped or dropped.
    const plan = makePlan({
      applyLtwViewState: false,
      loads: [{ path: '/a.log', paneId: 'already-live-pane', dataIndex: null }],
    });

    await restoreWorkspace(makeResult({ layout: { centerTree: savedTree } }), plan, io);

    expect(emittedSkeletonTree()).toBeUndefined();
    expect(io.loadFile).toHaveBeenCalledWith(
      '/a.log', 'already-live-pane', undefined, undefined, undefined, expect.any(String),
    );
  });

  it('a session with no sourcePath match falls back to the plan paneId (e.g. a file opened after last save)', async () => {
    const savedTree = leaf('old-1', [logviewerTab('t1', '/known.log')]);
    const io = makeIo();
    const plan = makePlan({
      applyLtwViewState: true,
      loads: [{ path: '/unrelated-new-file.log', paneId: undefined, dataIndex: null }],
    });

    await restoreWorkspace(makeResult({ layout: { centerTree: savedTree } }), plan, io);

    expect(io.loadFile).toHaveBeenCalledWith(
      '/unrelated-new-file.log', undefined, undefined, undefined, undefined, expect.any(String),
    );
  });

  it('resolves an editor tab to its remapped pane, matched by filePath (review fix #2)', async () => {
    const editorTabInTree: Tab = { id: 'e1', type: 'editor', label: 'notes.md', closable: true, sourcePath: '/notes/scratch.md' };
    const savedTree = split(
      leaf('old-1', [logviewerTab('t1', '/device-a.log')]),
      leaf('old-2', [editorTabInTree]),
    );
    const io = makeIo();
    const plan = makePlan({
      applyLtwViewState: true,
      loads: [{ path: '/device-a.log', dataIndex: null }],
    });
    mockBuildEditorTabEvents.mockReturnValue([
      { type: 'editor', label: 'notes.md', filePath: '/notes/scratch.md', editorState: { content: 'hi', viewMode: 'editor', wordWrap: false } },
    ]);

    await restoreWorkspace(makeResult({ layout: { centerTree: savedTree }, editorTabs: [] }), plan, io);

    const tree = emittedSkeletonTree()!;
    const expectedPaneId = allPanes(tree)[1].id; // 'old-2' remapped — second leaf in traversal order
    const openTabCall = mockBusEmit.mock.calls.find((c) => c[0] === 'layout:open-tab');
    expect(openTabCall?.[1]).toMatchObject({ type: 'editor', filePath: '/notes/scratch.md', paneId: expectedPaneId });
    // Did NOT land on the logviewer's pane.
    expect(openTabCall?.[1]).not.toMatchObject({ paneId: allPanes(tree)[0].id });
  });

  it('an editor tab with no sourcePath match emits layout:open-tab with paneId undefined (normal fallback)', async () => {
    const savedTree = leaf('old-1', [logviewerTab('t1', '/known.log')]);
    const io = makeIo();
    const plan = makePlan({ applyLtwViewState: true, loads: [] });
    mockBuildEditorTabEvents.mockReturnValue([
      { type: 'editor', label: 'Untitled 1', filePath: undefined, editorState: { content: '', viewMode: 'editor', wordWrap: false } },
    ]);

    await restoreWorkspace(makeResult({ layout: { centerTree: savedTree } }), plan, io);

    const openTabCall = mockBusEmit.mock.calls.find((c) => c[0] === 'layout:open-tab');
    expect(openTabCall?.[1]).toMatchObject({ paneId: undefined });
  });

  it('ef1b193e: a stale manifest paneId with no sourcePath/oldPaneId match in the rebuilt skeleton is NOT passed through — falls back to undefined', async () => {
    // The skeleton was rebuilt with entirely fresh pane/leaf ids (see
    // rebuildTreeSkeleton). A load whose OWN `paneId` field is some stale
    // value unrelated to this tree (not a sourcePath match, not a key in
    // paneIdMap) used to fall through resolve()'s `?? load.paneId` straight
    // into `io.loadFile` — a pane id that is not a genuine leaf of the tree
    // that was just emitted via workspace:restore-tree-skeleton. Validating
    // against that tree must catch it and pass `undefined` instead, so the
    // load serializes into the '__unresolved-pane__' lane and binds via
    // loadFile's own active-pane inference rather than risking a collision.
    const savedTree = leaf('old-1', [logviewerTab('t1', '/known.log')]);
    const io = makeIo();
    const plan = makePlan({
      applyLtwViewState: true,
      loads: [{ path: '/unrelated-new-file.log', paneId: 'stale-pane-from-old-session', dataIndex: null }],
    });

    await restoreWorkspace(makeResult({ layout: { centerTree: savedTree } }), plan, io);

    expect(io.loadFile).toHaveBeenCalledWith(
      '/unrelated-new-file.log', undefined, undefined, undefined, undefined, expect.any(String),
    );
  });

  it('ef1b193e: two loads that both resolve to an invalid stale paneId are serialized (both fall into the unresolved lane), not raced', async () => {
    const callOrder: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const savedTree = leaf('old-1', [logviewerTab('t1', '/known.log')]);
    const io = makeIo({
      loadFile: vi.fn(async (path: string) => {
        callOrder.push(`start:${path}`);
        if (path === '/a.log') {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        callOrder.push(`end:${path}`);
        return [];
      }),
    });
    const plan = makePlan({
      applyLtwViewState: true,
      loads: [
        { path: '/a.log', paneId: 'stale-pane-1', dataIndex: null },
        { path: '/b.log', paneId: 'stale-pane-2', dataIndex: null },
      ],
    });

    const restorePromise = restoreWorkspace(makeResult({ layout: { centerTree: savedTree } }), plan, io);

    await vi.waitFor(() => expect(callOrder).toContain('start:/a.log'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both stale ids resolve to undefined (invalid leaf) -> same
    // '__unresolved-pane__' key -> must serialize, not run concurrently.
    expect(callOrder).not.toContain('start:/b.log');

    releaseFirst!();
    await restorePromise;

    expect(callOrder).toEqual(['start:/a.log', 'end:/a.log', 'start:/b.log', 'end:/b.log']);
    expect(io.loadFile).toHaveBeenNthCalledWith(
      1, '/a.log', undefined, undefined, undefined, undefined, expect.any(String),
    );
    expect(io.loadFile).toHaveBeenNthCalledWith(
      2, '/b.log', undefined, undefined, undefined, undefined, expect.any(String),
    );
  });

  it('a throwing skeleton rebuild is caught, warns, falls back to flat placement, and still reaches workspace:restore-end (review fix #1)', async () => {
    // A tab whose `.type` getter throws — forces a genuine (non-mocked)
    // exception inside rebuildTreeSkeleton's tree walk, verifying the
    // try/catch around that block (restoreCore.ts) actually catches it
    // rather than leaving workspace:restore-begin's suppression gates
    // (useWorkspaceAutoSave's + useWorkspaceLayout's persistGateRef) stuck.
    const evilTab = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'type') throw new Error('boom-evil-tab-getter');
        return undefined;
      },
    });
    const savedTree = leaf('old-1', [evilTab as unknown as Tab]);
    const io = makeIo();
    const plan = makePlan({ applyLtwViewState: true, loads: [{ path: '/a.log', dataIndex: null }] });

    const warnings = await restoreWorkspace(makeResult({ layout: { centerTree: savedTree } }), plan, io);

    expect(warnings.some((w) => w.includes('boom-evil-tab-getter'))).toBe(true);
    expect(emittedSkeletonTree()).toBeUndefined();
    // Restore proceeded past the failure: the load still ran (flat fallback,
    // no paneId), and the lifecycle-bracket end event still fired.
    expect(io.loadFile).toHaveBeenCalledWith(
      '/a.log', undefined, undefined, undefined, undefined, expect.any(String),
    );
    const events = mockBusEmit.mock.calls.map((c) => c[0]);
    expect(events).toContain('workspace:restore-end');
  });
});
