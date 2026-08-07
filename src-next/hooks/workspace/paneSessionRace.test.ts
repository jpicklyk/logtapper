// @vitest-environment jsdom
/**
 * Cross-layer integration harness for ef1b193e-0104-4c78-aee2-16225a55edf2
 * ("concurrent restore loads race paneSessionMap — pane renders wrong
 * session").
 *
 * Mounts the REAL `SessionContext` reducer (`SessionProvider`), the REAL
 * `useCenterTree` tree wiring, and the REAL registration flow
 * (`useFileSession`'s `loadFile` -> `registerLoadedSession` ->
 * `activateSessionForPane`, plus `useSessionTabManager`'s
 * `layout:pane-session-remap` / `layout:logviewer-tab-activated` handlers) —
 * all wired together over the REAL event bus, exactly as production code is.
 * Only the backend IPC boundary (`loadLogFile`) and unrelated infrastructure
 * (Tauri listener setup, cache LRU internals, editor-tab localStorage,
 * viewport rendering) are mocked — `loadLogFile`'s mock exposes fully
 * controllable per-call latency so two loads can be driven to resolve in
 * either order.
 *
 * See also:
 *  - `context/SessionContext.test.ts` — reducer-only unit tests for the
 *    overwrite guard (point 1 of the fix).
 *  - `tabSessionMap.test.ts` — pure-function unit tests for the firstLeaf
 *    occupancy check (point 2).
 *  - `restoreCore.test.ts` — unit tests for the effectivePaneId live-leaf
 *    validation (point 3).
 * This file is the only one that exercises all three fixes TOGETHER through
 * real hooks, reproducing the actual race.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks (hoisted) — everything NOT relevant to the pane/session binding race.
// ---------------------------------------------------------------------------

const mockLoadLogFile = vi.fn();
vi.mock('../../bridge/commands', () => ({
  loadLogFile: (...args: unknown[]) => mockLoadLogFile(...args),
  closeSession: vi.fn(async () => {}),
  getLines: vi.fn(async () => ({ lines: [] })),
  updateStreamProcessors: vi.fn(async () => {}),
  updateStreamTrackers: vi.fn(async () => {}),
  updateStreamTransformers: vi.fn(async () => {}),
}));

vi.mock('../../bridge/events', () => ({
  onFileIndexProgress: () => Promise.resolve(() => {}),
  onFileIndexComplete: () => Promise.resolve(() => {}),
  onBridgeSessionOpened: () => Promise.resolve(() => {}),
  onBridgeSessionClosed: () => Promise.resolve(() => {}),
}));

vi.mock('../../cache', () => ({
  preSeedSession: vi.fn(),
  clearPreSeed: vi.fn(),
}));

vi.mock('../../viewport', () => ({
  sessionScrollPositions: { get: () => 0, set: () => {}, delete: () => {} },
}));

// useCenterTree pulls in EditorTab (for LS_*_PREFIX constants), whose module
// graph reaches ThemeContext's module-load `window.matchMedia` call —
// unavailable in this environment. Same mock as useCenterTree.test.ts.
vi.mock('../../components/EditorTab', () => ({
  LS_CONTENT_PREFIX: 'logtapper_scratchpad_',
  LS_MODE_PREFIX: 'logtapper_editor_mode_',
  LS_WRAP_PREFIX: 'logtapper_editor_wrap_',
  LS_FILEPATH_PREFIX: 'logtapper_editor_filepath_',
}));

// Resolves to the same module (hooks/workspace/workspacePersistence.ts) that
// useFileSession.ts and useSessionTabManager.ts import via '../workspace/...'.
vi.mock('./workspacePersistence', () => ({
  readTabPaths: () => ({}),
  saveTabPaths: () => {},
}));

// Resolves to the same module (hooks/useWorkspaceLayout.ts) useFileSession.ts
// imports via '../useWorkspaceLayout' — stubbed to avoid its heavy
// (usePanelDimensions/useLayoutPreset/useCenterTree) dependency graph, none
// of which this harness needs (it wires useCenterTree itself, directly).
vi.mock('../useWorkspaceLayout', () => ({
  getStoredFirstPaneId: () => null,
  getStoredLogviewerTabs: () => [],
}));

import { SessionProvider, useSessionCoreCtx, useSessionPaneCtx } from '../../context/SessionContext';
import { ViewerProvider } from '../../context/ViewerContext';
import { useCenterTree } from './useCenterTree';
import { useFileSession } from '../useLogViewer/useFileSession';
import { useSessionTabManager } from '../useLogViewer/useSessionTabManager';
import type { SharedLogViewerRefs } from '../useLogViewer/types';
import type { CacheController } from '../../cache';
import type { LoadResult } from '../../bridge/types';
import type { SplitNode } from './workspaceTypes';
import { findLeafByPaneId } from './splitTreeHelpers';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PANE_A = 'pane-a';
const PANE_B = 'pane-b';

/** Two empty leaves side by side — mirrors a restored center-tree skeleton
 *  (`restoreTreeSkeleton.ts`'s rebuild drops logviewer tabs from each leaf,
 *  leaving empty panes for the session loads to bind into). */
function twoEmptyPaneTree(): SplitNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    ratio: 0.5,
    children: [
      { type: 'leaf', id: 'leaf-a', pane: { id: PANE_A, tabs: [], activeTabId: '' } },
      { type: 'leaf', id: 'leaf-b', pane: { id: PANE_B, tabs: [], activeTabId: '' } },
    ],
  };
}

function makeLoadResult(sessionId: string, path: string, totalLines = 100): LoadResult {
  return {
    sessionId,
    sourceId: sessionId,
    sourceName: path.split('/').pop() ?? path,
    filePath: path,
    totalLines,
    fileSize: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: 'Unknown',
    isStreaming: false,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
  };
}

function makeCacheController(): CacheController {
  return {
    broadcastToSession: vi.fn(),
    clearSession: vi.fn(),
    releaseSessionViews: vi.fn(),
    getSessionEntries: vi.fn(() => [][Symbol.iterator]()),
    setTotalBudget: vi.fn(),
  } as unknown as CacheController;
}

/** The harness hook: composes the REAL SessionContext + useCenterTree +
 *  useFileSession + useSessionTabManager exactly the way `useLogViewer.ts`
 *  (the production orchestrator) does, minus the sub-hooks unrelated to file
 *  loading / pane binding (streaming, filter scan, search nav). */
function useHarness(cacheManager: CacheController, initialTree: SplitNode) {
  const core = useSessionCoreCtx();
  const { activeLogPaneId } = useSessionPaneCtx();

  const refsContainer = React.useRef<SharedLogViewerRefs | null>(null);
  if (!refsContainer.current) {
    refsContainer.current = {
      sessionRef: { current: null },
      activeLogPaneIdRef: { current: null },
      paneSessionMapRef: { current: new Map() },
      sessionsRef: { current: new Map() },
      streamingPaneIdRef: { current: null },
      streamingSessionIdRef: { current: null },
      isStreamingRef: { current: false },
      streamDeviceSerialRef: { current: null },
      adbStoppedUnlistenRef: { current: null },
      filterAstRef: { current: null },
      filterAstSessionIdRef: { current: null },
      packagePidsRef: { current: new Map() },
      appendFilterMatchesRef: { current: null },
      resetSessionStateRef: { current: () => {} },
    };
  }
  const refs = refsContainer.current;
  refs.activeLogPaneIdRef.current = activeLogPaneId;
  refs.paneSessionMapRef.current = core.paneSessionMap;
  refs.sessionsRef.current = core.sessions;

  const centerTree = useCenterTree(
    {
      activeLogPaneIdRef: refs.activeLogPaneIdRef,
      paneSessionMapRef: refs.paneSessionMapRef,
      activateSessionForPane: core.activateSessionForPane,
      openBottomPane: () => {},
    },
    initialTree,
  );

  const fileSession = useFileSession(cacheManager, refs, {
    resetSessionState: () => {},
    detachStream: () => {},
  });

  const tabManager = useSessionTabManager(cacheManager, refs, {
    stopStream: async () => {},
    resetSessionState: () => {},
    setIndexingProgressLocal: () => {},
  });

  // `FileSessionResult.loadFile`'s PUBLIC type is `(path, paneId?)` — it
  // elides `existingTabId`/`sourceType`/`replace`/`loadRequestId`, which the
  // real implementation accepts at runtime (restoreCore.ts's `RestoreIo`
  // documents the same widening for the same reason). Cast once here so
  // tests can drive those extra params directly, exactly as restoreCore does.
  const loadFileFull = fileSession.loadFile as (
    path: string,
    paneId?: string,
    existingTabId?: string,
    sourceType?: string,
    replace?: boolean,
    loadRequestId?: string,
  ) => Promise<string[]>;

  return { core, centerTree, fileSession: { ...fileSession, loadFile: loadFileFull }, tabManager };
}

function renderHarness(initialTree: SplitNode = twoEmptyPaneTree()) {
  const cacheManager = makeCacheController();
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(SessionProvider, null, React.createElement(ViewerProvider, null, children));
  return renderHook(() => useHarness(cacheManager, initialTree), { wrapper });
}

/** Controllable-latency `loadLogFile`: registers a resolver per path so the
 *  test can settle each load's backend IPC independently and in any order. */
function installControllableLoadLogFile(): {
  resolvers: Record<string, (results: LoadResult[]) => void>;
} {
  const resolvers: Record<string, (results: LoadResult[]) => void> = {};
  mockLoadLogFile.mockImplementation(
    (path: string) => new Promise<LoadResult[]>((resolve) => { resolvers[path] = resolve; }),
  );
  return { resolvers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// RTL's auto-cleanup registration depends on `afterEach` being a real test-
// framework global, which this project's vitest config does not enable
// (no `test.globals: true`). Without an explicit unmount, every mounted
// harness's bus listeners (useCenterTree's session:loaded/loading,
// useSessionTabManager's layout:pane-session-remap/tab-activated) stay
// registered on the shared `bus` singleton across tests, so a LATER test's
// bus emits get processed by EVERY earlier test's still-mounted (but
// logically dead) hook instances too — cross-test interference this harness
// is especially sensitive to, since it wires real cross-hook bus plumbing.
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Scenario 1 — two panes, fast+slow loads resolving OUT OF ORDER
// ---------------------------------------------------------------------------

describe('scenario 1 — out-of-order concurrent loads into different panes', () => {
  it('binds each pane to its OWN session regardless of which load resolves first', async () => {
    const { resolvers } = installControllableLoadLogFile();
    const { result } = renderHarness();

    let loadA!: Promise<string[]>;
    let loadB!: Promise<string[]>;
    act(() => {
      // Large/slow file targeted at pane A.
      loadA = result.current.fileSession.loadFile('/dumpstate.txt', PANE_A);
      // Small/fast file targeted at pane B.
      loadB = result.current.fileSession.loadFile('/dumpstate_board.txt', PANE_B);
    });

    await waitFor(() => {
      expect(resolvers['/dumpstate.txt']).toBeDefined();
      expect(resolvers['/dumpstate_board.txt']).toBeDefined();
    });

    // Resolve OUT OF ORDER: the small file (second call) settles FIRST.
    act(() => { resolvers['/dumpstate_board.txt']!([makeLoadResult('session-small', '/dumpstate_board.txt', 15)]); });
    await act(async () => { await loadB; });

    // Then the large file settles.
    act(() => { resolvers['/dumpstate.txt']!([makeLoadResult('session-large', '/dumpstate.txt', 676_000)]); });
    await act(async () => { await loadA; });

    const paneSessionMap = result.current.core.paneSessionMap;
    expect(paneSessionMap.get(PANE_A)).toBe('session-large');
    expect(paneSessionMap.get(PANE_B)).toBe('session-small');
    // Different sessions per pane — this is the exact defect the bug report
    // observed being violated ("both panes render the tiny file's content").
    expect(paneSessionMap.get(PANE_A)).not.toBe(paneSessionMap.get(PANE_B));

    // Tab labels/tree stay consistent with the bindings: each pane's tree
    // leaf has exactly one logviewer tab, matching its paneSessionMap entry.
    const tree = result.current.centerTree.treeRef.current;
    const leafA = findLeafByPaneId(tree, PANE_A);
    const leafB = findLeafByPaneId(tree, PANE_B);
    expect(leafA?.pane.tabs).toHaveLength(1);
    expect(leafA?.pane.tabs[0].label).toBe('dumpstate.txt');
    expect(leafB?.pane.tabs).toHaveLength(1);
    expect(leafB?.pane.tabs[0].label).toBe('dumpstate_board.txt');
  });

  it('also binds correctly when the large/slow file resolves first (order-independence)', async () => {
    const { resolvers } = installControllableLoadLogFile();
    const { result } = renderHarness();

    let loadA!: Promise<string[]>;
    let loadB!: Promise<string[]>;
    act(() => {
      loadA = result.current.fileSession.loadFile('/a.log', PANE_A);
      loadB = result.current.fileSession.loadFile('/b.log', PANE_B);
    });

    await waitFor(() => {
      expect(resolvers['/a.log']).toBeDefined();
      expect(resolvers['/b.log']).toBeDefined();
    });

    act(() => { resolvers['/a.log']!([makeLoadResult('session-a', '/a.log')]); });
    await act(async () => { await loadA; });
    act(() => { resolvers['/b.log']!([makeLoadResult('session-b', '/b.log')]); });
    await act(async () => { await loadB; });

    const paneSessionMap = result.current.core.paneSessionMap;
    expect(paneSessionMap.get(PANE_A)).toBe('session-a');
    expect(paneSessionMap.get(PANE_B)).toBe('session-b');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — overwrite guard: late activation for an occupied pane is
// refused; the legit replace flow still overwrites.
// ---------------------------------------------------------------------------

describe('scenario 2 — overwrite guard distinguishes a race from a legit replace', () => {
  it('a late-resolving load whose target pane was claimed by a sibling in the meantime does not steal it', async () => {
    const { resolvers } = installControllableLoadLogFile();
    const { result } = renderHarness();

    // Both loads target the SAME pane explicitly, each with its OWN
    // `existingTabId` (mirrors two restore entries persisted to the same
    // pane, each with its own saved tab id) — this keeps them on DIFFERENT
    // per-tab generation keys (`loadGeneration.ts`'s `genKeyFor`) so neither
    // supersedes/cancels the other; both still read PANE_A's paneSessionMap
    // as empty at their own pre-await snapshot (isNewTab=false for both),
    // exactly the "direct writer blind to a sibling concurrent load" hazard
    // from the root-cause diagnosis.
    let loadFirst!: Promise<string[]>;
    let loadSecond!: Promise<string[]>;
    act(() => {
      loadFirst = result.current.fileSession.loadFile('/first.log', PANE_A, 'tab-1');
      loadSecond = result.current.fileSession.loadFile('/second.log', PANE_A, 'tab-2');
    });

    await waitFor(() => {
      expect(resolvers['/first.log']).toBeDefined();
      expect(resolvers['/second.log']).toBeDefined();
    });

    // The SECOND load (started later) resolves FIRST and claims pane A.
    act(() => { resolvers['/second.log']!([makeLoadResult('session-second', '/second.log')]); });
    await act(async () => { await loadSecond; });
    expect(result.current.core.paneSessionMap.get(PANE_A)).toBe('session-second');

    // The FIRST load's pre-await snapshot believed pane A was empty
    // (isNewTab=false) — its own direct activateSessionForPane call now
    // races against the pane session-second legitimately claimed.
    act(() => { resolvers['/first.log']!([makeLoadResult('session-first', '/first.log')]); });
    await act(async () => { await loadFirst; });

    // Refused: pane A must still show session-second, not get silently
    // stolen by the late-resolving sibling.
    expect(result.current.core.paneSessionMap.get(PANE_A)).toBe('session-second');
  });

  it('an explicit reopen-as (replace=true) still overwrites the pane it targets', async () => {
    const { resolvers } = installControllableLoadLogFile();
    const { result } = renderHarness();

    let loadA!: Promise<string[]>;
    act(() => { loadA = result.current.fileSession.loadFile('/original.log', PANE_A); });
    await waitFor(() => expect(resolvers['/original.log']).toBeDefined());
    act(() => { resolvers['/original.log']!([makeLoadResult('session-original', '/original.log')]); });
    await act(async () => { await loadA; });
    expect(result.current.core.paneSessionMap.get(PANE_A)).toBe('session-original');

    // Explicit replace (mirrors FileInfoPane's reopen-as: paneId, existingTabId=undefined,
    // sourceType override, replace=true).
    let loadReplace!: Promise<string[]>;
    act(() => {
      loadReplace = result.current.fileSession.loadFile('/original.log', PANE_A, undefined, 'Kernel', true);
    });
    await waitFor(() => expect(resolvers['/original.log']).toBeDefined());
    act(() => { resolvers['/original.log']!([makeLoadResult('session-reopened', '/original.log')]); });
    await act(async () => { await loadReplace; });

    expect(result.current.core.paneSessionMap.get(PANE_A)).toBe('session-reopened');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — firstLeaf fallback respects occupancy: a load whose paneId
// does not resolve to a live tree leaf must not steal an already-occupied
// pane when an unoccupied one exists.
// ---------------------------------------------------------------------------

describe('scenario 3 — unresolved-pane fallback does not steal an occupied pane', () => {
  it('lands the second (unresolved-pane) load on the unoccupied pane, not the occupied one', async () => {
    const { resolvers } = installControllableLoadLogFile();
    const { result } = renderHarness();

    // First load claims pane A normally.
    let loadA!: Promise<string[]>;
    act(() => { loadA = result.current.fileSession.loadFile('/large.log', PANE_A); });
    await waitFor(() => expect(resolvers['/large.log']).toBeDefined());
    act(() => { resolvers['/large.log']!([makeLoadResult('session-large', '/large.log')]); });
    await act(async () => { await loadA; });
    expect(result.current.core.paneSessionMap.get(PANE_A)).toBe('session-large');

    // Second load's OWN paneId does not resolve to any live tree leaf (mirrors
    // a stale/unresolved restore pane id reaching useFileSession) — it must
    // fall through applySessionLoaded's fallback and land on pane B (the only
    // unoccupied leaf), not steal pane A.
    let loadStale!: Promise<string[]>;
    act(() => { loadStale = result.current.fileSession.loadFile('/small.log', 'nonexistent-pane-id'); });
    await waitFor(() => expect(resolvers['/small.log']).toBeDefined());
    act(() => { resolvers['/small.log']!([makeLoadResult('session-small', '/small.log')]); });
    await act(async () => { await loadStale; });

    expect(result.current.core.paneSessionMap.get(PANE_A)).toBe('session-large');
    expect(result.current.core.paneSessionMap.get(PANE_B)).toBe('session-small');

    const tree = result.current.centerTree.treeRef.current;
    expect(findLeafByPaneId(tree, PANE_A)?.pane.tabs).toHaveLength(1);
    expect(findLeafByPaneId(tree, PANE_B)?.pane.tabs).toHaveLength(1);
  });
});
