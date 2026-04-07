import { describe, it, expect } from 'vitest';
import { createEmptyIdentity, WORKSPACE_STORAGE_KEY } from './workspaceTypes';
import type { WorkspaceIdentity, WorkspaceSessionRef, WorkspaceEditorRef } from './workspaceTypes';

describe('workspaceTypes', () => {
  describe('createEmptyIdentity', () => {
    it('returns an Untitled, unsaved, clean workspace', () => {
      const id = createEmptyIdentity();
      expect(id.name).toBe('Untitled');
      expect(id.filePath).toBeNull();
      expect(id.dirty).toBe(false);
    });

    it('returns a new object each call (no shared reference)', () => {
      const a = createEmptyIdentity();
      const b = createEmptyIdentity();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  it('WORKSPACE_STORAGE_KEY is a stable string', () => {
    expect(WORKSPACE_STORAGE_KEY).toBe('logtapper_workspace_identity');
  });

  // Type-level smoke tests — ensure interfaces compile with expected shapes
  describe('type shapes', () => {
    it('WorkspaceIdentity has required fields', () => {
      const id: WorkspaceIdentity = { name: 'test', filePath: '/test.lts', dirty: true };
      expect(id.name).toBe('test');
      expect(id.filePath).toBe('/test.lts');
      expect(id.dirty).toBe(true);
    });

    it('WorkspaceSessionRef has required fields', () => {
      const ref: WorkspaceSessionRef = {
        sessionId: 's1',
        paneId: 'p1',
        sourceName: 'logcat.log',
        sourceType: 'Logcat',
        isStreaming: false,
      };
      expect(ref.sessionId).toBe('s1');
      expect(ref.isStreaming).toBe(false);
    });

    it('WorkspaceEditorRef has required fields', () => {
      const ref: WorkspaceEditorRef = {
        editorId: 'e1',
        label: 'Notes',
        filePath: null,
      };
      expect(ref.editorId).toBe('e1');
      expect(ref.filePath).toBeNull();
    });
  });
});
