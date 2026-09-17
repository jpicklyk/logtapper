import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadResult, SectionInfo } from '@bridge/types';
import { CacheManager, DataSourceRegistry, createViewerController } from '../viewer';
import type { PaneHandle, ViewerController } from '../viewer';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import { createSessionStore } from '../app/index';
import type { SessionStore } from '../app/index';
import {
  activeSectionIndexAt,
  createSectionsStore,
  linesForSelection,
  NOTICE_MS,
  OUTSIDE_FILTER_NOTICE,
} from './sectionsStore';
import type { SectionsStore } from './sectionsStore';

vi.mock('@bridge/events', () => ({
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
}));

const commands = vi.hoisted(() => ({
  getLines: vi.fn(),
  getSections: vi.fn(),
  getDumpstateMetadata: vi.fn(),
  setFocusedSession: vi.fn(() => Promise.resolve()),
}));
vi.mock('@bridge/commands', () => commands);

function load(sessionId: string, overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    sessionId,
    sourceId: sessionId,
    sourceName: `${sessionId}.txt`,
    filePath: `C:/logs/${sessionId}.txt`,
    totalLines: 100,
    fileSize: 4096,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: 'Bugreport',
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

function section(name: string, startLine: number, endLine: number, parentIndex?: number): SectionInfo {
  return parentIndex === undefined ? { name, startLine, endLine } : { name, startLine, endLine, parentIndex };
}

function makePane(): PaneHandle & { jumpToLine: ReturnType<typeof vi.fn> } {
  const handle: PaneHandle = { jumpToLine: vi.fn(), flashLine: vi.fn(), focus: vi.fn(), setSelection: vi.fn() };
  return handle as PaneHandle & { jumpToLine: ReturnType<typeof vi.fn> };
}

/** Drain enough microtasks for a `Promise.all([...]).then(...)` chain to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let cacheManager: CacheManager;
let registry: DataSourceRegistry;
let controller: ViewerController;
let sessionStore: SessionStore;
let store: SectionsStore;

beforeEach(() => {
  vi.clearAllMocks();
  commands.getLines.mockResolvedValue(page(100));
  commands.getSections.mockResolvedValue([]);
  commands.getDumpstateMetadata.mockResolvedValue(null);
  cacheManager = new CacheManager(10_000);
  registry = new DataSourceRegistry();
  controller = createViewerController({ focusSession: vi.fn() });
  sessionStore = createSessionStore({ cacheManager, registry, controller });
  store = createSectionsStore({ sessions: sessionStore, controller });
});

afterEach(() => {
  store.dispose();
  sessionStore.dispose();
  controller.dispose();
  vi.useRealTimers();
});

describe('activeSectionIndexAt', () => {
  const sections = [
    section('A', 0, 9),
    section('B', 10, 19),
    section('B.CHILD', 12, 15, 1),
  ];

  it('returns -1 for a null line or an empty section list', () => {
    expect(activeSectionIndexAt(sections, null)).toBe(-1);
    expect(activeSectionIndexAt([], 5)).toBe(-1);
  });

  it('matches inclusive start/end boundaries', () => {
    expect(activeSectionIndexAt(sections, 0)).toBe(0);
    expect(activeSectionIndexAt(sections, 9)).toBe(0);
    expect(activeSectionIndexAt(sections, 10)).toBe(1);
  });

  it('prefers the more specific (later, narrower) section on overlapping ranges', () => {
    expect(activeSectionIndexAt(sections, 12)).toBe(2);
    expect(activeSectionIndexAt(sections, 15)).toBe(2);
    // Just past the child's range, back inside only the parent.
    expect(activeSectionIndexAt(sections, 16)).toBe(1);
  });

  it('returns -1 outside every range', () => {
    expect(activeSectionIndexAt(sections, 100)).toBe(-1);
    expect(activeSectionIndexAt(sections, -1)).toBe(-1);
  });
});

describe('linesForSelection', () => {
  const sections = [section('A', 0, 2), section('B', 10, 11)];

  it('returns null when nothing is selected', () => {
    expect(linesForSelection(sections, new Set())).toBeNull();
  });

  it('returns the union of the selected sections’ ranges', () => {
    expect(linesForSelection(sections, new Set([0, 10]))).toEqual(new Set([0, 1, 2, 10, 11]));
    expect(linesForSelection(sections, new Set([10]))).toEqual(new Set([10, 11]));
  });

  it('keys on startLine, so two sections sharing a name do not select together', () => {
    // A dumpstate repeats `DUMP OF SERVICE …` blocks; name-keyed selection
    // unioned both ranges when the user ticked one.
    const duplicates = [section('DUMP OF SERVICE x', 0, 2), section('DUMP OF SERVICE x', 50, 52)];
    expect(linesForSelection(duplicates, new Set([50]))).toEqual(new Set([50, 51, 52]));
  });
});

describe('createSectionsStore — active index tracks the controller cursor', () => {
  it('is -1 with no session focused, and updates as the cursor moves', async () => {
    commands.getSections.mockResolvedValue([section('A', 0, 9), section('B', 10, 19)]);
    expect(store.activeIndex()).toBe(-1);

    const entry = sessionStore.add(load('s1'));
    sessionStore.setFocused(entry.load.sessionId);
    await flush();

    controller.setCursor('s1', 3);
    expect(store.activeIndex()).toBe(0);

    controller.setCursor('s1', 15);
    expect(store.activeIndex()).toBe(1);
  });

  it('ignores a cursor belonging to a different session', async () => {
    commands.getSections.mockResolvedValue([section('A', 0, 9)]);
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();

    controller.setCursor('other-session', 5);
    expect(store.activeIndex()).toBe(-1);
  });
});

describe('createSectionsStore — fetch and cache', () => {
  it('fetches sections + metadata once per session id, gated on indexing', async () => {
    commands.getSections.mockResolvedValue([section('A', 0, 9)]);
    commands.getDumpstateMetadata.mockResolvedValue({
      buildString: null, buildFingerprint: null, osVersion: '14', buildType: null,
      bootloader: null, serial: null, uptime: null, kernelVersion: null,
      sdkVersion: null, deviceModel: 'Pixel', manufacturer: 'Google',
    });

    const entry = sessionStore.add(load('s1', { isIndexing: true }));
    sessionStore.setFocused('s1');
    await Promise.resolve();
    expect(commands.getSections).not.toHaveBeenCalled();
    expect(store.scanning()).toBe(true);

    sessionStore.updateTotal('s1', entry.totalLines, false);
    await flush();

    expect(commands.getSections).toHaveBeenCalledTimes(1);
    expect(commands.getDumpstateMetadata).toHaveBeenCalledTimes(1);
    expect(store.sections()).toEqual([section('A', 0, 9)]);
    expect(store.metadata()?.deviceModel).toBe('Pixel');
    expect(store.scanning()).toBe(false);
  });

  it('re-fetches after indexing completes when the first fetch saw a partial index', async () => {
    // Load reports not-indexing (the restore path), so the gate fetches at once…
    commands.getSections.mockResolvedValueOnce([section('A', 0, 9)]);
    const entry = sessionStore.add(load('s1', { isIndexing: false }));
    sessionStore.setFocused('s1');
    await flush();
    expect(commands.getSections).toHaveBeenCalledTimes(1);
    expect(store.sections()).toEqual([section('A', 0, 9)]);

    // …then the first progress event flips it to indexing, and completion must refresh.
    commands.getSections.mockResolvedValueOnce([section('A', 0, 9), section('B', 10, 99)]);
    sessionStore.updateTotal('s1', entry.totalLines, true);
    await flush();
    expect(commands.getSections).toHaveBeenCalledTimes(1);
    sessionStore.updateTotal('s1', 100, false);
    await flush();
    expect(commands.getSections).toHaveBeenCalledTimes(2);
    expect(store.sections()).toEqual([section('A', 0, 9), section('B', 10, 99)]);
  });

  it('refreshes a session whose indexing completed while another was focused', async () => {
    commands.getSections.mockResolvedValue([section('A', 0, 9)]);
    const s1 = sessionStore.add(load('s1', { isIndexing: false }));
    sessionStore.add(load('s2'));
    sessionStore.setFocused('s1');
    await flush();
    expect(commands.getSections).toHaveBeenCalledTimes(1);
    sessionStore.updateTotal('s1', s1.totalLines, true);
    sessionStore.setFocused('s2');
    await flush();
    sessionStore.updateTotal('s1', 100, false); // completes off-focus
    await flush();
    sessionStore.setFocused('s1');
    await flush();
    expect(commands.getSections.mock.calls.filter((c) => c[0] === 's1')).toHaveLength(2);
  });

  it('does not re-fetch on repeated focus of the same session', async () => {
    commands.getSections.mockResolvedValue([section('A', 0, 9)]);
    sessionStore.add(load('s1'));
    sessionStore.add(load('s2'));

    sessionStore.setFocused('s1');
    await flush();
    sessionStore.setFocused('s2');
    await flush();
    sessionStore.setFocused('s1');
    await flush();

    expect(commands.getSections).toHaveBeenCalledTimes(2);
  });

  it('caches distinct sections per session and restores them on refocus', async () => {
    commands.getSections
      .mockResolvedValueOnce([section('S1-ONLY', 0, 5)])
      .mockResolvedValueOnce([section('S2-ONLY', 0, 5)]);

    sessionStore.add(load('s1'));
    sessionStore.add(load('s2'));

    sessionStore.setFocused('s1');
    await flush();
    expect(store.sections().map((s) => s.name)).toEqual(['S1-ONLY']);

    sessionStore.setFocused('s2');
    await flush();
    expect(store.sections().map((s) => s.name)).toEqual(['S2-ONLY']);

    sessionStore.setFocused('s1');
    await flush();
    expect(store.sections().map((s) => s.name)).toEqual(['S1-ONLY']);
  });

  it('ignores a non-bugreport session entirely', async () => {
    sessionStore.add(load('plain', { sourceType: 'Logcat' }));
    sessionStore.setFocused('plain');
    await flush();

    expect(commands.getSections).not.toHaveBeenCalled();
    expect(store.isBugreportSession()).toBe(false);
  });
});

describe('createSectionsStore — selection composes the controller line set', () => {
  beforeEach(async () => {
    commands.getSections.mockResolvedValue([
      section('A', 0, 2),
      section('B', 10, 12),
    ]);
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();
  });

  it('is null (renders everything) with nothing selected', () => {
    expect(controller.lineNumbers('s1')).toBeUndefined();
    expect(store.selectionCount()).toBe(0);
  });

  it('setLineSet reflects the union of toggled sections, and clears back to null', () => {
    store.toggle(0);
    expect(controller.lineNumbers('s1')).toEqual([0, 1, 2]);
    expect(store.selectionCount()).toBe(1);

    store.toggle(10);
    expect(controller.lineNumbers('s1')).toEqual([0, 1, 2, 10, 11, 12]);
    expect(store.selectionCount()).toBe(2);

    store.toggle(0);
    expect(controller.lineNumbers('s1')).toEqual([10, 11, 12]);

    store.clearSelection();
    expect(controller.lineNumbers('s1')).toBeUndefined();
    expect(store.selectionCount()).toBe(0);
  });

  it('toggleGroup selects all when any are unselected, and clears all when all are selected', () => {
    store.toggleGroup([0, 10]);
    expect(store.isSelected(0)).toBe(true);
    expect(store.isSelected(10)).toBe(true);

    store.toggleGroup([0, 10]);
    expect(store.isSelected(0)).toBe(false);
    expect(store.isSelected(10)).toBe(false);
  });

  it('selects only the ticked one of two sections sharing a name', async () => {
    commands.getSections.mockResolvedValue([
      section('DUMP OF SERVICE x', 20, 22),
      section('DUMP OF SERVICE x', 40, 41),
    ]);
    sessionStore.add(load('dup'));
    sessionStore.setFocused('dup');
    await flush();

    store.toggle(40);
    expect(store.isSelected(40)).toBe(true);
    expect(store.isSelected(20)).toBe(false);
    expect(controller.lineNumbers('dup')).toEqual([40, 41]);
  });
});

describe('createSectionsStore — the controller is only touched for a real selection', () => {
  it('never writes a line set (or bumps the cache revision) for a session with no selection', async () => {
    const setLineSet = vi.spyOn(controller, 'setLineSet');
    commands.getSections.mockResolvedValue([section('A', 0, 2)]);
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();

    // Creating the session's state used to write `('section', null)`, whose
    // unconditional `bump()` threw away the viewport cache the viewer had just
    // warmed — on every session focus.
    expect(setLineSet).not.toHaveBeenCalled();
    expect(controller.revision('s1')).toBe(0);

    store.toggle(0);
    expect(setLineSet).toHaveBeenCalledWith('s1', 'section', new Set([0, 1, 2]));
  });

  it('never touches the controller for a non-bugreport session', async () => {
    const setLineSet = vi.spyOn(controller, 'setLineSet');
    sessionStore.add(load('plain', { sourceType: 'Logcat' }));
    sessionStore.setFocused('plain');
    await flush();

    // Reading the accessors the panel reads must not create state either.
    expect(store.sections()).toEqual([]);
    expect(store.selectionCount()).toBe(0);
    expect(setLineSet).not.toHaveBeenCalled();
    expect(controller.revision('plain')).toBe(0);
  });
});

describe('createSectionsStore — fetch failures are surfaced and retryable', () => {
  it('exposes the rejection and re-fetches on retry()', async () => {
    commands.getSections.mockRejectedValueOnce(new Error('bridge down'));
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();

    expect(store.error()).toContain('bridge down');
    expect(store.sections()).toEqual([]);

    commands.getSections.mockResolvedValueOnce([section('A', 0, 2)]);
    store.retry();
    await flush();

    expect(store.error()).toBeNull();
    expect(store.sections()).toEqual([section('A', 0, 2)]);
  });

  it('keeps one session’s error out of another session’s view', async () => {
    commands.getSections.mockRejectedValueOnce(new Error('bridge down'));
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();
    expect(store.error()).toContain('bridge down');

    commands.getSections.mockResolvedValueOnce([section('A', 0, 2)]);
    sessionStore.add(load('s2'));
    sessionStore.setFocused('s2');
    await flush();
    expect(store.error()).toBeNull();
  });
});

describe('createSectionsStore — generation guard on overlapping fetches', () => {
  it('drops a stale partial result that resolves after the complete one', async () => {
    // Fetch #1 runs against a partial index and is the slow one.
    let resolvePartial: ((value: SectionInfo[]) => void) | undefined;
    commands.getSections.mockImplementationOnce(
      () => new Promise<SectionInfo[]>((resolve) => { resolvePartial = resolve; }),
    );

    const entry = sessionStore.add(load('s1', { isIndexing: false }));
    sessionStore.setFocused('s1');
    await flush();
    expect(commands.getSections).toHaveBeenCalledTimes(1);

    // Indexing starts and completes, which invalidates the cache and fires #2.
    const complete = [section('A', 0, 9), section('B', 10, 99)];
    commands.getSections.mockResolvedValueOnce(complete);
    sessionStore.updateTotal('s1', entry.totalLines, true);
    await flush();
    sessionStore.updateTotal('s1', 100, false);
    await flush();
    expect(commands.getSections).toHaveBeenCalledTimes(2);
    expect(store.sections()).toEqual(complete);

    // #1 lands late with the 7-of-586 partial list — it must be dropped.
    resolvePartial?.([section('A', 0, 9)]);
    await flush();
    expect(store.sections()).toEqual(complete);
  });
});

describe('createSectionsStore — per-session state is pruned when a session closes', () => {
  it('drops the state, releases the controller line set, and re-fetches on reopen', async () => {
    commands.getSections.mockResolvedValue([section('A', 0, 2)]);
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();

    store.toggle(0);
    expect(controller.lineNumbers('s1')).toEqual([0, 1, 2]);

    sessionStore.remove('s1');
    await flush();
    expect(controller.lineNumbers('s1')).toBeUndefined();

    // A reopened id starts from scratch rather than inheriting the selection.
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();
    expect(store.selectionCount()).toBe(0);
    expect(commands.getSections).toHaveBeenCalledTimes(2);
  });
});

describe('createSectionsStore — jumpTo', () => {
  beforeEach(async () => {
    commands.getSections.mockResolvedValue([
      section('A', 0, 2),
      section('B', 10, 12),
    ]);
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();
  });

  it('jumps directly when no selection is active', () => {
    const pane = makePane();
    controller.attachPane('main', pane);
    controller.bindSession('s1', 'main');

    store.jumpTo({ name: 'B', startLine: 10, endLine: 12 });
    expect(pane.jumpToLine).toHaveBeenCalledWith(10);
    expect(store.notice()).toBeNull();
  });

  it('jumps when the target is inside the active selection', () => {
    const pane = makePane();
    controller.attachPane('main', pane);
    controller.bindSession('s1', 'main');

    store.toggle(0);
    store.jumpTo({ name: 'A', startLine: 0, endLine: 2 });
    expect(pane.jumpToLine).toHaveBeenCalledWith(0);
  });

  it('refuses and surfaces a notice when the target is outside the active selection', () => {
    vi.useFakeTimers();
    const pane = makePane();
    controller.attachPane('main', pane);
    controller.bindSession('s1', 'main');

    store.toggle(0);
    store.jumpTo({ name: 'B', startLine: 10, endLine: 12 });

    expect(pane.jumpToLine).not.toHaveBeenCalled();
    expect(store.notice()).toBe(OUTSIDE_FILTER_NOTICE);

    vi.advanceTimersByTime(NOTICE_MS - 1);
    expect(store.notice()).toBe(OUTSIDE_FILTER_NOTICE);
    vi.advanceTimersByTime(1);
    expect(store.notice()).toBeNull();
  });

  it('re-arms the auto-clear timer on a second refusal', () => {
    vi.useFakeTimers();
    const pane = makePane();
    controller.attachPane('main', pane);
    controller.bindSession('s1', 'main');
    store.toggle(0);

    store.jumpTo({ name: 'B', startLine: 10, endLine: 12 });
    vi.advanceTimersByTime(NOTICE_MS - 1);
    store.jumpTo({ name: 'B', startLine: 10, endLine: 12 });
    vi.advanceTimersByTime(NOTICE_MS - 1);
    expect(store.notice()).toBe(OUTSIDE_FILTER_NOTICE);
    vi.advanceTimersByTime(1);
    expect(store.notice()).toBeNull();
  });

  it('does nothing when no session is focused', () => {
    sessionStore.setFocused(null);
    expect(() => store.jumpTo({ name: 'A', startLine: 0, endLine: 2 })).not.toThrow();
  });
});

describe('createSectionsStore — dispose', () => {
  it('is idempotent and stops the notice timer', async () => {
    vi.useFakeTimers();
    commands.getSections.mockResolvedValue([section('A', 0, 2)]);
    sessionStore.add(load('s1'));
    sessionStore.setFocused('s1');
    await flush();

    store.toggle(0);
    store.jumpTo({ name: 'B', startLine: 99, endLine: 100 });
    expect(store.notice()).toBe(OUTSIDE_FILTER_NOTICE);

    expect(() => store.dispose()).not.toThrow();
    expect(() => store.dispose()).not.toThrow();
    expect(() => vi.advanceTimersByTime(NOTICE_MS)).not.toThrow();
  });
});
