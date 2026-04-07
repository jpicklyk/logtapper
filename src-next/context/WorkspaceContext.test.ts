import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceIdentity, WorkspaceListState } from '../bridge/workspaceTypes';
import { createEmptyWorkspace, createEmptyListState, getActiveWorkspace, WORKSPACE_STORAGE_KEY } from '../bridge/workspaceTypes';
import { loadPersistedList, persistList } from './WorkspaceContext';

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
// loadPersistedList / persistList
// ---------------------------------------------------------------------------
describe('loadPersistedList', () => {
  it('returns empty list when localStorage is empty', () => {
    const state = loadPersistedList();
    expect(state.workspaces).toEqual([]);
    expect(state.activeId).toBeNull();
  });

  it('restores a persisted list', () => {
    const saved: WorkspaceListState = {
      workspaces: [
        { id: 'ws-1', name: 'Test', filePath: '/test.ltw', dirty: false },
      ],
      activeId: 'ws-1',
    };
    store.set(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));

    const state = loadPersistedList();
    expect(state.workspaces.length).toBe(1);
    expect(state.workspaces[0].name).toBe('Test');
    expect(state.activeId).toBe('ws-1');
  });

  it('preserves dirty flags (crash recovery)', () => {
    const saved: WorkspaceListState = {
      workspaces: [
        { id: 'ws-1', name: 'Dirty', filePath: '/x.ltw', dirty: true },
        { id: 'ws-2', name: 'Clean', filePath: '/y.ltw', dirty: false },
      ],
      activeId: 'ws-1',
    };
    store.set(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));

    const state = loadPersistedList();
    expect(state.workspaces[0].dirty).toBe(true);
    expect(state.workspaces[1].dirty).toBe(false);
  });

  it('returns empty list on corrupt JSON', () => {
    store.set(WORKSPACE_STORAGE_KEY, '{not valid json');
    const state = loadPersistedList();
    expect(state.workspaces).toEqual([]);
  });
});

describe('persistList', () => {
  it('round-trips through loadPersistedList', () => {
    const original: WorkspaceListState = {
      workspaces: [
        { id: 'ws-1', name: 'RoundTrip', filePath: '/rt.ltw', dirty: true },
      ],
      activeId: 'ws-1',
    };
    persistList(original);
    const loaded = loadPersistedList();
    expect(loaded).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Workspace list state transitions
// ---------------------------------------------------------------------------
describe('workspace list state transitions', () => {
  function addWorkspace(state: WorkspaceListState, ws: WorkspaceIdentity): WorkspaceListState {
    return { workspaces: [...state.workspaces, ws], activeId: ws.id };
  }

  function removeWorkspace(state: WorkspaceListState, id: string): WorkspaceListState {
    const remaining = state.workspaces.filter(w => w.id !== id);
    let nextActiveId = state.activeId;
    if (state.activeId === id) {
      const removedIdx = state.workspaces.findIndex(w => w.id === id);
      nextActiveId = remaining.length > 0
        ? remaining[Math.min(removedIdx, remaining.length - 1)].id
        : null;
    }
    return { workspaces: remaining, activeId: nextActiveId };
  }

  function markDirty(state: WorkspaceListState): WorkspaceListState {
    if (!state.activeId) return state;
    const idx = state.workspaces.findIndex(w => w.id === state.activeId);
    if (idx === -1 || state.workspaces[idx].dirty) return state;
    const next = [...state.workspaces];
    next[idx] = { ...next[idx], dirty: true };
    return { ...state, workspaces: next };
  }

  function markClean(state: WorkspaceListState, name: string, filePath: string): WorkspaceListState {
    if (!state.activeId) return state;
    const idx = state.workspaces.findIndex(w => w.id === state.activeId);
    if (idx === -1) return state;
    const next = [...state.workspaces];
    next[idx] = { ...next[idx], name, filePath, dirty: false };
    return { ...state, workspaces: next };
  }

  it('add workspace makes it active', () => {
    const ws = createEmptyWorkspace();
    const state = addWorkspace(createEmptyListState(), ws);
    expect(state.workspaces.length).toBe(1);
    expect(state.activeId).toBe(ws.id);
  });

  it('add second workspace switches active', () => {
    const ws1 = createEmptyWorkspace();
    const ws2 = createEmptyWorkspace();
    let state = addWorkspace(createEmptyListState(), ws1);
    state = addWorkspace(state, ws2);
    expect(state.workspaces.length).toBe(2);
    expect(state.activeId).toBe(ws2.id);
  });

  it('remove active workspace selects next', () => {
    const ws1 = { ...createEmptyWorkspace(), name: 'First' };
    const ws2 = { ...createEmptyWorkspace(), name: 'Second' };
    let state = addWorkspace(createEmptyListState(), ws1);
    state = addWorkspace(state, ws2);
    state = { ...state, activeId: ws1.id }; // switch back to first

    state = removeWorkspace(state, ws1.id);
    expect(state.workspaces.length).toBe(1);
    expect(state.activeId).toBe(ws2.id);
  });

  it('remove last workspace results in null active', () => {
    const ws = createEmptyWorkspace();
    let state = addWorkspace(createEmptyListState(), ws);
    state = removeWorkspace(state, ws.id);
    expect(state.workspaces.length).toBe(0);
    expect(state.activeId).toBeNull();
  });

  it('markDirty sets active workspace dirty', () => {
    const ws = createEmptyWorkspace();
    let state = addWorkspace(createEmptyListState(), ws);
    expect(getActiveWorkspace(state)!.dirty).toBe(false);

    state = markDirty(state);
    expect(getActiveWorkspace(state)!.dirty).toBe(true);
  });

  it('markDirty is idempotent', () => {
    const ws = createEmptyWorkspace();
    let state = addWorkspace(createEmptyListState(), ws);
    state = markDirty(state);
    const ref = state;
    state = markDirty(state);
    expect(state).toBe(ref); // same reference — no re-render
  });

  it('markClean resets dirty and sets name/path', () => {
    const ws = createEmptyWorkspace();
    let state = addWorkspace(createEmptyListState(), ws);
    state = markDirty(state);
    state = markClean(state, 'Saved', '/saved.ltw');

    const active = getActiveWorkspace(state)!;
    expect(active.dirty).toBe(false);
    expect(active.name).toBe('Saved');
    expect(active.filePath).toBe('/saved.ltw');
  });

  it('full lifecycle: new → dirty → save → new → switch', () => {
    const ws1 = createEmptyWorkspace();
    let state = addWorkspace(createEmptyListState(), ws1);

    // Make dirty
    state = markDirty(state);
    expect(getActiveWorkspace(state)!.dirty).toBe(true);

    // Save
    state = markClean(state, 'ProjectA', '/a.ltw');
    expect(getActiveWorkspace(state)!.dirty).toBe(false);

    // Add second workspace
    const ws2 = createEmptyWorkspace();
    state = addWorkspace(state, ws2);
    expect(state.activeId).toBe(ws2.id);
    expect(state.workspaces.length).toBe(2);

    // Switch back
    state = { ...state, activeId: ws1.id };
    expect(getActiveWorkspace(state)!.name).toBe('ProjectA');
  });
});
