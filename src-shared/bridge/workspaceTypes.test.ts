import { describe, it, expect } from 'vitest';
import {
  createEmptyWorkspace, createEmptyListState, getActiveWorkspace, formatTitle,
  WORKSPACE_STORAGE_KEY,
} from './workspaceTypes';
import type { WorkspaceIdentity, WorkspaceListState, WorkspaceSessionRef, WorkspaceEditorRef } from './workspaceTypes';

describe('workspaceTypes', () => {
  describe('createEmptyWorkspace', () => {
    it('returns an Untitled, unsaved, clean workspace with a UUID', () => {
      const ws = createEmptyWorkspace();
      expect(ws.name).toBe('Untitled');
      expect(ws.filePath).toBeNull();
      expect(ws.dirty).toBe(false);
      expect(ws.id).toBeTruthy();
      expect(ws.id.length).toBeGreaterThan(10); // UUID format
    });

    it('returns a new object with unique ID each call', () => {
      const a = createEmptyWorkspace();
      const b = createEmptyWorkspace();
      expect(a).not.toBe(b);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('createEmptyListState', () => {
    it('returns empty workspace list with no active ID', () => {
      const state = createEmptyListState();
      expect(state.workspaces).toEqual([]);
      expect(state.activeId).toBeNull();
    });
  });

  describe('getActiveWorkspace', () => {
    it('returns null when activeId is null', () => {
      const state: WorkspaceListState = { workspaces: [], activeId: null };
      expect(getActiveWorkspace(state)).toBeNull();
    });

    it('returns null when activeId does not match any workspace', () => {
      const state: WorkspaceListState = {
        workspaces: [{ id: 'ws-1', name: 'A', filePath: null, dirty: false }],
        activeId: 'ws-999',
      };
      expect(getActiveWorkspace(state)).toBeNull();
    });

    it('returns the matching workspace', () => {
      const ws: WorkspaceIdentity = { id: 'ws-1', name: 'MyProject', filePath: '/a.ltw', dirty: true };
      const state: WorkspaceListState = { workspaces: [ws], activeId: 'ws-1' };
      expect(getActiveWorkspace(state)).toBe(ws);
    });
  });

  describe('formatTitle', () => {
    it('shows clean workspace title without asterisk', () => {
      expect(formatTitle({ id: 'x', name: 'MyProject', filePath: '/a.ltw', dirty: false }))
        .toBe('MyProject \u2014 LogTapper');
    });

    it('shows dirty workspace title with asterisk', () => {
      expect(formatTitle({ id: 'x', name: 'MyProject', filePath: '/a.ltw', dirty: true }))
        .toBe('MyProject * \u2014 LogTapper');
    });

    it('returns LogTapper when workspace is null', () => {
      expect(formatTitle(null)).toBe('LogTapper');
    });
  });

  it('WORKSPACE_STORAGE_KEY is a stable string', () => {
    expect(WORKSPACE_STORAGE_KEY).toBe('logtapper_workspace_list');
  });

  describe('type shapes', () => {
    it('WorkspaceIdentity has required fields', () => {
      const id: WorkspaceIdentity = { id: 'ws-1', name: 'test', filePath: '/test.ltw', dirty: true };
      expect(id.id).toBe('ws-1');
      expect(id.name).toBe('test');
    });

    it('WorkspaceSessionRef has required fields', () => {
      const ref: WorkspaceSessionRef = {
        sessionId: 's1', paneId: 'p1', sourceName: 'logcat.log',
        sourceType: 'Logcat', isStreaming: false,
      };
      expect(ref.sessionId).toBe('s1');
    });

    it('WorkspaceEditorRef has required fields', () => {
      const ref: WorkspaceEditorRef = { editorId: 'e1', label: 'Notes', filePath: null };
      expect(ref.editorId).toBe('e1');
    });
  });
});
