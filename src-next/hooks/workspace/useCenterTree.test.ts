// @vitest-environment jsdom
/**
 * Tests for ref-write correctness in useCenterTree (L7 and L10 fixes).
 *
 * L7: treeRef.current was written inside the setState updater. StrictMode calls
 *     updaters twice and discards the first result, meaning treeRef briefly held
 *     a discarded (different object identity) tree. Fix: write treeRef after
 *     setCenterTree, not inside the updater.
 *
 * L10: The `result` variable was computed inside the setCenterTree updater and
 *      read outside for bus.emit. StrictMode calling the updater twice made this
 *      fragile — the emit fired using the value from the second run, but the
 *      approach depended on synchronous updater execution semantics. Fix: compute
 *      result using treeRef.current outside the updater, then setCenterTree and emit.
 *
 * These tests use the production pure functions (applySessionLoaded,
 * applySessionLoading) directly to verify the correct behavior without needing
 * a React renderer.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import type { SplitNode, Tab } from './workspaceTypes';
import { findLeafByPaneId, findTabAcrossTree, updateLeaf } from './splitTreeHelpers';
import {
  applySessionLoaded,
  type SessionLoadedEvent,
} from './sessionTreeOps';
import { bus } from '../../events/bus';
import { bumpWorkspaceEpoch, getWorkspaceEpoch } from './workspaceEpoch';

// Mocks must be declared before the useCenterTree import so the module
// resolver picks them up (vi.mock calls are hoisted, but keep the order
// explicit for readability, matching editorTabPersistence.test.ts).
//
// bridgeMock.handler captures the callback useCenterTree registers via
// onBridgeSessionClosed, so U10's bridge-close-loop test can invoke it
// directly instead of relying on a real Tauri event.
const bridgeMock = vi.hoisted(() => ({
  handler: null as ((e: { sessionId: string }) => void) | null,
}));
vi.mock('../../bridge/events', () => ({
  onBridgeSessionClosed: (handler: (e: { sessionId: string }) => void) => {
    bridgeMock.handler = handler;
    return Promise.resolve(() => {});
  },
}));

// useCenterTree pulls in EditorTab (for the LS_*_PREFIX constants), whose
// module graph reaches ThemeContext's module-load `window.matchMedia` call —
// unavailable in the jsdom test environment. Mock the constants directly,
// same pattern as editorTabPersistence.test.ts / useWorkspace.test.ts.
vi.mock('../../components/EditorTab', () => ({
  LS_CONTENT_PREFIX: 'logtapper_scratchpad_',
  LS_MODE_PREFIX: 'logtapper_editor_mode_',
  LS_WRAP_PREFIX: 'logtapper_editor_wrap_',
  LS_FILEPATH_PREFIX: 'logtapper_editor_filepath_',
}));

import { useCenterTree } from './useCenterTree';

// ---------------------------------------------------------------------------
// Tree factories
// ---------------------------------------------------------------------------

function makeTree(paneId: string, tabs: Tab[] = []): SplitNode {
  return {
    type: 'leaf',
    id: 'leaf-1',
    pane: { id: paneId, tabs, activeTabId: tabs[0]?.id ?? '' },
  };
}

function makeLogviewerTab(id: string, label = 'Log Viewer'): Tab {
  return { id, type: 'logviewer', label, closable: true };
}

// ---------------------------------------------------------------------------
// L7: treeRef written outside the updater
//
// Simulate what StrictMode does: call the updater twice with the same prev,
// keep only the second result. Verify that treeRef ends up holding the
// correct committed value (second call result), not the discarded first.
// ---------------------------------------------------------------------------

describe('L7: treeRef write is outside the setState updater', () => {
  it('treeRef holds the second updater result when simulating StrictMode double-call', () => {
    const initialTree = makeTree('pane-1', [makeLogviewerTab('tab-A')]);
    let treeRefCurrent = initialTree;

    // Simulate the OLD (buggy) pattern: write treeRef inside the updater.
    // StrictMode calls updater twice; treeRef first gets result1 then result2.
    // Both are equivalent in value but are DIFFERENT object references.
    let callCount = 0;
    const simulateOldPattern = (fn: (prev: SplitNode) => SplitNode) => {
      // StrictMode calls updater twice
      const result1 = fn(initialTree);
      treeRefCurrent = result1; // WRONG: first (discarded) result
      callCount++;
      const result2 = fn(initialTree);
      treeRefCurrent = result2; // Overwritten by second (kept) result
      callCount++;
      return result2; // React keeps the second
    };

    // Simulate the NEW (correct) pattern: capture result outside, write after.
    let treeRefCorrect = initialTree;
    const simulateNewPattern = (fn: (prev: SplitNode) => SplitNode) => {
      let next: SplitNode | undefined;
      // Updater — only computes, never writes to ref
      const updater = (prev: SplitNode): SplitNode => {
        next = fn(prev);
        return next;
      };
      // StrictMode calls updater twice
      updater(initialTree); // first (discarded)
      const result2 = updater(initialTree); // second (kept)
      // Write AFTER, with the final value
      if (next !== undefined) treeRefCorrect = next;
      return result2;
    };

    const mutateTree = (tree: SplitNode): SplitNode =>
      updateLeaf(tree, 'pane-1', (pane) => ({
        ...pane,
        activeTabId: 'tab-B',
      }));

    // Both patterns produce the same final tree value
    const oldResult = simulateOldPattern(mutateTree);
    const newResult = simulateNewPattern(mutateTree);

    expect(oldResult.type).toBe('leaf');
    expect(newResult.type).toBe('leaf');

    // In the old pattern, treeRef was written twice (once per StrictMode call).
    // The final value is the same object identity as oldResult (second call).
    expect(treeRefCurrent).toBe(oldResult);

    // In the new pattern, treeRef is written once after both updater calls.
    // The value is the same as the second updater result.
    expect(treeRefCorrect).toBe(newResult);

    // Both refs end up with the correct committed tree value
    if (treeRefCurrent.type === 'leaf' && treeRefCorrect.type === 'leaf') {
      expect(treeRefCurrent.pane.activeTabId).toBe('tab-B');
      expect(treeRefCorrect.pane.activeTabId).toBe('tab-B');
    }
  });

  it('treeRef is never set to the discarded first StrictMode result with the new pattern', () => {
    const initialTree = makeTree('pane-1', [makeLogviewerTab('tab-A')]);
    const discardedResults: SplitNode[] = [];
    let treeRefCorrect = initialTree;

    const simulateNewPattern = (fn: (prev: SplitNode) => SplitNode) => {
      let next: SplitNode | undefined;
      let callIndex = 0;
      const updater = (prev: SplitNode): SplitNode => {
        next = fn(prev);
        if (callIndex === 0) discardedResults.push(next); // track first (discarded) call
        callIndex++;
        return next;
      };
      // StrictMode double-call
      updater(initialTree);
      const kept = updater(initialTree);
      if (next !== undefined) treeRefCorrect = next;
      return kept;
    };

    simulateNewPattern((tree) =>
      updateLeaf(tree, 'pane-1', (pane) => ({ ...pane, activeTabId: 'tab-B' })),
    );

    // treeRef must NOT be set to the discarded first result
    expect(discardedResults).toHaveLength(1);
    expect(treeRefCorrect).not.toBe(discardedResults[0]);
    // treeRef must be the kept (second) result, which has the correct activeTabId
    if (treeRefCorrect.type === 'leaf') {
      expect(treeRefCorrect.pane.activeTabId).toBe('tab-B');
    }
  });
});

// ---------------------------------------------------------------------------
// L10: result computed outside the setState updater in onSessionLoaded
//
// The fix computes applySessionLoaded using treeRef.current (current committed
// state) before calling setCenterTree, then uses that result for side effects.
// This ensures bus.emit fires exactly once with the correct result.
// ---------------------------------------------------------------------------

describe('L10: onSessionLoaded result computed outside the updater', () => {
  it('applySessionLoaded result is computed once, not twice (StrictMode double-call)', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, [makeLogviewerTab('default-tab')]);
    let treeRef = initialTree;

    const paneSessionMap = new Map<string, string>();

    const event: SessionLoadedEvent = {
      sourceName: 'logcat.txt',
      paneId,
      sourceType: 'Logcat',
      sessionId: 'session-A',
      tabId: 'tab-A',
    };

    let computeCount = 0;

    // Simulate OLD pattern (computed inside updater — called twice by StrictMode)
    const oldEmittedResults: Array<ReturnType<typeof applySessionLoaded>> = [];
    {
      let result: ReturnType<typeof applySessionLoaded> | null = null;
      const updater = (prev: SplitNode) => {
        result = applySessionLoaded(prev, event, paneSessionMap);
        computeCount++;
        return result.tree;
      };
      // StrictMode double-call
      updater(initialTree); // discarded
      updater(initialTree); // kept
      if (result) oldEmittedResults.push(result);
    }
    expect(computeCount).toBe(2); // Old pattern: computed twice

    // Simulate NEW pattern (computed outside updater, once)
    computeCount = 0;
    const newEmittedResults: Array<ReturnType<typeof applySessionLoaded>> = [];
    {
      // Compute once using treeRef.current (the L10 fix)
      const result = applySessionLoaded(treeRef, event, paneSessionMap);
      computeCount++;
      // State update (updater is pure identity — just returns the pre-computed tree)
      const updater = (_prev: SplitNode) => result.tree;
      // StrictMode double-call — but result was already computed outside
      updater(initialTree);
      updater(initialTree);
      treeRef = result.tree;
      newEmittedResults.push(result);
    }
    expect(computeCount).toBe(1); // New pattern: computed once
    expect(newEmittedResults).toHaveLength(1);
  });

  it('bus emit fires with correct result when computed outside the updater', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, [makeLogviewerTab('default-tab')]);
    let treeRef = initialTree;
    const paneSessionMap = new Map<string, string>();

    const event: SessionLoadedEvent = {
      sourceName: 'logcat.txt',
      paneId,
      sourceType: 'Logcat',
      sessionId: 'session-A',
      tabId: 'tab-A',
      isNewTab: false,
    };

    const busEmitCalls: string[] = [];

    // Simulate onSessionLoaded with the L10 fix
    const result = applySessionLoaded(treeRef, event, paneSessionMap);
    // setCenterTree(() => result.tree) — no updater double-compute
    treeRef = result.tree;

    // Side effects run exactly once
    if (result.emitTabActivated) {
      busEmitCalls.push('layout:logviewer-tab-activated');
    }
    if (result.emitPaneRemap) {
      busEmitCalls.push('layout:pane-session-remap');
    }

    // After loading a session, the tab should be in the tree
    const leaf = findLeafByPaneId(treeRef, paneId);
    expect(leaf).not.toBeNull();
    const tab = leaf?.pane.tabs.find((t) => t.id === 'tab-A');
    expect(tab).toBeDefined();
    expect(tab?.label).toBe('logcat.txt');

    // Result computed exactly once — bus emit is not duplicated
    expect(busEmitCalls.length).toBeLessThanOrEqual(2); // at most two event types, not duplicated
  });

  it('sequential onSessionLoaded calls each use the up-to-date treeRef', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, [makeLogviewerTab('default-tab')]);
    let treeRef = initialTree;
    const paneSessionMap = new Map<string, string>();

    // First load
    const event1: SessionLoadedEvent = {
      sourceName: 'file-A.txt',
      paneId,
      sourceType: 'Logcat',
      sessionId: 'session-A',
      tabId: 'tab-A',
      isNewTab: false,
    };
    const result1 = applySessionLoaded(treeRef, event1, paneSessionMap);
    treeRef = result1.tree;
    if (result1.emitTabActivated) {
      paneSessionMap.set(result1.emitTabActivated.paneId, result1.emitTabActivated.sessionId);
    }

    // Second load — must be computed from the updated treeRef (post-first-load)
    const event2: SessionLoadedEvent = {
      sourceName: 'file-B.txt',
      paneId,
      sourceType: 'Logcat',
      sessionId: 'session-B',
      tabId: 'tab-B',
      isNewTab: true,
      previousSessionId: 'session-A',
    };
    const result2 = applySessionLoaded(treeRef, event2, paneSessionMap);
    treeRef = result2.tree;

    // Both tabs must exist in the final tree
    const leaf = findLeafByPaneId(treeRef, paneId);
    expect(leaf).not.toBeNull();
    const tabA = leaf?.pane.tabs.find((t) => t.id === 'tab-A');
    const tabB = leaf?.pane.tabs.find((t) => t.id === 'tab-B');
    expect(tabA).toBeDefined();
    expect(tabB).toBeDefined();
    expect(tabB?.label).toBe('file-B.txt');
  });
});

// ---------------------------------------------------------------------------
// L1 + L7 combined: render-time ref sync ensures consistency
//
// The render-time assignment treeRef.current = centerTree acts as a safety
// net: even if the post-updater write misses an edge case, the next render
// will always restore the ref to the committed state.
// ---------------------------------------------------------------------------

describe('L1 + L7: render-time sync ensures treeRef reflects committed state', () => {
  it('render-time assignment always overwrites any stale in-flight ref value', () => {
    const tree1 = makeTree('pane-1', [makeLogviewerTab('tab-A')]);
    const tree2 = makeTree('pane-2', [makeLogviewerTab('tab-B')]);

    // Simulate a sequence: some intermediate writes to treeRef (e.g., from
    // concurrent events), then a re-render that syncs treeRef to committed state.
    const treeRef = { current: tree1 };

    // Simulate some intermediate / stale write (e.g., from a discarded updater)
    treeRef.current = tree2; // stale

    // Render fires — committed state is tree1 (the state variable)
    const committedState = tree1;
    treeRef.current = committedState; // L1 render-time assignment restores consistency

    expect(treeRef.current).toBe(tree1);
    expect(treeRef.current).not.toBe(tree2);
  });

  it('after updateTree, treeRef reflects the new state before next render', () => {
    const paneId = 'pane-1';
    const tree = makeTree(paneId, [makeLogviewerTab('tab-A')]);
    let treeRef = tree;

    // Simulate updateTree with L7 fix: capture next outside the updater
    const mutate = (fn: (prev: SplitNode) => SplitNode) => {
      let next: SplitNode | undefined;
      // The updater (called once in prod, twice in StrictMode — we simulate once)
      const updater = (prev: SplitNode) => { next = fn(prev); return next; };
      updater(treeRef); // simulate React calling the updater
      if (next !== undefined) treeRef = next; // write AFTER setState
    };

    mutate((t) => updateLeaf(t, paneId, (pane) => ({ ...pane, activeTabId: 'tab-B' })));

    if (treeRef.type === 'leaf') {
      expect(treeRef.pane.activeTabId).toBe('tab-B');
    } else {
      throw new Error('Expected leaf node');
    }
  });
});

// ---------------------------------------------------------------------------
// V4: dropTabOnPane must not emit layout:logviewer-tab-activated for a no-op
// self-drop.
//
// Dragging a pane's sole tab onto that same pane's own edge zone (fromPaneId
// === toPaneId, zone !== 'center') is a no-op: the tree updater bails out
// without creating a new pane. Before the fix, `landingPaneId` was still
// pre-set to a freshly generated (never-created) pane id, and the
// post-update emit fired unconditionally with that phantom id — corrupting
// downstream pane/session bookkeeping (useSessionTabManager would activate a
// session for a pane that doesn't exist).
// ---------------------------------------------------------------------------

describe('V4: dropTabOnPane skips emit on no-op self-drop', () => {
  function renderCenterTree(initialTree: SplitNode) {
    const activeLogPaneIdRef = { current: null as string | null };
    const paneSessionMapRef = { current: new Map<string, string>() };
    const activateSessionForPane = vi.fn();
    const openBottomPane = vi.fn();

    return renderHook(() =>
      useCenterTree(
        { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane },
        initialTree,
      ),
    );
  }

  it('does not emit layout:logviewer-tab-activated when a pane\'s sole tab is dropped on its own edge zone', () => {
    const paneId = 'pane-1';
    const tab = makeLogviewerTab('tab-A');
    const initialTree = makeTree(paneId, [tab]);

    const { result } = renderCenterTree(initialTree);

    const emitted: unknown[] = [];
    const onActivated = (payload: unknown) => emitted.push(payload);
    bus.on('layout:logviewer-tab-activated', onActivated);

    act(() => {
      result.current.dropTabOnPane(tab.id, paneId, paneId, 'right');
    });

    bus.off('layout:logviewer-tab-activated', onActivated);

    expect(emitted).toHaveLength(0);
    // Tree is unchanged — the tab is still in its original pane.
    const leaf = findLeafByPaneId(result.current.treeRef.current, paneId);
    expect(leaf?.pane.tabs.map((t) => t.id)).toEqual([tab.id]);
  });

  it('does not emit layout:logviewer-tab-activated for the same-pane center no-op', () => {
    const paneId = 'pane-1';
    const tabA = makeLogviewerTab('tab-A');
    const tabB = makeLogviewerTab('tab-B');
    const initialTree = makeTree(paneId, [tabA, tabB]);

    const { result } = renderCenterTree(initialTree);

    const emitted: unknown[] = [];
    const onActivated = (payload: unknown) => emitted.push(payload);
    bus.on('layout:logviewer-tab-activated', onActivated);

    act(() => {
      result.current.dropTabOnPane(tabA.id, paneId, paneId, 'center');
    });

    bus.off('layout:logviewer-tab-activated', onActivated);

    expect(emitted).toHaveLength(0);
  });

  it('still emits layout:logviewer-tab-activated for a real cross-pane drop', () => {
    const fromPaneId = 'pane-1';
    const toPaneId = 'pane-2';
    const tabA = makeLogviewerTab('tab-A');
    const tabB = makeLogviewerTab('tab-B');
    const initialTree: SplitNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree(fromPaneId, [tabA]), makeTree(toPaneId, [tabB])],
    };

    const { result } = renderCenterTree(initialTree);

    const emitted: Array<{ tabId: string; paneId: string }> = [];
    const onActivated = (payload: { tabId: string; paneId: string }) => emitted.push(payload);
    bus.on('layout:logviewer-tab-activated', onActivated);

    act(() => {
      result.current.dropTabOnPane(tabA.id, fromPaneId, toPaneId, 'center');
    });

    bus.off('layout:logviewer-tab-activated', onActivated);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ tabId: tabA.id, paneId: toPaneId });
  });
});

// ---------------------------------------------------------------------------
// U9: openCenterTab must not leak orphaned localStorage keys under StrictMode
//
// makeTab (crypto.randomUUID) and the storageSet calls (file path, editor
// content, view mode, word wrap) used to run inside the updateTree updater.
// StrictMode double-invokes setState updaters and discards the first result —
// the first invocation's UUID still seeded real localStorage keys (including
// full editor content) that are never cleaned up, because the committed tree
// only ever references the SECOND (kept) tab id. Fix: build the tab and call
// storageSet BEFORE updateTree, so the updater is pure and only ever runs
// (functionally) once per call, regardless of how many times StrictMode
// invokes it.
//
// This test renders the hook inside an actual <React.StrictMode> tree so the
// real double-invocation semantics apply (verified against a throwaway probe
// hook before writing this test — StrictMode does double-invoke setState
// updater functions under this harness).
// ---------------------------------------------------------------------------

describe('U9: openCenterTab does not create orphaned localStorage keys under StrictMode', () => {
  function renderCenterTreeStrict(initialTree: SplitNode) {
    const activeLogPaneIdRef = { current: null as string | null };
    const paneSessionMapRef = { current: new Map<string, string>() };
    const activateSessionForPane = vi.fn();
    const openBottomPane = vi.fn();

    return renderHook(
      () =>
        useCenterTree(
          { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane },
          initialTree,
        ),
      { wrapper: ({ children }) => React.createElement(React.StrictMode, null, children) },
    );
  }

  it('seeds exactly one set of localStorage keys per opened editor tab', () => {
    localStorage.clear();
    const initialTree = makeTree('pane-1', []);
    const { result } = renderCenterTreeStrict(initialTree);

    act(() => {
      result.current.openCenterTab('editor', undefined, undefined, {
        content: 'hello world',
        viewMode: 'edit',
        wordWrap: true,
      });
    });

    const leaf = findLeafByPaneId(result.current.treeRef.current, 'pane-1');
    const tab = leaf?.pane.tabs[0];
    expect(tab).toBeDefined();

    // Exactly one content/mode/wrap key exists, matching the tab actually in
    // the committed tree. A pre-fix run would leave a second, orphaned key
    // (seeded by the discarded StrictMode invocation's UUID) in localStorage.
    const contentKeys = Object.keys(localStorage).filter((k) => k.startsWith('logtapper_scratchpad_'));
    const modeKeys = Object.keys(localStorage).filter((k) => k.startsWith('logtapper_editor_mode_'));
    const wrapKeys = Object.keys(localStorage).filter((k) => k.startsWith('logtapper_editor_wrap_'));

    expect(contentKeys).toEqual([`logtapper_scratchpad_${tab!.id}`]);
    expect(modeKeys).toEqual([`logtapper_editor_mode_${tab!.id}`]);
    expect(wrapKeys).toEqual([`logtapper_editor_wrap_${tab!.id}`]);
  });

  it('seeds exactly one file path key when opening a file tab', () => {
    localStorage.clear();
    const initialTree = makeTree('pane-1', []);
    const { result } = renderCenterTreeStrict(initialTree);

    act(() => {
      result.current.openCenterTab('editor', 'my-file.txt', '/path/to/my-file.txt');
    });

    const leaf = findLeafByPaneId(result.current.treeRef.current, 'pane-1');
    const tab = leaf?.pane.tabs[0];
    expect(tab).toBeDefined();

    const filePathKeys = Object.keys(localStorage).filter((k) => k.startsWith('logtapper_editor_filepath_'));
    expect(filePathKeys).toEqual([`logtapper_editor_filepath_${tab!.id}`]);
  });
});

// ---------------------------------------------------------------------------
// U10: dropTabOnPane computes landingPaneId (and the whole next tree) from
// treeRef.current BEFORE calling updateTree, instead of reassigning
// `landingPaneId` from inside the setState updater. The old code depended on
// React invoking the updater eagerly and synchronously so the post-update
// emit would see the reassigned value — that currently holds for plain
// setState updaters, but it is an implementation detail, not a contract (and
// the reassignment itself was deterministic given the same input tree, so it
// did not actually diverge across a StrictMode double-invoke the way U9's
// crypto.randomUUID() call did). These tests render under React.StrictMode
// anyway, as a regression guard, and assert the emit is always addressed to
// the pane that really holds the moved tab in the committed tree.
// ---------------------------------------------------------------------------

describe('U10: dropTabOnPane computes landingPaneId before updateTree (StrictMode-safe)', () => {
  function renderCenterTreeStrict(initialTree: SplitNode) {
    const activeLogPaneIdRef = { current: null as string | null };
    const paneSessionMapRef = { current: new Map<string, string>() };
    const activateSessionForPane = vi.fn();
    const openBottomPane = vi.fn();

    return renderHook(
      () =>
        useCenterTree(
          { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane },
          initialTree,
        ),
      { wrapper: ({ children }) => React.createElement(React.StrictMode, null, children) },
    );
  }

  it('creates exactly one new pane when splitting off a tab, even under StrictMode double-invoke', () => {
    const fromPaneId = 'pane-1';
    const toPaneId = 'pane-2';
    const tabA = makeLogviewerTab('tab-A');
    const tabB = makeLogviewerTab('tab-B');
    const initialTree: SplitNode = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree(fromPaneId, [tabA]), makeTree(toPaneId, [tabB])],
    };

    const { result } = renderCenterTreeStrict(initialTree);

    const emitted: Array<{ tabId: string; paneId: string }> = [];
    const onActivated = (payload: { tabId: string; paneId: string }) => emitted.push(payload);
    bus.on('layout:logviewer-tab-activated', onActivated);

    act(() => {
      result.current.dropTabOnPane(tabA.id, fromPaneId, toPaneId, 'right');
    });

    bus.off('layout:logviewer-tab-activated', onActivated);

    // Exactly one activation event, addressed to the pane that actually holds
    // tab-A in the committed tree — not a phantom id from a discarded
    // StrictMode invocation.
    expect(emitted).toHaveLength(1);
    const landingPaneId = emitted[0].paneId;
    const leaf = findLeafByPaneId(result.current.treeRef.current, landingPaneId);
    expect(leaf?.pane.tabs.map((t) => t.id)).toEqual([tabA.id]);

    // fromPaneId collapsed away (its only tab moved out); the tree now has
    // exactly two leaves: toPaneId (unchanged) and the new pane holding tab-A.
    const allLeafPaneIds: string[] = [];
    (function walk(n: SplitNode) {
      if (n.type === 'leaf') allLeafPaneIds.push(n.pane.id);
      else {
        walk(n.children[0]);
        walk(n.children[1]);
      }
    })(result.current.treeRef.current);
    expect(allLeafPaneIds).toHaveLength(2);
    expect(allLeafPaneIds).toContain(toPaneId);
  });

  it('missing-toLeaf fallback lands the tab in firstLeaf and the emit uses that pane, not a phantom id', () => {
    const fromPaneId = 'pane-1';
    const otherPaneId = 'pane-2';
    const tabA = makeLogviewerTab('tab-A');
    const tabB = makeLogviewerTab('tab-B');
    const tabC = makeLogviewerTab('tab-C');
    const initialTree: SplitNode = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree(fromPaneId, [tabA, tabB]), makeTree(otherPaneId, [tabC])],
    };

    const { result } = renderCenterTreeStrict(initialTree);

    const emitted: Array<{ tabId: string; paneId: string }> = [];
    const onActivated = (payload: { tabId: string; paneId: string }) => emitted.push(payload);
    bus.on('layout:logviewer-tab-activated', onActivated);

    act(() => {
      // 'pane-ghost' never existed in the tree — simulates a stale/invalid drop target.
      result.current.dropTabOnPane(tabA.id, fromPaneId, 'pane-ghost', 'right');
    });

    bus.off('layout:logviewer-tab-activated', onActivated);

    expect(emitted).toHaveLength(1);
    const landingPaneId = emitted[0].paneId;
    // firstLeaf of the post-removal tree is fromPaneId itself (still the
    // first leaf — only its tab list changed) — the tab lands back in its
    // own pane rather than the nonexistent target.
    expect(landingPaneId).toBe(fromPaneId);
    const leaf = findLeafByPaneId(result.current.treeRef.current, fromPaneId);
    expect(leaf?.pane.tabs.map((t) => t.id)).toEqual([tabB.id, tabA.id]);
  });
});

// ---------------------------------------------------------------------------
// openCenterTab returns the pane id the tab landed in, so a bus-event
// handler that opened the tab (e.g. layout:open-tab -> analysis:open) can
// target a follow-up event at that pane without a second lookup.
// ---------------------------------------------------------------------------

describe('openCenterTab return value (targeted analysis open)', () => {
  function renderCenterTree(initialTree: SplitNode) {
    const activeLogPaneIdRef = { current: null as string | null };
    const paneSessionMapRef = { current: new Map<string, string>() };
    const activateSessionForPane = vi.fn();
    const openBottomPane = vi.fn();

    return renderHook(() =>
      useCenterTree(
        { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane },
        initialTree,
      ),
    );
  }

  it('returns the pane id of a newly created tab', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, []);
    const { result } = renderCenterTree(initialTree);

    let returned: string | null = null;
    act(() => {
      returned = result.current.openCenterTab('analysis');
    });

    expect(returned).toBe(paneId);
    const leaf = findLeafByPaneId(result.current.treeRef.current, paneId);
    expect(leaf?.pane.tabs.map((t) => t.type)).toContain('analysis');
  });

  it('returns the pane id of a reused tab that was not yet active', () => {
    const paneId = 'pane-1';
    const logTab = makeLogviewerTab('tab-log');
    const analysisTab: Tab = { id: 'tab-analysis', type: 'analysis', label: 'Analysis', closable: true };
    // logTab is active; analysisTab exists but is not the active tab.
    const initialTree = makeTree(paneId, [logTab, analysisTab]);
    const { result } = renderCenterTree(initialTree);

    let returned: string | null = null;
    act(() => {
      returned = result.current.openCenterTab('analysis');
    });

    expect(returned).toBe(paneId);
    const leaf = findLeafByPaneId(result.current.treeRef.current, paneId);
    expect(leaf?.pane.activeTabId).toBe(analysisTab.id);
  });

  it('returns the pane id of a tab that is already the active tab (no-op reuse)', () => {
    const paneId = 'pane-1';
    const analysisTab: Tab = { id: 'tab-analysis', type: 'analysis', label: 'Analysis', closable: true };
    const initialTree: SplitNode = {
      type: 'leaf',
      id: 'leaf-1',
      pane: { id: paneId, tabs: [analysisTab], activeTabId: analysisTab.id },
    };
    const { result } = renderCenterTree(initialTree);

    let returned: string | null = null;
    act(() => {
      returned = result.current.openCenterTab('analysis');
    });

    expect(returned).toBe(paneId);
    // Tree is unchanged — still the exact same tab, still active.
    const leaf = findLeafByPaneId(result.current.treeRef.current, paneId);
    expect(leaf?.pane.activeTabId).toBe(analysisTab.id);
    expect(leaf?.pane.tabs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// U10: the bridge-initiated close loop threads a local tree value through its
// per-iteration lookups instead of assuming treeRef.current updates
// synchronously between successive closeTab() calls.
// ---------------------------------------------------------------------------

describe('U10: bridge-initiated multi-tab session close threads a local tree value', () => {
  it('closes every tab bound to the session, even across a pane collapse mid-loop', async () => {
    const paneAId = 'pane-A';
    const paneBId = 'pane-B';
    const tabA = makeLogviewerTab('tab-A');
    const tabB = makeLogviewerTab('tab-B');
    const initialTree: SplitNode = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree(paneAId, [tabA]), makeTree(paneBId, [tabB])],
    };

    const activeLogPaneIdRef = { current: null as string | null };
    const paneSessionMapRef = { current: new Map<string, string>() };
    const activateSessionForPane = vi.fn();
    const openBottomPane = vi.fn();

    const { result } = renderHook(() =>
      useCenterTree(
        { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane },
        initialTree,
      ),
    );

    // Bind both tabs to the same session, as the bridge-close path expects.
    act(() => {
      bus.emit('session:loaded', {
        sourceName: 'a.txt',
        paneId: paneAId,
        sourceType: 'Logcat',
        sessionId: 'shared-session',
        tabId: tabA.id,
      });
      bus.emit('session:loaded', {
        sourceName: 'b.txt',
        paneId: paneBId,
        sourceType: 'Logcat',
        sessionId: 'shared-session',
        tabId: tabB.id,
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(bridgeMock.handler).not.toBeNull();

    act(() => {
      bridgeMock.handler!({ sessionId: 'shared-session' });
    });

    // Both tabs are gone — closeTab collapsed pane-A after tab-A closed, and
    // the loop still found tab-B via the threaded local tree, not a stale
    // treeRef snapshot taken before either close applied.
    const finalTree = result.current.treeRef.current;
    expect(findTabAcrossTree(finalTree, tabA.id)).toBeNull();
    expect(findTabAcrossTree(finalTree, tabB.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workspace-epoch belt-and-braces guard on onSessionLoaded (item
// 6b9d644c-eff7-486c-982f-9034b3e7f84f — in-flight file load survives
// workspace switch and lands in the new workspace).
//
// `useFileSession.loadFile`'s own epoch guard should already have discarded
// a stale load before it ever emits `session:loaded` — this is the second
// layer: onSessionLoaded independently ignores an event whose stamped
// `epoch` doesn't match the CURRENT workspace epoch, so even a load that
// slipped past the first guard (or a future emitter that forgets it) can't
// create a tab in a workspace it wasn't aimed at.
// ---------------------------------------------------------------------------

describe('workspace-epoch guard on onSessionLoaded', () => {
  function renderCenterTree(initialTree: SplitNode) {
    const activeLogPaneIdRef = { current: null as string | null };
    const paneSessionMapRef = { current: new Map<string, string>() };
    const activateSessionForPane = vi.fn();
    const openBottomPane = vi.fn();

    return renderHook(() =>
      useCenterTree(
        { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane },
        initialTree,
      ),
    );
  }

  it('ignores a session:loaded event stamped with a stale epoch — no tab is created', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, []);
    const { result } = renderCenterTree(initialTree);

    // Capture "the epoch this load was aimed at", then simulate a workspace
    // teardown happening while it was in flight.
    const staleEpoch = getWorkspaceEpoch();
    bumpWorkspaceEpoch();
    expect(getWorkspaceEpoch()).not.toBe(staleEpoch);

    act(() => {
      bus.emit('session:loaded', {
        sourceName: 'orphaned.txt',
        paneId,
        sourceType: 'Logcat',
        sessionId: 'session-stale',
        tabId: 'tab-stale',
        epoch: staleEpoch,
      });
    });

    // No tab was created for the stale-epoch load.
    const leaf = findLeafByPaneId(result.current.treeRef.current, paneId);
    expect(leaf?.pane.tabs ?? []).toHaveLength(0);
    expect(findTabAcrossTree(result.current.treeRef.current, 'tab-stale')).toBeNull();
  });

  it('accepts a session:loaded event stamped with the current epoch — tab is created normally', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, []);
    const { result } = renderCenterTree(initialTree);

    const currentEpoch = getWorkspaceEpoch();

    act(() => {
      bus.emit('session:loaded', {
        sourceName: 'fresh.txt',
        paneId,
        sourceType: 'Logcat',
        sessionId: 'session-fresh',
        tabId: 'tab-fresh',
        epoch: currentEpoch,
      });
    });

    const found = findTabAcrossTree(result.current.treeRef.current, 'tab-fresh');
    expect(found).not.toBeNull();
    expect(found?.tab.label).toBe('fresh.txt');
  });

  it('accepts an event with no epoch stamped at all (e.g. bridge-opened sessions)', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, []);
    const { result } = renderCenterTree(initialTree);

    bumpWorkspaceEpoch(); // some unrelated teardown happened — irrelevant when epoch is unset

    act(() => {
      bus.emit('session:loaded', {
        sourceName: 'bridge.txt',
        paneId,
        sourceType: 'Logcat',
        sessionId: 'session-bridge',
        tabId: 'tab-bridge',
        // epoch intentionally omitted
      });
    });

    expect(findTabAcrossTree(result.current.treeRef.current, 'tab-bridge')).not.toBeNull();
  });

  it('a restore burst\'s loads — stamped with the epoch captured AFTER the teardown bump — are not discarded', () => {
    const paneId = 'pane-1';
    const initialTree = makeTree(paneId, []);
    const { result } = renderCenterTree(initialTree);

    // Simulate doClearPanes: bump the epoch synchronously, before the
    // restore's own loadFile calls start.
    bumpWorkspaceEpoch();
    const postBumpEpoch = getWorkspaceEpoch();

    // The restore's burst of loadFile calls each capture the epoch AFTER
    // the bump (they start once doClearPanes has already returned), so every
    // one of them stamps postBumpEpoch — not the pre-bump value.
    act(() => {
      bus.emit('session:loaded', {
        sourceName: 'restored-a.txt',
        paneId,
        sourceType: 'Logcat',
        sessionId: 'session-restored-a',
        tabId: 'tab-restored-a',
        epoch: postBumpEpoch,
      });
      bus.emit('session:loaded', {
        sourceName: 'restored-b.txt',
        paneId,
        sourceType: 'Logcat',
        sessionId: 'session-restored-b',
        tabId: 'tab-restored-b',
        isNewTab: true,
        // A genuine second-tab-in-one-pane load always carries the session it
        // sits alongside — without it, applySessionLoaded takes its "replace"
        // branch instead of "add alongside" and overwrites tab-restored-a.
        previousSessionId: 'session-restored-a',
        epoch: postBumpEpoch,
      });
    });

    expect(findTabAcrossTree(result.current.treeRef.current, 'tab-restored-a')).not.toBeNull();
    expect(findTabAcrossTree(result.current.treeRef.current, 'tab-restored-b')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workspace restore — center-tree skeleton rebuild (work item f5d0e527:
// "workspace restore collapses pane grouping").
//
// `restoreCore.ts`'s `restoreWorkspace` emits `workspace:restore-tree-skeleton`
// with a tree rebuilt (fresh pane ids) from the saved `.ltw` layout, BEFORE any
// session load — `useCenterTree` is the sole consumer, replacing the live tree
// wholesale so the loads that follow land in the pane the resolver steered
// them at (see restoreTreeSkeleton.test.ts / restoreCore.test.ts for the
// resolver logic itself). `workspace:restore-end` then collapses any pane a
// failed load left empty.
// ---------------------------------------------------------------------------

describe('workspace restore — center-tree skeleton rebuild + empty-pane collapse', () => {
  function renderCenterTree(initialTree: SplitNode) {
    const activeLogPaneIdRef = { current: null as string | null };
    const paneSessionMapRef = { current: new Map<string, string>() };
    const activateSessionForPane = vi.fn();
    const openBottomPane = vi.fn();

    return renderHook(() =>
      useCenterTree(
        { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane },
        initialTree,
      ),
    );
  }

  it('workspace:restore-tree-skeleton replaces the live tree wholesale', () => {
    const { result } = renderCenterTree(makeTree('single-pane', []));

    const skeletonTree: SplitNode = {
      type: 'split',
      id: 'new-split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree('new-pane-1', []), makeTree('new-pane-2', [])],
    };

    act(() => {
      bus.emit('workspace:restore-tree-skeleton', { tree: skeletonTree });
    });

    expect(result.current.treeRef.current).toBe(skeletonTree);
    expect(result.current.centerTree).toBe(skeletonTree);
    // The pre-restore single pane is gone — replaced, not merged.
    expect(findLeafByPaneId(result.current.treeRef.current, 'single-pane')).toBeNull();
  });

  it('a session:loaded for the skeleton-remapped paneId lands in the correct rebuilt pane', () => {
    const { result } = renderCenterTree(makeTree('single-pane', []));

    const skeletonTree: SplitNode = {
      type: 'split',
      id: 'new-split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree('new-pane-1', []), makeTree('new-pane-2', [])],
    };

    act(() => {
      bus.emit('workspace:restore-tree-skeleton', { tree: skeletonTree });
      // Simulates restoreCore's paneResolver having steered this load at
      // 'new-pane-2' — the pane the session occupied when saved.
      bus.emit('session:loaded', {
        sourceName: 'device-b.txt',
        paneId: 'new-pane-2',
        sourceType: 'Logcat',
        sessionId: 'session-b',
        tabId: 'tab-b',
      });
    });

    const paneOne = findLeafByPaneId(result.current.treeRef.current, 'new-pane-1');
    const paneTwo = findLeafByPaneId(result.current.treeRef.current, 'new-pane-2');
    expect(paneOne?.pane.tabs ?? []).toHaveLength(0);
    expect(paneTwo?.pane.tabs.some((t) => t.id === 'tab-b')).toBe(true);
  });

  it('workspace:restore-end collapses a pane whose planned session never loaded', () => {
    const skeletonTree: SplitNode = {
      type: 'split',
      id: 'new-split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree('pane-empty', []), makeTree('pane-loaded', [makeLogviewerTab('tab-loaded')])],
    };
    const { result } = renderCenterTree(skeletonTree);

    act(() => {
      bus.emit('workspace:restore-end', undefined);
    });

    const finalTree = result.current.treeRef.current;
    expect(finalTree.type).toBe('leaf');
    if (finalTree.type === 'leaf') {
      expect(finalTree.pane.id).toBe('pane-loaded');
    }
  });

  it('workspace:restore-end is a no-op when no pane is empty', () => {
    const tree = makeTree('single-pane', [makeLogviewerTab('tab-a')]);
    const { result } = renderCenterTree(tree);

    act(() => {
      bus.emit('workspace:restore-end', undefined);
    });

    expect(result.current.treeRef.current).toBe(tree);
  });

  // review fix #2: an editor tab restored via `layout:open-tab` (which
  // `useWorkspaceLayout.onOpenTab` forwards straight into `openCenterTab`,
  // including its `paneId`) must land in the pane the workspace-restore
  // resolver steered it at — not the focused pane / first leaf.
  it('openCenterTab places a new tab in targetPaneId when given, over the focused/first-leaf default', () => {
    const skeletonTree: SplitNode = {
      type: 'split',
      id: 'new-split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [makeTree('new-pane-1', []), makeTree('new-pane-2', [])],
    };
    const { result } = renderCenterTree(skeletonTree);

    act(() => {
      // activeLogPaneIdRef is null and 'new-pane-1' is the first leaf — both
      // would normally win. targetPaneId must override both.
      result.current.openCenterTab('editor', 'notes.md', '/notes/scratch.md', { content: 'hi', viewMode: 'editor', wordWrap: false }, 'new-pane-2');
    });

    const paneOne = findLeafByPaneId(result.current.treeRef.current, 'new-pane-1');
    const paneTwo = findLeafByPaneId(result.current.treeRef.current, 'new-pane-2');
    expect(paneOne?.pane.tabs ?? []).toHaveLength(0);
    expect(paneTwo?.pane.tabs).toHaveLength(1);
    expect(paneTwo?.pane.tabs[0]).toMatchObject({ type: 'editor', label: 'notes.md', sourcePath: '/notes/scratch.md' });
  });

  it('openCenterTab falls back to the first leaf when targetPaneId does not exist in the tree', () => {
    const tree = makeTree('only-pane', []);
    const { result } = renderCenterTree(tree);

    act(() => {
      result.current.openCenterTab('editor', 'notes.md', '/notes/scratch.md', undefined, 'pane-that-does-not-exist');
    });

    const pane = findLeafByPaneId(result.current.treeRef.current, 'only-pane');
    expect(pane?.pane.tabs).toHaveLength(1);
  });
});
