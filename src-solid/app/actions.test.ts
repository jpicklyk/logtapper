import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadResult } from '@bridge/types';
import { CacheManager, DataSourceRegistry, createViewerController } from '../viewer';
import type { ViewerController } from '../viewer';
import { createSessionStore } from './sessions';
import type { SessionStore } from './sessions';
import { createAppActions } from './actions';
import type { AppActions } from './actions';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

vi.mock('@bridge/events', () => ({
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
}));

const commands = vi.hoisted(() => ({
  loadLogFile: vi.fn(),
  closeSession: vi.fn(() => Promise.resolve()),
  setFocusedSession: vi.fn(() => Promise.resolve()),
  getLines: vi.fn(),
}));

vi.mock('@bridge/commands', () => commands);

function load(sessionId: string, overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    sessionId,
    sourceId: sessionId,
    sourceName: `${sessionId}.log`,
    filePath: `C:/logs/bundle.lts`,
    totalLines: 10,
    fileSize: 4096,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: 'Logcat',
    isStreaming: false,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
    ...overrides,
  };
}

function page(totalLines: number) {
  return { sessionId: '', totalLines, offset: 0, count: 0, truncated: false, lines: [] };
}

let store: SessionStore;
let controller: ViewerController;
let actions: AppActions;
let chooseFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // `clearAllMocks` forgets calls but keeps implementations, so a test that
  // made `closeSession` reject would poison the next one — reset each mock's
  // behaviour explicitly.
  vi.clearAllMocks();
  commands.getLines.mockReset();
  commands.getLines.mockResolvedValue(page(10));
  commands.loadLogFile.mockReset();
  commands.closeSession.mockReset();
  commands.closeSession.mockResolvedValue(undefined);
  commands.setFocusedSession.mockReset();
  commands.setFocusedSession.mockResolvedValue(undefined);
  controller = createViewerController({ focusSession: () => {} });
  store = createSessionStore({
    cacheManager: new CacheManager(10_000),
    registry: new DataSourceRegistry(),
    controller,
  });
  chooseFile = vi.fn();
  actions = createAppActions({ store, controller, chooseFile: chooseFile as never });
});

afterEach(() => {
  store.dispose();
  controller.dispose();
  vi.useRealTimers();
});

describe('openPath', () => {
  it('registers a single-session file and focuses it', async () => {
    commands.loadLogFile.mockResolvedValue([load('only')]);

    await expect(actions.openPath('C:/logs/a.log')).resolves.toBe('only');

    expect(store.order()).toEqual(['only']);
    expect(store.focusedId()).toBe('only');
  });

  it('registers all three sessions of an .lts in planner order and focuses the primary', async () => {
    commands.loadLogFile.mockResolvedValue([
      load('primary'),
      load('extra-1'),
      load('extra-2'),
    ]);

    const id = await actions.openPath('C:/logs/bundle.lts');

    expect(id).toBe('primary');
    // The shared planner emits register/activate per extra, then re-activates
    // the primary last — so insertion order is primary first, extras after,
    // and the primary is what stays selected.
    expect(store.order()).toEqual(['primary', 'extra-1', 'extra-2']);
    expect(store.focusedId()).toBe('primary');
    expect(store.byId('extra-2')?.load.sourceName).toBe('extra-2.log');
  });

  it('takes the authoritative total from a probe, not from LoadResult', async () => {
    commands.loadLogFile.mockResolvedValue([load('only', { totalLines: 10 })]);
    commands.getLines.mockResolvedValue(page(4_242));

    await actions.openPath('C:/logs/a.log');

    expect(store.byId('only')?.totalLines).toBe(4_242);
  });

  it('waitForIndex probes until the total is stable across two reads', async () => {
    vi.useFakeTimers();
    commands.loadLogFile.mockResolvedValue([load('only')]);
    commands.getLines
      .mockResolvedValueOnce(page(50))
      .mockResolvedValueOnce(page(100))
      .mockResolvedValue(page(100));

    const pending = actions.openPath('C:/logs/big.log', { waitForIndex: true });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toBe('only');
    // probe, (sleep) probe, (sleep) probe → stable at 100.
    expect(commands.getLines).toHaveBeenCalledTimes(3);
    expect(store.byId('only')?.totalLines).toBe(100);
  });

  it('does not wait for the index on the UI path', async () => {
    commands.loadLogFile.mockResolvedValue([load('only')]);
    commands.getLines.mockResolvedValue(page(7));

    await actions.openPath('C:/logs/a.log');

    expect(commands.getLines).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failure and clears busy', async () => {
    commands.loadLogFile.mockRejectedValue(new Error('unreadable'));

    await expect(actions.openPath('C:/nope.log')).rejects.toThrow('unreadable');

    expect(actions.error()).toContain('unreadable');
    expect(actions.busy()).toBe(false);
    expect(store.order()).toEqual([]);
  });

  it('fails when the backend returns no sessions', async () => {
    commands.loadLogFile.mockResolvedValue([]);

    await expect(actions.openPath('C:/empty.lts')).rejects.toThrow(/No sessions/);
  });
});

describe('openFileDialog', () => {
  it('opens the chosen path', async () => {
    chooseFile.mockResolvedValue('C:/logs/a.log');
    commands.loadLogFile.mockResolvedValue([load('only')]);

    await actions.openFileDialog();

    expect(commands.loadLogFile).toHaveBeenCalledWith('C:/logs/a.log');
    expect(store.order()).toEqual(['only']);
  });

  it('is a no-op when the dialog is cancelled', async () => {
    chooseFile.mockResolvedValue(null);

    await actions.openFileDialog();

    expect(commands.loadLogFile).not.toHaveBeenCalled();
  });

  it('swallows an open failure rather than rejecting the click handler', async () => {
    chooseFile.mockResolvedValue('C:/logs/a.log');
    commands.loadLogFile.mockRejectedValue(new Error('unreadable'));

    await expect(actions.openFileDialog()).resolves.toBeUndefined();
    expect(actions.error()).toContain('unreadable');
  });
});

describe('close', () => {
  it('claims the close, tells the backend, then drops the entry', async () => {
    commands.loadLogFile.mockResolvedValue([load('only')]);
    await actions.openPath('C:/logs/a.log');

    const order: string[] = [];
    const markPendingClose = vi
      .spyOn(store, 'markPendingClose')
      .mockImplementation(() => order.push('claim'));
    commands.closeSession.mockImplementation(() => {
      order.push('command');
      return Promise.resolve();
    });
    const remove = vi.spyOn(store, 'remove').mockImplementation(() => order.push('remove'));

    await actions.close('only');

    expect(order).toEqual(['claim', 'command', 'remove']);
    expect(markPendingClose).toHaveBeenCalledWith('only');
    expect(remove).toHaveBeenCalledWith('only');
  });

  it('still removes the entry when the backend close fails', async () => {
    commands.loadLogFile.mockResolvedValue([load('only')]);
    await actions.openPath('C:/logs/a.log');
    commands.closeSession.mockRejectedValue(new Error('gone'));

    await expect(actions.close('only')).rejects.toThrow('gone');

    expect(store.byId('only')).toBeUndefined();
  });
});

describe('view reset', () => {
  it('clears line sets and highlights on open and on close', async () => {
    commands.loadLogFile.mockResolvedValue([load('only')]);
    controller.setLineSet('only', 'filter', new Set([1, 2]));
    controller.setHighlights('only', new Map());

    await actions.openPath('C:/logs/a.log');

    // A backend session id is deterministic per path, so a reopen would
    // otherwise inherit the previous open's filter.
    expect(controller.lineNumbers('only')).toBeUndefined();
    expect(controller.highlights('only')).toBeNull();

    controller.setLineSet('only', 'search', new Set([3]));
    await actions.close('only');
    expect(controller.lineNumbers('only')).toBeUndefined();
  });
});

describe('reportError', () => {
  it('shows a failure raised outside the action surface', () => {
    actions.reportError('could not read notes.md');
    expect(actions.error()).toBe('could not read notes.md');
  });
});

describe('focus', () => {
  it('selects a session', async () => {
    commands.loadLogFile.mockResolvedValue([load('a'), load('b')]);
    await actions.openPath('C:/logs/bundle.lts');

    actions.focus('b');

    expect(store.focusedId()).toBe('b');
  });
});
