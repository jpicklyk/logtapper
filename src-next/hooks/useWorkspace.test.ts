import { describe, it, expect, vi } from 'vitest';

// Mock modules that pull in browser globals
vi.mock('../context/WorkspaceContext', () => ({
  useWorkspaceContext: vi.fn(),
}));
vi.mock('../bridge/commands', () => ({
  exportAllSessions: vi.fn(),
  saveWorkspaceV4: vi.fn(),
  loadWorkspaceV4: vi.fn(),
  saveAppState: vi.fn(),
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
// workspaceNameFromPath
// ---------------------------------------------------------------------------
describe('workspaceNameFromPath', () => {
  it('strips .ltw extension', () => {
    expect(workspaceNameFromPath('/home/user/my-project.ltw')).toBe('my-project');
  });

  it('strips .lts extension', () => {
    expect(workspaceNameFromPath('/home/user/my-project.lts')).toBe('my-project');
  });

  it('strips .LTW extension (case-insensitive)', () => {
    expect(workspaceNameFromPath('C:\\Users\\jeff\\MyLog.LTW')).toBe('MyLog');
  });

  it('handles path with no directory', () => {
    expect(workspaceNameFromPath('simple.ltw')).toBe('simple');
  });

  it('handles path with multiple dots', () => {
    expect(workspaceNameFromPath('/logs/device.2024-01-15.ltw')).toBe('device.2024-01-15');
  });

  it('handles path without .ltw or .lts extension', () => {
    expect(workspaceNameFromPath('/logs/myfile.zip')).toBe('myfile.zip');
  });

  it('handles Windows-style paths', () => {
    expect(workspaceNameFromPath('D:\\Projects\\captures\\debug-session.ltw')).toBe('debug-session');
  });

  it('handles path with spaces', () => {
    expect(workspaceNameFromPath('/home/user/My Log Session.ltw')).toBe('My Log Session');
  });
});

// ---------------------------------------------------------------------------
// Save prompt state machine
// ---------------------------------------------------------------------------
describe('save prompt decision logic', () => {
  type PendingAction =
    | { type: 'new' }
    | { type: 'open'; path: string }
    | { type: 'close' }
    | { type: 'switch'; targetId: string }
    | null;
  type PromptChoice = 'save' | 'discard' | 'cancel';

  interface PromptState {
    showPrompt: boolean;
    pendingAction: PendingAction;
  }

  function initState(): PromptState {
    return { showPrompt: false, pendingAction: null };
  }

  function guardedAction(_state: PromptState, action: NonNullable<PendingAction>, dirty: boolean): PromptState {
    if (dirty) {
      return { showPrompt: true, pendingAction: action };
    }
    return { showPrompt: false, pendingAction: action }; // execute immediately
  }

  function resolvePrompt(_prev: PromptState, choice: PromptChoice): {
    state: PromptState;
    action: 'execute' | 'abort';
    shouldSaveFirst: boolean;
  } {
    if (choice === 'cancel') {
      return { state: initState(), action: 'abort', shouldSaveFirst: false };
    }
    return { state: initState(), action: 'execute', shouldSaveFirst: choice === 'save' };
  }

  it('new workspace on dirty → shows prompt', () => {
    const state = guardedAction(initState(), { type: 'new' }, true);
    expect(state.showPrompt).toBe(true);
    expect(state.pendingAction?.type).toBe('new');
  });

  it('new workspace on clean → executes immediately', () => {
    const state = guardedAction(initState(), { type: 'new' }, false);
    expect(state.showPrompt).toBe(false);
    expect(state.pendingAction?.type).toBe('new');
  });

  it('close workspace on dirty → shows prompt', () => {
    const state = guardedAction(initState(), { type: 'close' }, true);
    expect(state.showPrompt).toBe(true);
    expect(state.pendingAction?.type).toBe('close');
  });

  it('switch workspace on dirty → shows prompt', () => {
    const state = guardedAction(initState(), { type: 'switch', targetId: 'ws-2' }, true);
    expect(state.showPrompt).toBe(true);
    expect(state.pendingAction).toEqual({ type: 'switch', targetId: 'ws-2' });
  });

  it('cancel → aborts pending action', () => {
    const state = guardedAction(initState(), { type: 'close' }, true);
    const result = resolvePrompt(state, 'cancel');
    expect(result.action).toBe('abort');
    expect(result.state.pendingAction).toBeNull();
  });

  it('discard → executes without save', () => {
    const state = guardedAction(initState(), { type: 'close' }, true);
    const result = resolvePrompt(state, 'discard');
    expect(result.action).toBe('execute');
    expect(result.shouldSaveFirst).toBe(false);
  });

  it('save → saves then executes', () => {
    const state = guardedAction(initState(), { type: 'open', path: '/x.ltw' }, true);
    const result = resolvePrompt(state, 'save');
    expect(result.action).toBe('execute');
    expect(result.shouldSaveFirst).toBe(true);
  });
});
