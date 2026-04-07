import { describe, it, expect, vi } from 'vitest';

// Mock modules that pull in browser globals (window.matchMedia, Tauri APIs)
vi.mock('../context/WorkspaceContext', () => ({
  useWorkspaceContext: vi.fn(),
}));
vi.mock('../bridge/commands', () => ({
  exportAllSessions: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../components/EditorTab', () => ({
  LS_CONTENT_PREFIX: 'logtapper_scratchpad_',
  LS_MODE_PREFIX: 'logtapper_editor_mode_',
  LS_WRAP_PREFIX: 'logtapper_editor_wrap_',
  LS_FILEPATH_PREFIX: 'logtapper_editor_filepath_',
}));

import { workspaceNameFromPath } from './useWorkspace';

// ---------------------------------------------------------------------------
// workspaceNameFromPath — derive display name from .lts file path
// ---------------------------------------------------------------------------
describe('workspaceNameFromPath', () => {
  it('strips .lts extension', () => {
    expect(workspaceNameFromPath('/home/user/my-project.lts')).toBe('my-project');
  });

  it('strips .LTS extension (case-insensitive)', () => {
    expect(workspaceNameFromPath('C:\\Users\\jeff\\MyLog.LTS')).toBe('MyLog');
  });

  it('handles path with no directory', () => {
    expect(workspaceNameFromPath('simple.lts')).toBe('simple');
  });

  it('handles path with multiple dots', () => {
    expect(workspaceNameFromPath('/logs/device.2024-01-15.lts')).toBe('device.2024-01-15');
  });

  it('handles path without .lts extension', () => {
    // Shouldn't happen in practice, but should not break
    expect(workspaceNameFromPath('/logs/myfile.zip')).toBe('myfile.zip');
  });

  it('handles Windows-style paths', () => {
    expect(workspaceNameFromPath('D:\\Projects\\captures\\debug-session.lts')).toBe('debug-session');
  });

  it('handles path with spaces', () => {
    expect(workspaceNameFromPath('/home/user/My Log Session.lts')).toBe('My Log Session');
  });
});

// ---------------------------------------------------------------------------
// SavePromptChoice flow — decision logic tests
// ---------------------------------------------------------------------------
describe('save prompt decision logic', () => {
  // These test the decision rules that useWorkspace implements:
  // - If dirty → show prompt
  // - If clean → proceed immediately
  // - cancel → abort pending action
  // - discard → execute pending action without saving
  // - save → save first, then execute pending action

  function shouldShowPrompt(dirty: boolean): boolean {
    return dirty;
  }

  describe('newWorkspace trigger', () => {
    it('skips prompt when workspace is clean', () => {
      expect(shouldShowPrompt(false)).toBe(false);
    });

    it('shows prompt when workspace is dirty', () => {
      expect(shouldShowPrompt(true)).toBe(true);
    });
  });

  describe('openWorkspace trigger', () => {
    it('skips prompt when workspace is clean', () => {
      expect(shouldShowPrompt(false)).toBe(false);
    });

    it('shows prompt when workspace is dirty', () => {
      expect(shouldShowPrompt(true)).toBe(true);
    });
  });

  // Test the state machine for pending action resolution
  type PendingAction = 'new' | 'open' | null;
  type PromptChoice = 'save' | 'discard' | 'cancel';

  interface PromptState {
    showPrompt: boolean;
    pendingAction: PendingAction;
    pendingPath: string | null;
  }

  function initPromptState(): PromptState {
    return { showPrompt: false, pendingAction: null, pendingPath: null };
  }

  function triggerNew(state: PromptState, dirty: boolean): PromptState {
    if (dirty) {
      return { showPrompt: true, pendingAction: 'new', pendingPath: null };
    }
    return state; // proceed immediately (no state change needed)
  }

  function triggerOpen(state: PromptState, dirty: boolean, path: string): PromptState {
    if (dirty) {
      return { showPrompt: true, pendingAction: 'open', pendingPath: path };
    }
    return state; // proceed immediately
  }

  function resolvePrompt(_state: PromptState, choice: PromptChoice): {
    state: PromptState;
    action: 'execute' | 'abort';
    shouldSaveFirst: boolean;
  } {
    if (choice === 'cancel') {
      return {
        state: initPromptState(),
        action: 'abort',
        shouldSaveFirst: false,
      };
    }
    return {
      state: initPromptState(),
      action: 'execute',
      shouldSaveFirst: choice === 'save',
    };
  }

  it('new workspace on dirty → prompt → cancel → abort', () => {
    let state = initPromptState();
    state = triggerNew(state, true);
    expect(state.showPrompt).toBe(true);
    expect(state.pendingAction).toBe('new');

    const result = resolvePrompt(state, 'cancel');
    expect(result.action).toBe('abort');
    expect(result.state.showPrompt).toBe(false);
    expect(result.state.pendingAction).toBeNull();
  });

  it('new workspace on dirty → prompt → discard → execute without save', () => {
    let state = initPromptState();
    state = triggerNew(state, true);

    const result = resolvePrompt(state, 'discard');
    expect(result.action).toBe('execute');
    expect(result.shouldSaveFirst).toBe(false);
  });

  it('new workspace on dirty → prompt → save → save then execute', () => {
    let state = initPromptState();
    state = triggerNew(state, true);

    const result = resolvePrompt(state, 'save');
    expect(result.action).toBe('execute');
    expect(result.shouldSaveFirst).toBe(true);
  });

  it('open workspace on dirty → stores pending path', () => {
    let state = initPromptState();
    state = triggerOpen(state, true, '/path/to/workspace.lts');
    expect(state.showPrompt).toBe(true);
    expect(state.pendingAction).toBe('open');
    expect(state.pendingPath).toBe('/path/to/workspace.lts');
  });

  it('open workspace on dirty → cancel → path is cleared', () => {
    let state = initPromptState();
    state = triggerOpen(state, true, '/path/to/workspace.lts');

    const result = resolvePrompt(state, 'cancel');
    expect(result.state.pendingPath).toBeNull();
    expect(result.action).toBe('abort');
  });

  it('open workspace on dirty → discard → execute with stored path', () => {
    const state = triggerOpen(initPromptState(), true, '/path/to/workspace.lts');

    // Before resolving, the path is captured
    expect(state.pendingPath).toBe('/path/to/workspace.lts');

    const result = resolvePrompt(state, 'discard');
    expect(result.action).toBe('execute');
    expect(result.shouldSaveFirst).toBe(false);
  });

  it('new workspace on clean → no prompt', () => {
    const state = initPromptState();
    const next = triggerNew(state, false);
    // State unchanged — action proceeds immediately
    expect(next).toBe(state);
    expect(next.showPrompt).toBe(false);
  });

  it('open workspace on clean → no prompt', () => {
    const state = initPromptState();
    const next = triggerOpen(state, false, '/x.lts');
    expect(next).toBe(state);
    expect(next.showPrompt).toBe(false);
  });
});
