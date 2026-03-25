/**
 * Tests for the tab→session mapping lifecycle managed by useCenterTree.
 *
 * The workspace tree owns a `tabSessionMapRef` that maps each logviewer tab ID
 * to its backend session ID. This mapping is critical for tab switching — when
 * the user activates a tab, the workspace emits `layout:logviewer-tab-activated`
 * with `sessionId = tabSessionMapRef.get(tabId)`. If the mapping is missing or
 * wrong, `activateSessionForPane` is not called and the pane continues showing
 * the wrong session.
 *
 * These tests call the production pure functions (applySessionLoading,
 * applySessionLoaded) from sessionTreeOps.ts directly — one source of truth.
 */
import { describe, it, expect } from 'vitest';
import type { SplitNode, Tab } from './workspaceTypes';
import { findLeafByPaneId, updateLeaf } from './splitTreeHelpers';
import {
  applySessionLoading,
  applySessionLoaded,
  resolveFocusedTab,
  type SessionLoadingEvent,
  type SessionLoadedEvent,
  type SessionLoadedResult,
} from './sessionTreeOps';

// ---------------------------------------------------------------------------
// Thin orchestrator — wires production functions with the Maps that
// useCenterTree manages via refs. No duplicated logic.
// ---------------------------------------------------------------------------

function createTabSessionLifecycle(initialTree: SplitNode) {
  let tree = initialTree;
  const tabSessionMap = new Map<string, string>();
  const paneSessionMap = new Map<string, string>();
  let focusedLogviewerTabId: string | null = null;

  /** Apply session:loading via the production function. */
  function onSessionLoading(e: SessionLoadingEvent): void {
    tree = applySessionLoading(tree, e);
  }

  /** Apply session:loaded via the production function + map side effects. */
  function onSessionLoaded(e: SessionLoadedEvent): SessionLoadedResult {
    const result = applySessionLoaded(tree, e, paneSessionMap);
    tree = result.tree;

    // Side effects that useCenterTree performs after applySessionLoaded:
    tabSessionMap.set(e.tabId, e.sessionId);
    if (result.tabIdToDelete) tabSessionMap.delete(result.tabIdToDelete);

    return result;
  }

  function onSessionFocused(paneId: string | null): void {
    focusedLogviewerTabId = paneId ? resolveFocusedTab(tree, paneId) : null;
  }

  /**
   * Simulate the full file-open flow: session:loading (early tab creation)
   * followed by session:loaded (binding the session).
   * Mirrors useFileSession.loadFile → bus.emit('session:loading') → ... →
   * bus.emit('session:loaded') → bus.emit('session:focused').
   */
  function loadFile(opts: {
    paneId: string;
    tabId: string;
    sessionId: string;
    sourceName: string;
    sourceType?: string;
    isNewTab: boolean;
    previousSessionId?: string;
    readOnly?: boolean;
  }): SessionLoadedResult {
    // Step 1: session:loading (immediate tab creation for loading feedback)
    onSessionLoading({
      paneId: opts.paneId,
      tabId: opts.tabId,
      label: opts.sourceName,
      isNewTab: opts.isNewTab,
    });

    // Step 2: if not isNewTab, useFileSession calls activateSessionForPane directly
    if (!opts.isNewTab) {
      paneSessionMap.set(opts.paneId, opts.sessionId);
    }

    // Step 3: session:loaded (tree update + tab→session map)
    // Emitted BEFORE session:focused so the tree has the new tab when focus resolves.
    const result = onSessionLoaded({
      sourceName: opts.sourceName,
      paneId: opts.paneId,
      sourceType: opts.sourceType ?? 'Logcat',
      sessionId: opts.sessionId,
      tabId: opts.tabId,
      isNewTab: opts.isNewTab,
      previousSessionId: opts.previousSessionId,
      readOnly: opts.readOnly,
    });

    // For isNewTab, activation happens via the emitted tabActivated event
    if (result.emitTabActivated) {
      paneSessionMap.set(result.emitTabActivated.paneId, result.emitTabActivated.sessionId);
    }
    if (result.emitPaneRemap) {
      paneSessionMap.set(result.emitPaneRemap.actualPaneId, result.emitPaneRemap.sessionId);
    }

    // Step 4: session:focused (sets the blue underline focus marker)
    onSessionFocused(opts.paneId);

    return result;
  }

  /**
   * Simulate stream open flow: no session:loading (streams don't emit it),
   * just session:loaded then session:focused. Mirrors useStreamSession.startStream.
   */
  function loadStream(opts: {
    paneId: string;
    tabId: string;
    sessionId: string;
    sourceName: string;
    isNewTab: boolean;
    previousSessionId?: string;
  }): SessionLoadedResult {
    // Streams call activateSessionForPane unconditionally (not just for !isNewTab)
    paneSessionMap.set(opts.paneId, opts.sessionId);

    const result = onSessionLoaded({
      sourceName: opts.sourceName,
      paneId: opts.paneId,
      sourceType: 'Logcat',
      sessionId: opts.sessionId,
      tabId: opts.tabId,
      isNewTab: opts.isNewTab,
      previousSessionId: opts.previousSessionId,
    });

    if (result.emitTabActivated) {
      paneSessionMap.set(result.emitTabActivated.paneId, result.emitTabActivated.sessionId);
    }
    if (result.emitPaneRemap) {
      paneSessionMap.set(result.emitPaneRemap.actualPaneId, result.emitPaneRemap.sessionId);
    }

    onSessionFocused(opts.paneId);
    return result;
  }

  /**
   * Simulate what happens when user clicks a tab (setActiveTab in useCenterTree).
   * Returns the sessionId that would be passed to activateSessionForPane, or null
   * if the tab is not a logviewer or is already active.
   */
  function switchToTab(tabId: string, paneId: string): string | null {
    const leaf = findLeafByPaneId(tree, paneId);
    if (!leaf) return null;
    const tab = leaf.pane.tabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== 'logviewer') return null;
    if (leaf.pane.activeTabId === tabId) return null;

    // Update active tab in tree
    tree = updateLeaf(tree, paneId, (pane) => ({ ...pane, activeTabId: tabId }));

    // Look up session from tabSessionMap (this is what useCenterTree does)
    const sessionId = tabSessionMap.get(tabId) ?? '';
    if (!sessionId) return null;

    // In real code, this emits layout:logviewer-tab-activated → handleTabActivated
    // which calls activateSessionForPane
    paneSessionMap.set(paneId, sessionId);
    return sessionId;
  }

  return {
    get tree() { return tree; },
    get focusedLogviewerTabId() { return focusedLogviewerTabId; },
    tabSessionMap,
    paneSessionMap,
    loadFile,
    loadStream,
    switchToTab,
    onSessionFocused,
    onSessionLoading,
    onSessionLoaded,
  };
}

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
// Tests
// ---------------------------------------------------------------------------

describe('tabSessionMap lifecycle', () => {
  const PANE = 'pane-1';

  describe('single file load (replace existing tab)', () => {
    it('maps the new tab ID to the session after loading+loaded sequence', () => {
      const defaultTabId = 'default-tab';
      const tree = makeTree(PANE, [makeLogviewerTab(defaultTabId)]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'logcat.txt',
        isNewTab: false,
      });

      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
      expect(lc.tabSessionMap.has(defaultTabId)).toBe(false);
    });

    it('maps correctly when loading a file into an empty pane (no prior tab)', () => {
      const tree = makeTree(PANE, []);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'logcat.txt',
        isNewTab: false,
      });

      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
    });
  });

  describe('two sequential file loads (multi-tab)', () => {
    it('both tabs have correct session mappings', () => {
      const defaultTabId = 'default-tab';
      const tree = makeTree(PANE, [makeLogviewerTab(defaultTabId)]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'file-A.txt',
        isNewTab: false,
      });
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-B',
        sessionId: 'session-B',
        sourceName: 'file-B.txt',
        isNewTab: true,
        previousSessionId: 'session-A',
      });

      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
      expect(lc.tabSessionMap.get('tab-B')).toBe('session-B');
    });

    it('switching back to the first tab activates its session', () => {
      const defaultTabId = 'default-tab';
      const tree = makeTree(PANE, [makeLogviewerTab(defaultTabId)]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'file-A.txt',
        isNewTab: false,
      });
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-B',
        sessionId: 'session-B',
        sourceName: 'file-B.txt',
        isNewTab: true,
        previousSessionId: 'session-A',
      });

      expect(lc.paneSessionMap.get(PANE)).toBe('session-B');

      const resolved = lc.switchToTab('tab-A', PANE);
      expect(resolved).toBe('session-A');
      expect(lc.paneSessionMap.get(PANE)).toBe('session-A');
    });

    it('switching to second tab then back to first round-trips correctly', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'file-A.txt',
        isNewTab: false,
      });
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-B',
        sessionId: 'session-B',
        sourceName: 'file-B.txt',
        isNewTab: true,
        previousSessionId: 'session-A',
      });

      lc.switchToTab('tab-A', PANE);
      expect(lc.paneSessionMap.get(PANE)).toBe('session-A');

      lc.switchToTab('tab-B', PANE);
      expect(lc.paneSessionMap.get(PANE)).toBe('session-B');

      lc.switchToTab('tab-A', PANE);
      expect(lc.paneSessionMap.get(PANE)).toBe('session-A');
    });
  });

  describe('three sequential file loads', () => {
    it('all three tabs retain their session mappings', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'tab-A', sessionId: 'session-A', sourceName: 'file-A.txt', isNewTab: false });
      lc.loadFile({ paneId: PANE, tabId: 'tab-B', sessionId: 'session-B', sourceName: 'file-B.txt', isNewTab: true, previousSessionId: 'session-A' });
      lc.loadFile({ paneId: PANE, tabId: 'tab-C', sessionId: 'session-C', sourceName: 'file-C.txt', isNewTab: true, previousSessionId: 'session-B' });

      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
      expect(lc.tabSessionMap.get('tab-B')).toBe('session-B');
      expect(lc.tabSessionMap.get('tab-C')).toBe('session-C');
    });
  });

  describe('session:loaded without prior session:loading (pre-f4df2d9 path)', () => {
    it('correctly maps when session:loaded replaces an existing tab directly', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('old-tab')]);
      const lc = createTabSessionLifecycle(tree);

      // Skip session:loading — call session:loaded directly
      lc.onSessionLoaded({
        sourceName: 'logcat.txt',
        paneId: PANE,
        sourceType: 'Logcat',
        sessionId: 'session-A',
        tabId: 'new-tab',
      });

      expect(lc.tabSessionMap.get('new-tab')).toBe('session-A');
      expect(lc.tabSessionMap.has('old-tab')).toBe(false);
    });
  });

  describe('paneId not in tree — fallback path', () => {
    it('maps correctly when session:loading renamed the fallback tab', () => {
      const realPaneId = 'real-pane';
      const tree = makeTree(realPaneId, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.onSessionLoaded({
        sourceName: 'logcat.txt',
        paneId: 'nonexistent-pane',
        sourceType: 'Logcat',
        sessionId: 'session-A',
        tabId: 'tab-A',
      });

      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
      expect(lc.tabSessionMap.has('default-tab')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Focus marker (blue underline) tests
//
// The focusedLogviewerTabId must point to the newly opened tab after any
// session load. This requires session:loaded to fire BEFORE session:focused
// so the tree has the new tab when onSessionFocused looks up the active tab.
// ---------------------------------------------------------------------------

describe('focus marker (focusedLogviewerTabId)', () => {
  const PANE = 'pane-1';

  describe('file sources', () => {
    it('focuses the new tab when opening a logcat file into an empty pane', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'tab-A', sessionId: 'session-A', sourceName: 'logcat.log', sourceType: 'Logcat', isNewTab: false });

      expect(lc.focusedLogviewerTabId).toBe('tab-A');
    });

    it('focuses the new tab when opening a second file as a new tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'tab-A', sessionId: 'session-A', sourceName: 'logcat.log', sourceType: 'Logcat', isNewTab: false });
      expect(lc.focusedLogviewerTabId).toBe('tab-A');

      lc.loadFile({ paneId: PANE, tabId: 'tab-B', sessionId: 'session-B', sourceName: 'kernel.log', sourceType: 'Kernel', isNewTab: true, previousSessionId: 'session-A' });
      expect(lc.focusedLogviewerTabId).toBe('tab-B');
    });
  });

  describe('stream sources', () => {
    it('focuses the stream tab when opening a stream into an empty pane', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadStream({ paneId: PANE, tabId: 'stream-tab', sessionId: 'stream-session', sourceName: 'ADB: device-123', isNewTab: false });

      expect(lc.focusedLogviewerTabId).toBe('stream-tab');
    });

    it('focuses the stream tab when opening alongside an existing file tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'file-tab', sessionId: 'file-session', sourceName: 'bugreport.txt', sourceType: 'Bugreport', isNewTab: false, readOnly: true });
      expect(lc.focusedLogviewerTabId).toBe('file-tab');

      lc.loadStream({ paneId: PANE, tabId: 'stream-tab', sessionId: 'stream-session', sourceName: 'ADB: pixel-7', isNewTab: true, previousSessionId: 'file-session' });
      expect(lc.focusedLogviewerTabId).toBe('stream-tab');
    });
  });

  describe('zip (.lts) sources', () => {
    it('focuses the .lts tab when opening into an empty pane', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'lts-tab', sessionId: 'lts-session', sourceName: 'capture.lts', sourceType: 'Logcat', isNewTab: false });

      expect(lc.focusedLogviewerTabId).toBe('lts-tab');
    });

    it('focuses the .lts tab when opening alongside an existing stream tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadStream({ paneId: PANE, tabId: 'stream-tab', sessionId: 'stream-session', sourceName: 'ADB: device', isNewTab: false });
      lc.loadFile({ paneId: PANE, tabId: 'lts-tab', sessionId: 'lts-session', sourceName: 'capture.lts', sourceType: 'Logcat', isNewTab: true, previousSessionId: 'stream-session' });

      expect(lc.focusedLogviewerTabId).toBe('lts-tab');
    });

    it('focuses the .lts bugreport tab (read-only) when opened as new tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'file-tab', sessionId: 'file-session', sourceName: 'logcat.log', sourceType: 'Logcat', isNewTab: false });
      lc.loadFile({ paneId: PANE, tabId: 'lts-br-tab', sessionId: 'lts-br-session', sourceName: 'bugreport.lts', sourceType: 'Bugreport', isNewTab: true, previousSessionId: 'file-session', readOnly: true });

      expect(lc.focusedLogviewerTabId).toBe('lts-br-tab');
    });
  });

  describe('mixed source sequences', () => {
    it('focus follows the most recently opened tab across source types', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'tab-file', sessionId: 'sess-file', sourceName: 'logcat.log', sourceType: 'Logcat', isNewTab: false });
      expect(lc.focusedLogviewerTabId).toBe('tab-file');

      lc.loadStream({ paneId: PANE, tabId: 'tab-stream', sessionId: 'sess-stream', sourceName: 'ADB: device', isNewTab: true, previousSessionId: 'sess-file' });
      expect(lc.focusedLogviewerTabId).toBe('tab-stream');

      lc.loadFile({ paneId: PANE, tabId: 'tab-lts', sessionId: 'sess-lts', sourceName: 'session.lts', sourceType: 'Logcat', isNewTab: true, previousSessionId: 'sess-stream' });
      expect(lc.focusedLogviewerTabId).toBe('tab-lts');
    });

    it('switching tabs updates the focus marker', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({ paneId: PANE, tabId: 'tab-file', sessionId: 'sess-file', sourceName: 'logcat.log', sourceType: 'Logcat', isNewTab: false });
      lc.loadStream({ paneId: PANE, tabId: 'tab-stream', sessionId: 'sess-stream', sourceName: 'ADB: device', isNewTab: true, previousSessionId: 'sess-file' });

      expect(lc.focusedLogviewerTabId).toBe('tab-stream');

      lc.switchToTab('tab-file', PANE);
      lc.onSessionFocused(PANE);
      expect(lc.focusedLogviewerTabId).toBe('tab-file');

      lc.switchToTab('tab-stream', PANE);
      lc.onSessionFocused(PANE);
      expect(lc.focusedLogviewerTabId).toBe('tab-stream');
    });
  });
});
