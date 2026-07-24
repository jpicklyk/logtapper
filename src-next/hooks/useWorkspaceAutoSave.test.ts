// @vitest-environment jsdom
/**
 * Tests for useWorkspaceAutoSave's source discrimination (work item ef0bf50c).
 *
 * Backend durability for artifact mutations (bookmarks, analyses — including
 * MCP-bridge-originated ones) is now owned by the backend's `schedule_autosave`
 * (`artifact_mutations.rs`), which writes the `.ltw` on every artifact
 * mutation. The frontend's debounced auto-save no longer duplicates that
 * write for 'artifact'-sourced `workspace:mutated` events — it only refreshes
 * the backend's cached envelope (`sync_workspace_envelope`) so that write
 * reflects the current layout/tabs/chain. 'workspace'-sourced events (file
 * loads, chain edits, processor installs, editor-tab dirty state, ...) are
 * still the frontend's sole responsibility and keep running the full
 * `performAutoSave` `.ltw` write, exactly as before this change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { bus } from '../events/bus';

const mockPerformAutoSave = vi.fn();
const mockPushWorkspaceEnvelope = vi.fn();

vi.mock('./workspace/workspacePersistence', () => ({
  performAutoSave: (...args: unknown[]) => mockPerformAutoSave(...args),
}));

vi.mock('./workspace/envelopeSync', () => ({
  pushWorkspaceEnvelope: (...args: unknown[]) => mockPushWorkspaceEnvelope(...args),
  toEnvelopeOptions: (payload: {
    workspaceId: string; workspaceName: string; filePath: string | null;
    editorTabs: unknown; layout: unknown; pipelineChain: string[]; disabledChainIds: string[];
  }) => ({
    workspaceId: payload.workspaceId,
    workspaceName: payload.workspaceName,
    ltwPath: payload.filePath,
    editorTabs: payload.editorTabs,
    layout: payload.layout,
    pipelineChain: payload.pipelineChain,
    disabledChainIds: payload.disabledChainIds,
  }),
}));

import { useWorkspaceAutoSave, type AutoSavePayload } from './useWorkspaceAutoSave';

const AUTO_SAVE_DEBOUNCE_MS = 3000;

function makePayload(overrides: Partial<AutoSavePayload> = {}): AutoSavePayload {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Test Workspace',
    filePath: null,
    editorTabs: [],
    layout: null,
    pipelineChain: [],
    disabledChainIds: [],
    ...overrides,
  };
}

describe('useWorkspaceAutoSave — source discrimination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPerformAutoSave.mockReset().mockResolvedValue(null);
    mockPushWorkspaceEnvelope.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('artifact-sourced mutation pushes the envelope only (no .ltw write)', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave(() => makePayload()));

    bus.emit('workspace:mutated', { source: 'artifact' });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(mockPushWorkspaceEnvelope).toHaveBeenCalledTimes(1);
    expect(mockPerformAutoSave).not.toHaveBeenCalled();

    unmount();
  });

  it('workspace-sourced mutation runs the full debounced auto-save', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave(() => makePayload()));

    bus.emit('workspace:mutated', { source: 'workspace' });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(mockPerformAutoSave).toHaveBeenCalledTimes(1);
    expect(mockPushWorkspaceEnvelope).not.toHaveBeenCalled();

    unmount();
  });

  it('mixed burst (artifact then workspace) collapses to one full auto-save', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave(() => makePayload()));

    bus.emit('workspace:mutated', { source: 'artifact' });
    bus.emit('workspace:mutated', { source: 'workspace' });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(mockPerformAutoSave).toHaveBeenCalledTimes(1);
    expect(mockPushWorkspaceEnvelope).not.toHaveBeenCalled();

    unmount();
  });

  it('mixed burst (workspace then artifact) still collapses to one full auto-save — workspace sticks', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave(() => makePayload()));

    bus.emit('workspace:mutated', { source: 'workspace' });
    bus.emit('workspace:mutated', { source: 'artifact' });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(mockPerformAutoSave).toHaveBeenCalledTimes(1);
    expect(mockPushWorkspaceEnvelope).not.toHaveBeenCalled();

    unmount();
  });

  it('two artifact-only bursts collapse to a single envelope push', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave(() => makePayload()));

    bus.emit('workspace:mutated', { source: 'artifact' });
    bus.emit('workspace:mutated', { source: 'artifact' });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(mockPushWorkspaceEnvelope).toHaveBeenCalledTimes(1);
    expect(mockPerformAutoSave).not.toHaveBeenCalled();

    unmount();
  });

  it('a fresh window after one completes is evaluated independently (no source leakage)', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave(() => makePayload()));

    bus.emit('workspace:mutated', { source: 'workspace' });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    expect(mockPerformAutoSave).toHaveBeenCalledTimes(1);

    // A later, purely artifact-sourced burst must not still be marked
    // 'workspace' from the prior window.
    bus.emit('workspace:mutated', { source: 'artifact' });
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(mockPushWorkspaceEnvelope).toHaveBeenCalledTimes(1);
    expect(mockPerformAutoSave).toHaveBeenCalledTimes(1); // unchanged

    unmount();
  });

  it('restore-begin discards a pending artifact-sourced push and its source', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave(() => makePayload()));

    bus.emit('workspace:mutated', { source: 'artifact' });
    bus.emit('workspace:restore-begin', undefined);
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(mockPushWorkspaceEnvelope).not.toHaveBeenCalled();
    expect(mockPerformAutoSave).not.toHaveBeenCalled();

    bus.emit('workspace:restore-end', undefined);
    unmount();
  });
});
