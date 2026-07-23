import { describe, it, expect } from 'vitest';
import { reconcileWorkspaceList } from './reconcileWorkspaceList';
import type { WorkspaceIdentity, WorkspaceListState } from '../../bridge/workspaceTypes';
import type { AppStateFile, WorkspaceEntry } from '../../bridge/types';

// --- Factories --------------------------------------------------------------

function mem(
  workspaces: WorkspaceIdentity[],
  activeId: string | null = workspaces[0]?.id ?? null,
): WorkspaceListState {
  return { workspaces, activeId };
}

function wsId(over: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return { id: 'm-1', name: 'Untitled', filePath: null, dirty: false, ...over };
}

function disk(
  workspaces: WorkspaceEntry[],
  activeWorkspaceId: string | null = workspaces[0]?.id ?? null,
): AppStateFile {
  return { workspaces, activeWorkspaceId };
}

function wsEntry(over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return { id: 'd-1', name: 'wifi-debug', ltwPath: null, dirty: false, ...over };
}

// --- Tests ------------------------------------------------------------------

describe('reconcileWorkspaceList', () => {
  it('disk wins for the list, activeId, ltwPath, and the two auto-save fields', () => {
    const { state, migrated, createDefault } = reconcileWorkspaceList(
      mem([wsId({ id: 'm-1', name: 'stale-memory' })]),
      disk(
        [
          wsEntry({
            id: 'd-1',
            name: 'wifi-debug',
            ltwPath: '/data/wifi-debug.ltw',
            autoSavePath: '/data/workspaces/d-1.ltw',
            lastAutoSaveAt: 1_700_000_000_000,
          }),
        ],
        'd-1',
      ),
    );

    expect(migrated).toBe(false);
    expect(createDefault).toBe(false);
    expect(state.activeId).toBe('d-1');
    expect(state.workspaces).toEqual([
      {
        id: 'd-1',
        name: 'wifi-debug',
        filePath: '/data/wifi-debug.ltw',
        dirty: false,
        autoSavePath: '/data/workspaces/d-1.ltw',
        lastAutoSaveAt: 1_700_000_000_000,
      },
    ]);
    // Memory-only workspaces are dropped — disk is the list authority.
    expect(state.workspaces.map((w) => w.name)).not.toContain('stale-memory');
  });

  it('does not overwrite the in-memory dirty flag with disk (advisory only)', () => {
    // User has unsaved edits this session (memory dirty=true) but the last disk
    // flush recorded dirty=false. The UI flag must survive hydration.
    const { state } = reconcileWorkspaceList(
      mem([wsId({ id: 'ws-1', name: 'w', dirty: true })]),
      disk([wsEntry({ id: 'ws-1', name: 'w', dirty: false })]),
    );
    expect(state.workspaces[0].dirty).toBe(true);
  });

  it('uses the disk dirty flag for a workspace absent from memory', () => {
    const { state } = reconcileWorkspaceList(
      mem([wsId({ id: 'only-in-memory' })]),
      disk([wsEntry({ id: 'disk-only', dirty: true })]),
    );
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].id).toBe('disk-only');
    expect(state.workspaces[0].dirty).toBe(true);
  });

  it('defaults the auto-save fields to null when disk omits them (old file)', () => {
    const { state } = reconcileWorkspaceList(
      mem([wsId({ id: 'ws-1' })]),
      // Legacy entry without autoSavePath / lastAutoSaveAt.
      disk([{ id: 'ws-1', name: 'w', ltwPath: '/w.ltw', dirty: false }]),
    );
    expect(state.workspaces[0].autoSavePath).toBeNull();
    expect(state.workspaces[0].lastAutoSaveAt).toBeNull();
  });

  it('falls back to the first workspace when the disk activeId is dangling', () => {
    const { state } = reconcileWorkspaceList(
      mem([wsId({ id: 'ws-1' })]),
      disk(
        [wsEntry({ id: 'a' }), wsEntry({ id: 'b' })],
        'nonexistent',
      ),
    );
    expect(state.activeId).toBe('a');
  });

  it('keeps a valid disk activeId even when it is not the first entry', () => {
    const { state } = reconcileWorkspaceList(
      mem([wsId({ id: 'ws-1' })]),
      disk([wsEntry({ id: 'a' }), wsEntry({ id: 'b' })], 'b'),
    );
    expect(state.activeId).toBe('b');
  });

  it('disk empty + memory non-empty → adopts memory and signals migration', () => {
    const memory = mem(
      [wsId({ id: 'ws-1', name: 'existing-user', dirty: true })],
      'ws-1',
    );
    const { state, migrated, createDefault } = reconcileWorkspaceList(
      memory,
      disk([]),
    );
    expect(migrated).toBe(true);
    expect(createDefault).toBe(false);
    expect(state).toBe(memory); // adopted as-is
    expect(state.workspaces[0].name).toBe('existing-user');
    expect(state.activeId).toBe('ws-1');
  });

  it('both empty → signals createDefault with an empty list', () => {
    const { state, migrated, createDefault } = reconcileWorkspaceList(
      mem([]),
      disk([]),
    );
    expect(createDefault).toBe(true);
    expect(migrated).toBe(false);
    expect(state.workspaces).toHaveLength(0);
    expect(state.activeId).toBeNull();
  });

  it('disk non-empty takes precedence even when memory is also non-empty', () => {
    const { migrated, state } = reconcileWorkspaceList(
      mem([wsId({ id: 'm-1' }), wsId({ id: 'm-2' })]),
      disk([wsEntry({ id: 'd-1' })]),
    );
    expect(migrated).toBe(false);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].id).toBe('d-1');
  });
});
