import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadResult } from '@bridge/types';
import type { Bookmark, BookmarkUpdateEvent } from '@bridge/types';
import { CacheManager, DataSourceRegistry, createViewerController } from '../viewer';
import type { ViewerController } from '../viewer';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import { createSessionStore } from '../app/index';
import type { SessionStore } from '../app/index';
import { createBookmarksStore, categoryAccentVar, categoryLabel } from './bookmarksStore';
import type { BookmarksCommands, BookmarksStore } from './bookmarksStore';

vi.mock('@bridge/events', () => ({
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
  // Never called directly — every test injects its own `listen` — but the
  // store destructures the real export as its default at import time.
  onBookmarkUpdate: vi.fn(() => Promise.resolve(() => {})),
}));

const bridgeCommands = vi.hoisted(() => ({
  getLines: vi.fn(),
  setFocusedSession: vi.fn(() => Promise.resolve()),
  // Never called directly — every test injects its own `commands` — but the
  // store's default-commands object destructures these at import time, so
  // the mock module must define them.
  listBookmarks: vi.fn(() => Promise.resolve([])),
  createBookmark: vi.fn(),
  updateBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
}));
vi.mock('@bridge/commands', () => bridgeCommands);

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

function bookmark(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    sessionId: 's1',
    lineNumber: 10,
    label: `Bookmark ${id}`,
    note: '',
    createdBy: 'User',
    createdAt: Date.now(),
    ...overrides,
  };
}

function updateEvent(action: BookmarkUpdateEvent['action'], b: Bookmark): BookmarkUpdateEvent {
  return { sessionId: b.sessionId, action, bookmark: b };
}

/** Fake `onBookmarkUpdate`: captures the handler and exposes `emit`/`unlisten`. */
function makeListen() {
  let handler: ((payload: BookmarkUpdateEvent) => void) | null = null;
  const unlisten = vi.fn();
  const listen = vi.fn((cb: (payload: BookmarkUpdateEvent) => void) => {
    handler = cb;
    return Promise.resolve(unlisten);
  });
  return { listen, unlisten, emit: (payload: BookmarkUpdateEvent) => handler?.(payload) };
}

function makeCommands(): BookmarksCommands {
  return {
    listBookmarks: vi.fn(() => Promise.resolve([])),
    createBookmark: vi.fn(),
    updateBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
  };
}

/** Drain enough microtasks for the store's promise chains to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

let cacheManager: CacheManager;
let registry: DataSourceRegistry;
let controller: ViewerController;
let sessionStore: SessionStore;
let commands: BookmarksCommands;
let listen: ReturnType<typeof makeListen>;
let store: BookmarksStore;

beforeEach(() => {
  vi.clearAllMocks();
  bridgeCommands.getLines.mockResolvedValue(page(0));
  bridgeCommands.setFocusedSession.mockResolvedValue(undefined);
  cacheManager = new CacheManager(10_000);
  registry = new DataSourceRegistry();
  controller = createViewerController({ focusSession: vi.fn() });
  sessionStore = createSessionStore({ cacheManager, registry, controller });
  commands = makeCommands();
  listen = makeListen();
  store = createBookmarksStore({ sessions: sessionStore, controller, commands, listen: listen.listen as never });
});

afterEach(() => {
  store.dispose();
  sessionStore.dispose();
  controller.dispose();
});

describe('createBookmarksStore', () => {
  describe('lazy fetch on focus', () => {
    it('fetches a session\'s bookmarks the first time it is focused', async () => {
      const b1 = bookmark('b1');
      (commands.listBookmarks as ReturnType<typeof vi.fn>).mockResolvedValue([b1]);
      sessionStore.add(load('s1')); // add() focuses the first session it holds
      await flush();
      expect(commands.listBookmarks).toHaveBeenCalledWith('s1');
      expect(store.list('s1')).toEqual([b1]);
      expect(store.loading('s1')).toBe(false);
    });

    it('does not re-fetch on a second focus of the same session', async () => {
      sessionStore.add(load('s1'));
      sessionStore.add(load('s2'));
      await flush();
      (commands.listBookmarks as ReturnType<typeof vi.fn>).mockClear();
      sessionStore.setFocused('s1'); // re-focus s1, already fetched
      await flush();
      expect(commands.listBookmarks).not.toHaveBeenCalledWith('s1');
    });

    it('an event applied while the initial fetch is still in flight survives the fetch resolving', async () => {
      let resolveFetch!: (bookmarks: Bookmark[]) => void;
      (commands.listBookmarks as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<Bookmark[]>((res) => { resolveFetch = res; }),
      );
      sessionStore.add(load('s1')); // kicks off the (still-pending) fetch
      const b = bookmark('b1');
      listen.emit(updateEvent('created', b)); // event lands before the fetch resolves
      resolveFetch([]); // server's stale snapshot, from before the create
      await flush();
      expect(store.list('s1')).toEqual([b]);
    });

    it('fetches once per distinct session id', async () => {
      sessionStore.add(load('s1'));
      sessionStore.add(load('s2'));
      sessionStore.setFocused('s2');
      await flush();
      expect(commands.listBookmarks).toHaveBeenCalledWith('s1');
      expect(commands.listBookmarks).toHaveBeenCalledWith('s2');
      expect(commands.listBookmarks).toHaveBeenCalledTimes(2);
    });
  });

  describe('categories', () => {
    it('groups bookmarks by category in declared order, sorted by line within a group', () => {
      sessionStore.add(load('s1'));
      const b1 = bookmark('b1', { category: 'warning', lineNumber: 20 });
      const b2 = bookmark('b2', { category: 'error', lineNumber: 5 });
      const b3 = bookmark('b3', { category: 'error', lineNumber: 1 });
      listen.emit(updateEvent('created', b1));
      listen.emit(updateEvent('created', b2));
      listen.emit(updateEvent('created', b3));
      const groups = store.categories('s1');
      expect(groups.map((g) => g.id)).toEqual(['error', 'warning']);
      expect(groups[0].bookmarks.map((b) => b.id)).toEqual(['b3', 'b2']); // sorted by line
      expect(groups[0].count).toBe(2);
    });

    it('groups an unrecognised category id under its own label, after the defaults', () => {
      sessionStore.add(load('s1'));
      listen.emit(updateEvent('created', bookmark('b1', { category: 'weird' })));
      listen.emit(updateEvent('created', bookmark('b2', { category: 'error' })));
      const groups = store.categories('s1');
      expect(groups.map((g) => g.id)).toEqual(['error', 'weird']);
    });

    it('defaults an absent category to "custom"', () => {
      sessionStore.add(load('s1'));
      listen.emit(updateEvent('created', bookmark('b1', { category: undefined })));
      expect(store.categories('s1')).toEqual([
        expect.objectContaining({ id: 'custom', count: 1 }),
      ]);
    });
  });

  describe('update dedupe', () => {
    it('a duplicate "created" delivery for the same id is applied once', () => {
      sessionStore.add(load('s1'));
      const b = bookmark('b1');
      listen.emit(updateEvent('created', b));
      listen.emit(updateEvent('created', b));
      expect(store.list('s1')).toEqual([b]);
    });

    it('a duplicate "updated" delivery converges to the same state as one', () => {
      sessionStore.add(load('s1'));
      listen.emit(updateEvent('created', bookmark('b1', { label: 'first' })));
      const updated = bookmark('b1', { label: 'second' });
      listen.emit(updateEvent('updated', updated));
      listen.emit(updateEvent('updated', updated));
      expect(store.list('s1')).toEqual([updated]);
    });

    it('a duplicate "deleted" delivery is a no-op the second time', () => {
      sessionStore.add(load('s1'));
      const b = bookmark('b1');
      listen.emit(updateEvent('created', b));
      listen.emit(updateEvent('deleted', b));
      listen.emit(updateEvent('deleted', b));
      expect(store.list('s1')).toEqual([]);
    });
  });

  describe('create/update/remove', () => {
    it('create() calls createBookmark with the expected arguments and appends the result', async () => {
      sessionStore.add(load('s1'));
      const created = bookmark('new');
      (commands.createBookmark as ReturnType<typeof vi.fn>).mockResolvedValue(created);
      const result = await store.create('s1', { line: 5, label: 'My label', note: 'a note', category: 'timing' });
      expect(commands.createBookmark).toHaveBeenCalledWith('s1', 5, 'My label', 'a note', 'User', undefined, undefined, 'timing');
      expect(result).toBe(created);
      expect(store.list('s1')).toEqual([created]);
    });

    it('create() falls back to a "Line N" label when none is given', async () => {
      sessionStore.add(load('s1'));
      (commands.createBookmark as ReturnType<typeof vi.fn>).mockResolvedValue(bookmark('new'));
      await store.create('s1', { line: 4, note: '' });
      expect(commands.createBookmark).toHaveBeenCalledWith('s1', 4, 'Line 5', '', 'User', undefined, undefined, undefined);
    });

    it('a create() result already applied by a racing event is not duplicated', async () => {
      sessionStore.add(load('s1'));
      const created = bookmark('new');
      (commands.createBookmark as ReturnType<typeof vi.fn>).mockResolvedValue(created);
      const promise = store.create('s1', { line: 1 });
      listen.emit(updateEvent('created', created)); // event arrives before the command resolves
      await promise;
      expect(store.list('s1')).toEqual([created]);
    });

    it('update() resolves the owning session and calls updateBookmark', async () => {
      sessionStore.add(load('s1'));
      listen.emit(updateEvent('created', bookmark('b1')));
      const updated = bookmark('b1', { label: 'renamed' });
      (commands.updateBookmark as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
      const result = await store.update('b1', { label: 'renamed' });
      expect(commands.updateBookmark).toHaveBeenCalledWith('s1', 'b1', 'renamed', undefined, undefined);
      expect(result).toBe(updated);
      expect(store.list('s1')).toEqual([updated]);
    });

    it('update() rejects for an unknown bookmark id', async () => {
      await expect(store.update('missing', { label: 'x' })).rejects.toThrow(/Unknown bookmark/);
      expect(commands.updateBookmark).not.toHaveBeenCalled();
    });

    it('remove() rejects for an unknown bookmark id, symmetrically with update()', async () => {
      // Resolving here told the caller the delete had succeeded when nothing
      // was ever sent to the backend.
      await expect(store.remove('missing')).rejects.toThrow(/Unknown bookmark/);
      expect(commands.deleteBookmark).not.toHaveBeenCalled();
    });

    it('remove() resolves the owning session, calls deleteBookmark, and drops the entry', async () => {
      sessionStore.add(load('s1'));
      listen.emit(updateEvent('created', bookmark('b1')));
      (commands.deleteBookmark as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      await store.remove('b1');
      expect(commands.deleteBookmark).toHaveBeenCalledWith('s1', 'b1');
      expect(store.list('s1')).toEqual([]);
    });
  });

  describe('events for sessions this UI does not have', () => {
    it('ignores a "created" for a session that is not open', () => {
      sessionStore.add(load('s1'));
      listen.emit(updateEvent('created', bookmark('ghost', { sessionId: 'closed-session' })));
      expect(store.list('closed-session')).toEqual([]);
      // And nothing was minted for it: an `update` for that id cannot resolve
      // an owner, which is only true if no phantom state was created.
      expect(store.list('s1')).toEqual([]);
    });

    it('ignores an "updated"/"deleted" for a session with no state', () => {
      const b = bookmark('b1', { sessionId: 'never-focused' });
      listen.emit(updateEvent('updated', b));
      listen.emit(updateEvent('deleted', b));
      expect(store.list('never-focused')).toEqual([]);
    });

    it('prunes a session\'s bookmarks when it closes, and re-fetches if it reopens', async () => {
      const b = bookmark('b1');
      (commands.listBookmarks as ReturnType<typeof vi.fn>).mockResolvedValue([b]);
      sessionStore.add(load('s1'));
      await flush();
      expect(store.list('s1')).toEqual([b]);

      sessionStore.remove('s1');
      await flush();
      expect(store.list('s1')).toEqual([]);

      // A close followed by a late event must not resurrect the state.
      listen.emit(updateEvent('updated', bookmark('b1', { label: 'late' })));
      expect(store.list('s1')).toEqual([]);

      (commands.listBookmarks as ReturnType<typeof vi.fn>).mockClear();
      sessionStore.add(load('s1'));
      await flush();
      expect(commands.listBookmarks).toHaveBeenCalledWith('s1');
    });
  });

  describe('fetch failures', () => {
    it('surfaces a listBookmarks rejection and re-fetches on retry()', async () => {
      (commands.listBookmarks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bridge down'));
      sessionStore.add(load('s1'));
      await flush();

      // Previously this rendered as "No bookmarks yet." and never retried —
      // the fetch effect's only dependency (`focusedId`) had not changed.
      expect(store.error('s1')).toContain('bridge down');
      expect(store.loading('s1')).toBe(false);

      const b = bookmark('b1');
      (commands.listBookmarks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([b]);
      store.retry('s1');
      await flush();

      expect(store.error('s1')).toBeNull();
      expect(store.list('s1')).toEqual([b]);
    });
  });

  describe('exportMarkdown (pure module reuse)', () => {
    it('matches exportBookmarksAsMarkdown\'s own output for the same inputs', async () => {
      const { exportBookmarksAsMarkdown } = await import('@bookmarks');
      sessionStore.add(load('s1', { sourceName: 'app.log' }));
      const b = bookmark('b1', { lineNumber: 41, label: 'Boot complete' });
      listen.emit(updateEvent('created', b));
      const expected = exportBookmarksAsMarkdown([b], { sourceName: 'app.log', totalLines: 100 });
      // Both renders stamp `**Exported:**` with the wall clock; under a loaded
      // full-suite run they can land a millisecond apart, so compare without it.
      const withoutExportedAt = (md: string): string => md.replace(/^\*\*Exported:\*\* .*$/m, '');
      expect(withoutExportedAt(store.exportMarkdown('s1'))).toBe(withoutExportedAt(expected));
      expect(store.exportMarkdown('s1')).toMatch(/^\*\*Exported:\*\* \d{4}-\d{2}-\d{2}T/m);
    });
  });

  describe('jumpTo / cursorLine', () => {
    it('jumpTo scrolls using the bookmark\'s own sessionId, highlighting a range when present', () => {
      const spy = vi.spyOn(controller, 'scrollToLine');
      const b = bookmark('b1', { sessionId: 's2', lineNumber: 7, lineNumberEnd: 9 });
      store.jumpTo(b);
      expect(spy).toHaveBeenCalledWith('s2', 7, { highlight: true, select: [7, 9], source: 'user' });
    });

    it('jumpTo omits select for a single-line bookmark', () => {
      const spy = vi.spyOn(controller, 'scrollToLine');
      store.jumpTo(bookmark('b1', { sessionId: 's1', lineNumber: 3 }));
      expect(spy).toHaveBeenCalledWith('s1', 3, { highlight: true, select: undefined, source: 'user' });
    });

    it('cursorLine reflects the controller cursor only when it is on the given session', () => {
      controller.scrollToLine('s1', 12);
      expect(store.cursorLine('s1')).toBe(12);
      expect(store.cursorLine('s2')).toBeNull();
    });
  });

  describe('dispose', () => {
    it('unlistens on dispose, and unlistens immediately if the listen promise settles after', async () => {
      store.dispose();
      await flush();
      expect(listen.unlisten).toHaveBeenCalledTimes(1);

      let resolveListen!: (fn: () => void) => void;
      const lateUnlisten = vi.fn();
      const lateListen = vi.fn(() => new Promise<() => void>((res) => { resolveListen = res; }));
      const lateStore = createBookmarksStore({ sessions: sessionStore, controller, commands, listen: lateListen as never });
      lateStore.dispose();
      resolveListen(lateUnlisten);
      await flush();
      expect(lateUnlisten).toHaveBeenCalledTimes(1);
    });
  });

  describe('token/label helpers', () => {
    it('categoryAccentVar assigns bookmark-1..6 by declared order, falling back to the last slot', () => {
      expect(categoryAccentVar('error')).toBe('var(--bookmark-1)');
      expect(categoryAccentVar('custom')).toBe('var(--bookmark-6)');
      expect(categoryAccentVar('nonsense')).toBe('var(--bookmark-6)');
    });

    it('categoryLabel falls back to "Other" for an unrecognised id', () => {
      expect(categoryLabel('timing')).toBe('Timing');
      expect(categoryLabel('nonsense')).toBe('Other');
    });
  });
});
