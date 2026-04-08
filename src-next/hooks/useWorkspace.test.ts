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
import { buildEditorTabEvents } from './workspace/workspacePersistence';

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

// ---------------------------------------------------------------------------
// autoSave path decision
// ---------------------------------------------------------------------------
describe('autoSave path decision', () => {
  // Models the doAutoSave branching: workspace with user-saved filePath
  // delegates to doSave(filePath), workspace without filePath auto-saves
  // to app_data_dir/{uuid}.ltw
  function autoSaveDecision(active: { filePath: string | null }): 'save-existing' | 'auto-save' {
    return active.filePath ? 'save-existing' : 'auto-save';
  }

  // Models the identity update after each path
  function applyAutoSave(
    ws: { name: string; filePath: string | null; dirty: boolean },
    decision: 'save-existing' | 'auto-save',
    autoSavePath?: string,
  ): { name: string; filePath: string | null; dirty: boolean } {
    if (decision === 'save-existing') {
      // doSave calls markClean with existing name/path — identity preserved
      return { ...ws, dirty: false };
    }
    // auto-save: setWorkspacePath replaces filePath with UUID path
    return { ...ws, filePath: autoSavePath ?? ws.filePath, dirty: false };
  }

  it('workspace with filePath => save-to-existing', () => {
    const decision = autoSaveDecision({ filePath: '/my-project.ltw' });
    expect(decision).toBe('save-existing');
  });

  it('workspace without filePath => auto-save', () => {
    const decision = autoSaveDecision({ filePath: null });
    expect(decision).toBe('auto-save');
  });

  it('save-to-existing preserves workspace identity', () => {
    const ws = { name: 'MyProject', filePath: '/my-project.ltw', dirty: true };
    const decision = autoSaveDecision(ws);
    const result = applyAutoSave(ws, decision);
    expect(result.name).toBe('MyProject');
    expect(result.filePath).toBe('/my-project.ltw');
    expect(result.dirty).toBe(false);
  });

  it('auto-save sets filePath to UUID path', () => {
    const ws = { name: 'Untitled', filePath: null, dirty: true };
    const decision = autoSaveDecision(ws);
    const result = applyAutoSave(ws, decision, '/app_data/abc-123.ltw');
    expect(result.filePath).toBe('/app_data/abc-123.ltw');
  });

  it('switch workflow: saved workspace round-trips without rename', () => {
    // Simulate: user saved to /my.ltw, then switches workspace
    const ws = { name: 'MyLog', filePath: '/logs/MyLog.ltw', dirty: true };

    // Step 1: doAutoSave during switch
    const decision = autoSaveDecision(ws);
    expect(decision).toBe('save-existing');

    // Step 2: identity after save
    const afterSave = applyAutoSave(ws, decision);
    expect(afterSave.name).toBe('MyLog');
    expect(afterSave.filePath).toBe('/logs/MyLog.ltw');
  });

  it('save-to-existing with UUID path preserves name (not derived from path)', () => {
    // Workspace has a UUID auto-save path from a prior session — name must NOT
    // be derived from the filename or it would become the UUID.
    const ws = { name: 'main', filePath: '/app_data/workspaces/fb4fec06-d16c-4ef8.ltw', dirty: true };
    const decision = autoSaveDecision(ws);
    expect(decision).toBe('save-existing');
    const result = applyAutoSave(ws, decision);
    expect(result.name).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// editor tab restore mapping
// ---------------------------------------------------------------------------
describe('editor tab restore mapping', () => {
  it('empty editor tabs => empty events', () => {
    expect(buildEditorTabEvents([])).toEqual([]);
  });

  it('single editor tab => correct event shape', () => {
    const events = buildEditorTabEvents([{
      label: 'Notes',
      content: '# My Notes',
      viewMode: 'editor',
      wordWrap: true,
      filePath: null,
    }]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'editor',
      label: 'Notes',
      filePath: undefined,
      editorState: { content: '# My Notes', viewMode: 'editor', wordWrap: true },
    });
  });

  it('filePath null => filePath undefined in event', () => {
    const events = buildEditorTabEvents([{
      label: 'X', content: '', viewMode: 'editor', wordWrap: false, filePath: null,
    }]);
    expect(events[0].filePath).toBeUndefined();
  });

  it('filePath string => preserved in event', () => {
    const events = buildEditorTabEvents([{
      label: 'Config', content: 'data', viewMode: 'viewer', wordWrap: false, filePath: '/tmp/config.yaml',
    }]);
    expect(events[0].filePath).toBe('/tmp/config.yaml');
  });

  it('multiple tabs => one event per tab', () => {
    const tabs = [
      { label: 'A', content: 'aaa', viewMode: 'editor', wordWrap: false, filePath: null },
      { label: 'B', content: 'bbb', viewMode: 'viewer', wordWrap: true, filePath: '/b.txt' },
      { label: 'C', content: 'ccc', viewMode: 'editor', wordWrap: false, filePath: null },
    ];
    const events = buildEditorTabEvents(tabs);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.label)).toEqual(['A', 'B', 'C']);
  });

  it('preserves all editorState fields', () => {
    const events = buildEditorTabEvents([{
      label: 'Test', content: 'hello world', viewMode: 'viewer', wordWrap: true, filePath: null,
    }]);
    expect(events[0].editorState).toEqual({
      content: 'hello world',
      viewMode: 'viewer',
      wordWrap: true,
    });
  });
});
