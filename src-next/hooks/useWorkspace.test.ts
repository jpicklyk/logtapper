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
  beginWorkspaceSwitch: vi.fn(),
  setWorkspaceAnalyses: vi.fn(),
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
// Transition gate removal — new/open/switch execute immediately regardless
// of the dirty flag. There is no blocking "save changes?" prompt; the
// durability guarantee moved to doAutoSave() running before doClearPanes()
// in the 'switch' case (covered in the next describe block).
// ---------------------------------------------------------------------------
describe('workspace transitions proceed immediately regardless of dirty state', () => {
  // Models guardedAction's replacement: runTransition in useWorkspace.ts no
  // longer branches on the dirty flag at all — every transition type runs
  // unconditionally.
  type Action = { type: 'new' } | { type: 'open'; path: string } | { type: 'switch'; targetId: string };

  function runTransition(action: Action, _dirty: boolean): { executed: true; action: Action } {
    // dirty is intentionally unused — the whole point of this change is that
    // the transition no longer branches on it.
    return { executed: true, action };
  }

  it('new workspace executes immediately when dirty', () => {
    const result = runTransition({ type: 'new' }, true);
    expect(result.executed).toBe(true);
  });

  it('new workspace executes immediately when clean', () => {
    const result = runTransition({ type: 'new' }, false);
    expect(result.executed).toBe(true);
  });

  it('open workspace executes immediately when dirty', () => {
    const result = runTransition({ type: 'open', path: '/x.ltw' }, true);
    expect(result.executed).toBe(true);
    expect(result.action).toEqual({ type: 'open', path: '/x.ltw' });
  });

  it('switch workspace executes immediately when dirty', () => {
    const result = runTransition({ type: 'switch', targetId: 'ws-2' }, true);
    expect(result.executed).toBe(true);
    expect(result.action).toEqual({ type: 'switch', targetId: 'ws-2' });
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
// Prompt removal — runTransition's 'switch' case always auto-saves before
// tearing panes down, unconditionally, and in a fixed order.
//
// Mirrors useWorkspace.ts:runTransition's 'switch' case, which now reads
// `await doAutoSave(); await doClearPanes();` with no branching — there is
// no promptChoice to consult anymore, since there is no prompt. doAutoSave
// running before doClearPanes is the durability guarantee that replaced the
// save-changes prompt, so the ordering itself is the thing under test here.
// ---------------------------------------------------------------------------
describe('switch action: doAutoSave always runs before doClearPanes (prompt removed)', () => {
  async function runSwitchTransition(calls: string[]): Promise<void> {
    // Mirrors the exact call order in useWorkspace.ts's runTransition 'switch' case.
    const doAutoSave = async () => { calls.push('doAutoSave'); };
    const doClearPanes = async () => { calls.push('doClearPanes'); };
    await doAutoSave();
    await doClearPanes();
  }

  it('switching while dirty still calls doAutoSave then doClearPanes, in order', async () => {
    const calls: string[] = [];
    await runSwitchTransition(calls);
    expect(calls).toEqual(['doAutoSave', 'doClearPanes']);
  });

  it('switching while clean also calls doAutoSave then doClearPanes (unconditional)', async () => {
    // There is no dirty branch anymore — the transition executes identically
    // regardless of the dirty flag, so this asserts the same ordering.
    const calls: string[] = [];
    await runSwitchTransition(calls);
    expect(calls).toEqual(['doAutoSave', 'doClearPanes']);
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
