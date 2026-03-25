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
 * These tests exercise the pure logic extracted from the `session:loading` and
 * `session:loaded` event handlers without React or Tauri dependencies.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { CenterPane, SplitNode, Tab } from './workspaceTypes';
import { findLeafByPaneId, findTabByType, firstLeaf, updateLeaf } from './splitTreeHelpers';

// ---------------------------------------------------------------------------
// Helpers — mirror the tree mutation + map update logic from useCenterTree
// ---------------------------------------------------------------------------

interface SessionLoadingEvent {
  paneId: string;
  tabId: string;
  label: string;
  isNewTab: boolean;
}

interface SessionLoadedEvent {
  sourceName: string;
  paneId: string;
  sourceType: string;
  sessionId: string;
  tabId: string;
  isNewTab?: boolean;
  previousSessionId?: string;
  readOnly?: boolean;
}

interface EmittedEvents {
  tabActivated: { tabId: string; paneId: string; sessionId: string } | null;
  paneRemap: { originalPaneId: string; actualPaneId: string; sessionId: string } | null;
}

/**
 * Extracted state machine that mirrors useCenterTree's tab→session lifecycle.
 * Manages the tree, tabSessionMap, and paneSessionMap exactly as the hook does.
 */
function createTabSessionLifecycle(initialTree: SplitNode) {
  let tree = initialTree;
  const tabSessionMap = new Map<string, string>();
  const paneSessionMap = new Map<string, string>();
  let focusedLogviewerTabId: string | null = null;

  /** Mirrors the `session:loading` bus handler in useCenterTree. */
  function onSessionLoading(e: SessionLoadingEvent): void {
    const targetLeaf = findLeafByPaneId(tree, e.paneId);
    if (!targetLeaf) return;

    // If a tab with this ID already exists, just update its label.
    if (targetLeaf.pane.tabs.some((t) => t.id === e.tabId)) {
      tree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) =>
          t.id === e.tabId ? { ...t, label: e.label } : t,
        ),
        activeTabId: e.tabId,
      }));
      return;
    }

    const existingLogviewerTab = targetLeaf.pane.tabs.find((t) => t.type === 'logviewer');

    if (e.isNewTab && existingLogviewerTab) {
      // Add new tab alongside existing one
      const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.label, closable: true };
      tree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, tab],
        activeTabId: e.tabId,
      }));
      return;
    }

    if (existingLogviewerTab) {
      // Replace existing logviewer tab's ID and label
      tree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) =>
          t.id === existingLogviewerTab.id ? { ...t, id: e.tabId, label: e.label } : t,
        ),
        activeTabId: e.tabId,
      }));
      return;
    }

    // No logviewer tab yet — add one
    const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.label, closable: true };
    tree = updateLeaf(tree, e.paneId, (pane) => ({
      ...pane,
      tabs: [...pane.tabs, tab],
      activeTabId: e.tabId,
    }));
  }

  /** Mirrors the `session:loaded` bus handler in useCenterTree (pre-computation + map update). */
  function onSessionLoaded(e: SessionLoadedEvent): EmittedEvents {
    let tabIdToDelete: string | null = null;
    let emitTabActivated: EmittedEvents['tabActivated'] = null;
    let emitPaneRemap: EmittedEvents['paneRemap'] = null;

    // --- Pre-computation phase (reads current tree) ---
    const preTargetLeaf = findLeafByPaneId(tree, e.paneId);
    if (preTargetLeaf) {
      const existingLogviewerTab = preTargetLeaf.pane.tabs.find((t) => t.type === 'logviewer');
      if (e.isNewTab && existingLogviewerTab && e.previousSessionId) {
        emitTabActivated = { tabId: e.tabId, paneId: e.paneId, sessionId: e.sessionId };
      } else if (existingLogviewerTab && existingLogviewerTab.id !== e.tabId) {
        tabIdToDelete = existingLogviewerTab.id;
      }
    } else {
      const existing = findTabByType(tree, 'logviewer');
      if (existing && !paneSessionMap.has(existing.pane.id)) {
        if (existing.pane.id !== e.paneId) {
          emitPaneRemap = { originalPaneId: e.paneId, actualPaneId: existing.pane.id, sessionId: e.sessionId };
        }
        if (existing.tab.id !== e.tabId) tabIdToDelete = existing.tab.id;
      } else {
        const target = firstLeaf(tree);
        if (target.pane.id !== e.paneId) {
          emitPaneRemap = { originalPaneId: e.paneId, actualPaneId: target.pane.id, sessionId: e.sessionId };
        }
      }
    }

    // --- Tree update phase ---
    const targetLeaf = findLeafByPaneId(tree, e.paneId);
    if (targetLeaf) {
      const existingTabById = targetLeaf.pane.tabs.find((t) => t.id === e.tabId);
      if (existingTabById) {
        tree = updateLeaf(tree, e.paneId, (pane) => ({
          ...pane,
          tabs: pane.tabs.map((t) =>
            t.id === e.tabId ? { ...t, label: e.sourceName, readOnly: e.readOnly } : t,
          ),
        }));
      } else {
        const existingLogviewerTab = targetLeaf.pane.tabs.find((t) => t.type === 'logviewer');
        if (e.isNewTab && existingLogviewerTab && e.previousSessionId) {
          const newTab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly };
          tree = updateLeaf(tree, e.paneId, (pane) => ({
            ...pane,
            tabs: [...pane.tabs, newTab],
            activeTabId: e.tabId,
          }));
        } else if (existingLogviewerTab) {
          tree = updateLeaf(tree, e.paneId, (pane) => ({
            ...pane,
            tabs: pane.tabs.map((t) =>
              t.id === existingLogviewerTab.id ? { ...t, id: e.tabId, label: e.sourceName, readOnly: e.readOnly } : t,
            ),
            activeTabId: e.tabId,
          }));
        } else {
          const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly };
          tree = updateLeaf(tree, e.paneId, (pane) => ({
            ...pane,
            tabs: [...pane.tabs, tab],
            activeTabId: tab.id,
          }));
        }
      }
    } else {
      // paneId not found — fallback paths
      const existing = findTabByType(tree, 'logviewer');
      if (existing && !paneSessionMap.has(existing.pane.id)) {
        tree = updateLeaf(tree, existing.pane.id, (pane) => ({
          ...pane,
          tabs: pane.tabs.map((t) =>
            t.id === existing.tab.id ? { ...t, id: e.tabId, label: e.sourceName, readOnly: e.readOnly } : t,
          ),
          activeTabId: e.tabId,
        }));
      } else {
        const target = firstLeaf(tree);
        const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly };
        tree = updateLeaf(tree, target.pane.id, (pane) => ({
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        }));
      }
    }

    // --- Map update phase (the bug lives here) ---
    tabSessionMap.set(e.tabId, e.sessionId);
    if (tabIdToDelete) tabSessionMap.delete(tabIdToDelete);

    return { tabActivated: emitTabActivated, paneRemap: emitPaneRemap };
  }

  /**
   * Mirrors the `onSessionFocused` handler in useWorkspaceLayout.
   * Finds the active logviewer tab in the given pane and sets focusedLogviewerTabId.
   */
  function onSessionFocused(paneId: string | null): void {
    if (!paneId) { focusedLogviewerTabId = null; return; }
    const leaf = findLeafByPaneId(tree, paneId);
    if (!leaf) return;
    const active = leaf.pane.tabs.find((t) => t.id === leaf.pane.activeTabId);
    if (active?.type === 'logviewer') {
      focusedLogviewerTabId = active.id;
    } else {
      const firstLogviewer = leaf.pane.tabs.find((t) => t.type === 'logviewer');
      focusedLogviewerTabId = firstLogviewer?.id ?? null;
    }
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
  }): EmittedEvents {
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
    const events = onSessionLoaded({
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
    if (events.tabActivated) {
      paneSessionMap.set(events.tabActivated.paneId, events.tabActivated.sessionId);
    }
    if (events.paneRemap) {
      paneSessionMap.set(events.paneRemap.actualPaneId, events.paneRemap.sessionId);
    }

    // Step 4: session:focused (sets the blue underline focus marker)
    onSessionFocused(opts.paneId);

    return events;
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
      // Start with a pane that has a default logviewer tab (as the app does on startup)
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

      // The tab→session mapping must exist for tab switching to work
      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
      // The old default tab mapping should be gone
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

      // First file replaces the default tab
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'file-A.txt',
        isNewTab: false,
      });

      // Second file opens as a new tab alongside the first
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-B',
        sessionId: 'session-B',
        sourceName: 'file-B.txt',
        isNewTab: true,
        previousSessionId: 'session-A',
      });

      // Both mappings must exist
      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
      expect(lc.tabSessionMap.get('tab-B')).toBe('session-B');
    });

    it('switching back to the first tab activates its session', () => {
      const defaultTabId = 'default-tab';
      const tree = makeTree(PANE, [makeLogviewerTab(defaultTabId)]);
      const lc = createTabSessionLifecycle(tree);

      // Load two files
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

      // paneSessionMap currently points to session-B (last loaded)
      expect(lc.paneSessionMap.get(PANE)).toBe('session-B');

      // Switch to tab A — must resolve to session-A
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

      // Switch A → B → A
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
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-C',
        sessionId: 'session-C',
        sourceName: 'file-C.txt',
        isNewTab: true,
        previousSessionId: 'session-B',
      });

      expect(lc.tabSessionMap.get('tab-A')).toBe('session-A');
      expect(lc.tabSessionMap.get('tab-B')).toBe('session-B');
      expect(lc.tabSessionMap.get('tab-C')).toBe('session-C');
    });
  });

  describe('session:loaded without prior session:loading (pre-f4df2d9 path)', () => {
    it('correctly maps when session:loaded replaces an existing tab directly', () => {
      // This tests the path where session:loading was NOT emitted (e.g., the
      // pre-f4df2d9 code path). The existing tab has a DIFFERENT ID from e.tabId,
      // so tabIdToDelete and e.tabId are distinct — no set+delete collision.
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
      // The pane in the tree has a different ID than the requested paneId.
      // This exercises the findTabByType fallback in onSessionLoaded.
      const realPaneId = 'real-pane';
      const tree = makeTree(realPaneId, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      // Load with a paneId that doesn't exist in the tree (e.g., 'primary'
      // during startup restore). session:loading won't find it and won't
      // mutate the tree. session:loaded falls back to findTabByType.
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

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'logcat.log',
        sourceType: 'Logcat',
        isNewTab: false,
      });

      expect(lc.focusedLogviewerTabId).toBe('tab-A');
    });

    it('focuses the new tab when opening a second file as a new tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-A',
        sessionId: 'session-A',
        sourceName: 'logcat.log',
        sourceType: 'Logcat',
        isNewTab: false,
      });
      expect(lc.focusedLogviewerTabId).toBe('tab-A');

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-B',
        sessionId: 'session-B',
        sourceName: 'kernel.log',
        sourceType: 'Kernel',
        isNewTab: true,
        previousSessionId: 'session-A',
      });

      expect(lc.focusedLogviewerTabId).toBe('tab-B');
    });
  });

  describe('stream sources', () => {
    it('focuses the stream tab when opening a stream into an empty pane', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'stream-tab',
        sessionId: 'stream-session',
        sourceName: 'ADB: device-123',
        sourceType: 'Logcat',
        isNewTab: false,
      });

      expect(lc.focusedLogviewerTabId).toBe('stream-tab');
    });

    it('focuses the stream tab when opening alongside an existing file tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      // Open a file first
      lc.loadFile({
        paneId: PANE,
        tabId: 'file-tab',
        sessionId: 'file-session',
        sourceName: 'bugreport.txt',
        sourceType: 'Bugreport',
        isNewTab: false,
        readOnly: true,
      });
      expect(lc.focusedLogviewerTabId).toBe('file-tab');

      // Start a stream as a new tab
      lc.loadFile({
        paneId: PANE,
        tabId: 'stream-tab',
        sessionId: 'stream-session',
        sourceName: 'ADB: pixel-7',
        sourceType: 'Logcat',
        isNewTab: true,
        previousSessionId: 'file-session',
      });

      expect(lc.focusedLogviewerTabId).toBe('stream-tab');
    });
  });

  describe('zip (.lts) sources', () => {
    it('focuses the .lts tab when opening into an empty pane', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'lts-tab',
        sessionId: 'lts-session',
        sourceName: 'capture.lts',
        sourceType: 'Logcat',
        isNewTab: false,
      });

      expect(lc.focusedLogviewerTabId).toBe('lts-tab');
    });

    it('focuses the .lts tab when opening alongside an existing stream tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      // Stream first
      lc.loadFile({
        paneId: PANE,
        tabId: 'stream-tab',
        sessionId: 'stream-session',
        sourceName: 'ADB: device',
        sourceType: 'Logcat',
        isNewTab: false,
      });

      // Open .lts as new tab
      lc.loadFile({
        paneId: PANE,
        tabId: 'lts-tab',
        sessionId: 'lts-session',
        sourceName: 'capture.lts',
        sourceType: 'Logcat',
        isNewTab: true,
        previousSessionId: 'stream-session',
      });

      expect(lc.focusedLogviewerTabId).toBe('lts-tab');
    });

    it('focuses the .lts bugreport tab (read-only) when opened as new tab', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'file-tab',
        sessionId: 'file-session',
        sourceName: 'logcat.log',
        sourceType: 'Logcat',
        isNewTab: false,
      });

      lc.loadFile({
        paneId: PANE,
        tabId: 'lts-br-tab',
        sessionId: 'lts-br-session',
        sourceName: 'bugreport.lts',
        sourceType: 'Bugreport',
        isNewTab: true,
        previousSessionId: 'file-session',
        readOnly: true,
      });

      expect(lc.focusedLogviewerTabId).toBe('lts-br-tab');
    });
  });

  describe('mixed source sequences', () => {
    it('focus follows the most recently opened tab across source types', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      // File
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-file',
        sessionId: 'sess-file',
        sourceName: 'logcat.log',
        sourceType: 'Logcat',
        isNewTab: false,
      });
      expect(lc.focusedLogviewerTabId).toBe('tab-file');

      // Stream
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-stream',
        sessionId: 'sess-stream',
        sourceName: 'ADB: device',
        sourceType: 'Logcat',
        isNewTab: true,
        previousSessionId: 'sess-file',
      });
      expect(lc.focusedLogviewerTabId).toBe('tab-stream');

      // .lts zip
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-lts',
        sessionId: 'sess-lts',
        sourceName: 'session.lts',
        sourceType: 'Logcat',
        isNewTab: true,
        previousSessionId: 'sess-stream',
      });
      expect(lc.focusedLogviewerTabId).toBe('tab-lts');
    });

    it('switching tabs updates the focus marker', () => {
      const tree = makeTree(PANE, [makeLogviewerTab('default-tab')]);
      const lc = createTabSessionLifecycle(tree);

      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-file',
        sessionId: 'sess-file',
        sourceName: 'logcat.log',
        sourceType: 'Logcat',
        isNewTab: false,
      });
      lc.loadFile({
        paneId: PANE,
        tabId: 'tab-stream',
        sessionId: 'sess-stream',
        sourceName: 'ADB: device',
        sourceType: 'Logcat',
        isNewTab: true,
        previousSessionId: 'sess-file',
      });

      // Focus is on the stream tab
      expect(lc.focusedLogviewerTabId).toBe('tab-stream');

      // Switch to file tab — simulates user clicking tab + focus event
      lc.switchToTab('tab-file', PANE);
      lc.onSessionFocused(PANE);
      expect(lc.focusedLogviewerTabId).toBe('tab-file');

      // Switch back to stream
      lc.switchToTab('tab-stream', PANE);
      lc.onSessionFocused(PANE);
      expect(lc.focusedLogviewerTabId).toBe('tab-stream');
    });
  });
});
