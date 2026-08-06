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

function makeIo(overrides?: Partial<RestoreIo>): RestoreIo & {
  calls: string[];
  setWorkspaceAnalysesArgs: unknown[][];
} {
  const calls: string[] = [];
  const setWorkspaceAnalysesArgs: unknown[][] = [];
  return {
    calls,
    setWorkspaceAnalysesArgs,
    loadFile: vi.fn(async (path: string) => { calls.push(`loadFile:${path}`); }),
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
  /** An `io.loadFile` that simulates the `session:loaded` bus event a real
   *  load fires synchronously before its promise resolves — the mechanism
   *  `restoreWorkspace` uses to learn what session id a load produced. Looks
   *  up the handler `restoreWorkspace` registered via the mocked `bus.on` and
   *  invokes it with the given session id, tagged with the loadRequestId this
   *  call actually received (position 6, matching the real `loadFile` shape). */
  function makeIoProducing(pathToSessionId: Record<string, string>): RestoreIo {
    return {
      loadFile: vi.fn(async (
        path: string,
        _paneId?: string,
        _existingTabId?: string,
        _sourceType?: unknown,
        _replace?: boolean,
        loadRequestId?: string,
      ) => {
        const sessionId = pathToSessionId[path];
        if (!sessionId) return;
        const call = mockBusOn.mock.calls.find((c: unknown[]) => c[0] === 'session:loaded');
        const handler = call?.[1] as ((p: { sessionId: string; loadRequestId?: string }) => void) | undefined;
        handler?.({ sessionId, loadRequestId });
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
