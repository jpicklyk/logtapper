/**
 * M3: Single source of truth for activeLogPaneId
 *
 * Problem: useWorkspaceLayout maintained its own useState for activeLogPaneId,
 * updated via session:focused bus event. SessionContext also maintained the same
 * value from the same event — two sources that could momentarily diverge.
 *
 * Additionally, focusLogviewerTab called setActiveLogPaneId (local state) directly
 * without emitting the bus event, so SessionContext would not update.
 *
 * Fix: Remove the useState in useWorkspaceLayout. Read activeLogPaneId from
 * useSessionPaneCtx(). Make focusLogviewerTab emit session:focused so both
 * SessionContext and WorkspaceLayout update from the same event.
 *
 * These tests verify the invariant at the pure-logic level:
 * - A session:focused bus event is the ONLY mutation path for activeLogPaneId
 * - focusLogviewerTab must emit session:focused (not mutate state directly)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bus } from '../../events/bus';

// ---------------------------------------------------------------------------
// Simulate the session-focused event flow
// ---------------------------------------------------------------------------

/**
 * Minimal reducer that mirrors SessionContext's pane:focused handling.
 * This is the CANONICAL owner of activeLogPaneId.
 */
function createSessionContextSimulator() {
  let activeLogPaneId: string | null = null;

  function onSessionFocused(e: { paneId: string | null }) {
    activeLogPaneId = e.paneId;
  }

  return {
    get activeLogPaneId() { return activeLogPaneId; },
    onSessionFocused,
  };
}

/**
 * Simulate useWorkspaceLayout's focusLogviewerTab function.
 *
 * BEFORE fix (broken): directly sets local state without emitting bus event.
 *   focusLogviewerTab(tabId, paneId) { setActiveLogPaneId(paneId); }
 *
 * AFTER fix (correct): emits bus event so SessionContext updates.
 *   focusLogviewerTab(tabId, paneId) { bus.emit('session:focused', { ... }); }
 */
function createWorkspaceLayoutSimulator(
  mode: 'broken' | 'fixed',
  sessionContext: ReturnType<typeof createSessionContextSimulator>,
) {
  // Before fix: workspace has its own copy of activeLogPaneId
  let localActiveLogPaneId: string | null = null;
  let focusedLogviewerTabId: string | null = null;

  function focusLogviewerTab(tabId: string, paneId: string) {
    focusedLogviewerTabId = tabId;

    if (mode === 'broken') {
      // OLD CODE: sets local state only — SessionContext doesn't update
      localActiveLogPaneId = paneId;
    } else {
      // FIXED CODE: emit bus event — SessionContext updates, no local state needed
      bus.emit('session:focused', { sessionId: null, paneId });
    }
  }

  // After fix: workspace reads from SessionContext, not local state
  const getActiveLogPaneId = () =>
    mode === 'fixed' ? sessionContext.activeLogPaneId : localActiveLogPaneId;

  return {
    focusLogviewerTab,
    get activeLogPaneId() { return getActiveLogPaneId(); },
    get focusedLogviewerTabId() { return focusedLogviewerTabId; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M3: activeLogPaneId single source of truth', () => {
  let sessionCtx: ReturnType<typeof createSessionContextSimulator>;

  beforeEach(() => {
    sessionCtx = createSessionContextSimulator();
    bus.on('session:focused', sessionCtx.onSessionFocused);
  });

  afterEach(() => {
    bus.off('session:focused', sessionCtx.onSessionFocused);
  });

  describe('broken behavior (before fix) — documents the divergence', () => {
    it('focusLogviewerTab updates workspace state but NOT SessionContext', () => {
      const workspace = createWorkspaceLayoutSimulator('broken', sessionCtx);

      workspace.focusLogviewerTab('tab-1', 'pane-A');

      // Workspace local state is updated
      expect(workspace.activeLogPaneId).toBe('pane-A');
      // SessionContext is NOT updated — this is the bug
      expect(sessionCtx.activeLogPaneId).toBeNull();
    });

    it('sources diverge when focusLogviewerTab is called directly', () => {
      const workspace = createWorkspaceLayoutSimulator('broken', sessionCtx);

      // A bus event sets both
      bus.emit('session:focused', { sessionId: null, paneId: 'pane-A' });
      expect(workspace.activeLogPaneId).toBe(null); // local state not updated by bus
      expect(sessionCtx.activeLogPaneId).toBe('pane-A'); // context updated

      // Then direct call updates only workspace
      workspace.focusLogviewerTab('tab-1', 'pane-B');
      expect(workspace.activeLogPaneId).toBe('pane-B');
      expect(sessionCtx.activeLogPaneId).toBe('pane-A'); // still stale!
    });
  });

  describe('fixed behavior (after fix) — single source of truth', () => {
    it('focusLogviewerTab emits session:focused, updating SessionContext', () => {
      const workspace = createWorkspaceLayoutSimulator('fixed', sessionCtx);

      workspace.focusLogviewerTab('tab-1', 'pane-A');

      // SessionContext is the canonical source — both agree
      expect(sessionCtx.activeLogPaneId).toBe('pane-A');
      expect(workspace.activeLogPaneId).toBe('pane-A');
    });

    it('workspace and SessionContext always agree after focus change', () => {
      const workspace = createWorkspaceLayoutSimulator('fixed', sessionCtx);

      workspace.focusLogviewerTab('tab-1', 'pane-A');
      expect(workspace.activeLogPaneId).toBe(sessionCtx.activeLogPaneId);

      // Another focus change via bus (e.g. from PaneContent)
      bus.emit('session:focused', { sessionId: null, paneId: 'pane-B' });
      expect(workspace.activeLogPaneId).toBe('pane-B');
      expect(workspace.activeLogPaneId).toBe(sessionCtx.activeLogPaneId);
    });

    it('session:focused null clears activeLogPaneId in both places', () => {
      const workspace = createWorkspaceLayoutSimulator('fixed', sessionCtx);

      workspace.focusLogviewerTab('tab-1', 'pane-A');
      expect(workspace.activeLogPaneId).toBe('pane-A');

      bus.emit('session:focused', { sessionId: null, paneId: null });
      expect(sessionCtx.activeLogPaneId).toBeNull();
      expect(workspace.activeLogPaneId).toBeNull();
    });

    it('focusedLogviewerTabId is set independently of activeLogPaneId', () => {
      const workspace = createWorkspaceLayoutSimulator('fixed', sessionCtx);

      workspace.focusLogviewerTab('tab-1', 'pane-A');
      expect(workspace.focusedLogviewerTabId).toBe('tab-1');
      expect(workspace.activeLogPaneId).toBe('pane-A');

      workspace.focusLogviewerTab('tab-2', 'pane-A');
      expect(workspace.focusedLogviewerTabId).toBe('tab-2');
      expect(workspace.activeLogPaneId).toBe('pane-A');
    });
  });
});
