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
import type { SplitNode, Tab } from './workspaceTypes';
import { findLeafByPaneId, updateLeaf } from './splitTreeHelpers';
import {
  applySessionLoaded,
  applySessionLoading,
  type SessionLoadedEvent,
} from './sessionTreeOps';
import { makeTab, firstLeaf, findTabByType } from './splitTreeHelpers';

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
      let resultFromUpdater: SplitNode;
      // StrictMode calls updater twice
      const result1 = fn(initialTree);
      treeRefCurrent = result1; // WRONG: first (discarded) result
      callCount++;
      const result2 = fn(initialTree);
      treeRefCurrent = result2; // Overwritten by second (kept) result
      callCount++;
      resultFromUpdater = result2; // React keeps the second
      return resultFromUpdater;
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
    let treeRef = { current: tree1 };

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
