import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';
import { WORKSPACE_STORAGE_KEY, createEmptyIdentity } from '../bridge/workspaceTypes';
import { formatTitle, loadPersistedIdentity, persistIdentity } from './WorkspaceContext';

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------
const store = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
  removeItem: vi.fn((key: string) => { store.delete(key); }),
  clear: vi.fn(() => { store.clear(); }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// formatTitle
// ---------------------------------------------------------------------------
describe('formatTitle', () => {
  it('shows clean workspace title without asterisk', () => {
    const id: WorkspaceIdentity = { name: 'MyProject', filePath: '/a.lts', dirty: false };
    expect(formatTitle(id)).toBe('MyProject \u2014 LogTapper');
  });

  it('shows dirty workspace title with asterisk', () => {
    const id: WorkspaceIdentity = { name: 'MyProject', filePath: '/a.lts', dirty: true };
    expect(formatTitle(id)).toBe('MyProject * \u2014 LogTapper');
  });

  it('handles Untitled workspace', () => {
    expect(formatTitle(createEmptyIdentity())).toBe('Untitled \u2014 LogTapper');
  });

  it('handles Untitled dirty workspace', () => {
    const id: WorkspaceIdentity = { name: 'Untitled', filePath: null, dirty: true };
    expect(formatTitle(id)).toBe('Untitled * \u2014 LogTapper');
  });

  it('handles name with special characters', () => {
    const id: WorkspaceIdentity = { name: 'my-log (2)', filePath: '/a.lts', dirty: false };
    expect(formatTitle(id)).toBe('my-log (2) \u2014 LogTapper');
  });
});

// ---------------------------------------------------------------------------
// loadPersistedIdentity
// ---------------------------------------------------------------------------
describe('loadPersistedIdentity', () => {
  it('returns empty identity when localStorage is empty', () => {
    const id = loadPersistedIdentity();
    expect(id).toEqual(createEmptyIdentity());
  });

  it('restores a persisted identity', () => {
    const saved: WorkspaceIdentity = { name: 'Test', filePath: '/test.lts', dirty: false };
    store.set(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));

    const id = loadPersistedIdentity();
    expect(id).toEqual(saved);
  });

  it('preserves dirty flag from persisted state (crash recovery)', () => {
    const saved: WorkspaceIdentity = { name: 'Crashed', filePath: '/x.lts', dirty: true };
    store.set(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));

    const id = loadPersistedIdentity();
    expect(id.dirty).toBe(true);
    expect(id.name).toBe('Crashed');
  });

  it('returns empty identity on corrupt JSON', () => {
    store.set(WORKSPACE_STORAGE_KEY, '{not valid json');
    const id = loadPersistedIdentity();
    expect(id).toEqual(createEmptyIdentity());
  });

  it('returns empty identity when localStorage throws', () => {
    localStorageMock.getItem.mockImplementationOnce(() => { throw new Error('quota'); });
    const id = loadPersistedIdentity();
    expect(id).toEqual(createEmptyIdentity());
  });
});

// ---------------------------------------------------------------------------
// persistIdentity
// ---------------------------------------------------------------------------
describe('persistIdentity', () => {
  it('writes identity to localStorage as JSON', () => {
    const id: WorkspaceIdentity = { name: 'Saved', filePath: '/saved.lts', dirty: false };
    persistIdentity(id);

    const raw = store.get(WORKSPACE_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(id);
  });

  it('overwrites previous value', () => {
    persistIdentity({ name: 'First', filePath: null, dirty: false });
    persistIdentity({ name: 'Second', filePath: '/s.lts', dirty: true });

    const raw = store.get(WORKSPACE_STORAGE_KEY);
    expect(JSON.parse(raw!).name).toBe('Second');
  });

  it('does not throw when localStorage is full', () => {
    localStorageMock.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceeded'); });
    // Should not throw
    expect(() => persistIdentity(createEmptyIdentity())).not.toThrow();
  });

  it('round-trips through loadPersistedIdentity', () => {
    const original: WorkspaceIdentity = { name: 'RoundTrip', filePath: '/rt.lts', dirty: true };
    persistIdentity(original);
    const loaded = loadPersistedIdentity();
    expect(loaded).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Identity state transitions (pure logic extracted from provider)
// ---------------------------------------------------------------------------
describe('identity state transitions', () => {
  // These test the pure state transition logic that the provider uses internally.
  // The provider uses: prev => prev.dirty ? prev : { ...prev, dirty: true }

  function applyMarkDirty(prev: WorkspaceIdentity): WorkspaceIdentity {
    return prev.dirty ? prev : { ...prev, dirty: true };
  }

  function applyMarkClean(name: string, filePath: string): WorkspaceIdentity {
    return { name, filePath, dirty: false };
  }

  describe('markDirty', () => {
    it('sets dirty=true on a clean workspace', () => {
      const clean: WorkspaceIdentity = { name: 'Test', filePath: '/t.lts', dirty: false };
      const result = applyMarkDirty(clean);
      expect(result.dirty).toBe(true);
      expect(result.name).toBe('Test');
      expect(result.filePath).toBe('/t.lts');
    });

    it('is idempotent — returns same reference when already dirty', () => {
      const dirty: WorkspaceIdentity = { name: 'Test', filePath: '/t.lts', dirty: true };
      const result = applyMarkDirty(dirty);
      expect(result).toBe(dirty); // same reference — React skips re-render
    });

    it('preserves null filePath', () => {
      const clean: WorkspaceIdentity = { name: 'Untitled', filePath: null, dirty: false };
      const result = applyMarkDirty(clean);
      expect(result.filePath).toBeNull();
      expect(result.dirty).toBe(true);
    });
  });

  describe('markClean', () => {
    it('resets dirty and sets name/filePath', () => {
      const result = applyMarkClean('Saved', '/saved.lts');
      expect(result).toEqual({ name: 'Saved', filePath: '/saved.lts', dirty: false });
    });

    it('creates a completely new identity (no carry-over from previous state)', () => {
      // This is intentional — markClean is a full replacement
      const result = applyMarkClean('New', '/new.lts');
      expect(result.name).toBe('New');
      expect(result.filePath).toBe('/new.lts');
      expect(result.dirty).toBe(false);
    });
  });

  describe('resetIdentity', () => {
    it('returns a fresh empty identity', () => {
      const result = createEmptyIdentity();
      expect(result).toEqual({ name: 'Untitled', filePath: null, dirty: false });
    });
  });

  describe('transition sequences', () => {
    it('new → dirty → save → clean', () => {
      let state = createEmptyIdentity();
      expect(state.dirty).toBe(false);

      // User makes a change
      state = applyMarkDirty(state);
      expect(state.dirty).toBe(true);
      expect(state.name).toBe('Untitled');

      // User saves
      state = applyMarkClean('MyLog', '/mylog.lts');
      expect(state.dirty).toBe(false);
      expect(state.name).toBe('MyLog');
      expect(state.filePath).toBe('/mylog.lts');
    });

    it('saved → dirty → dirty (idempotent) → save again', () => {
      let state = applyMarkClean('Project', '/p.lts');

      state = applyMarkDirty(state);
      expect(state.dirty).toBe(true);

      const ref = state;
      state = applyMarkDirty(state);
      expect(state).toBe(ref); // idempotent — same reference

      state = applyMarkClean('Project', '/p.lts');
      expect(state.dirty).toBe(false);
    });

    it('saved → dirty → new workspace (reset)', () => {
      let state = applyMarkClean('Old', '/old.lts');
      state = applyMarkDirty(state);
      expect(state.dirty).toBe(true);

      // User confirms discard → reset
      state = createEmptyIdentity();
      expect(state).toEqual({ name: 'Untitled', filePath: null, dirty: false });
    });

    it('saved → dirty → open different workspace', () => {
      let state = applyMarkClean('First', '/first.lts');
      state = applyMarkDirty(state);

      // User confirms discard → open new
      state = createEmptyIdentity(); // reset phase
      state = applyMarkClean('Second', '/second.lts'); // load phase

      expect(state.name).toBe('Second');
      expect(state.filePath).toBe('/second.lts');
      expect(state.dirty).toBe(false);
    });
  });
});
