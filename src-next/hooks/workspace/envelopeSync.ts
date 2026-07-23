/**
 * Shared helper for pushing the backend workspace envelope (`sync_workspace_envelope`
 * — a lightweight cache refresh, no file write). Every call site follows the same
 * shape: build the `SyncWorkspaceEnvelopeOptions` fields, fire the IPC call, and
 * `console.warn` on failure without surfacing it to the user (a missed refresh is
 * recovered by the next debounced auto-save or the next explicit push).
 */
import { syncWorkspaceEnvelope } from '../../bridge/commands';
import type { SyncWorkspaceEnvelopeOptions } from '../../bridge/types';
import type { AutoSavePayload } from '../useWorkspaceAutoSave';

/**
 * Push a fully-resolved envelope to the backend cache. `logTag` labels the
 * console.warn on failure (e.g. `'[useWorkspace]'`) so the source is
 * identifiable in the console, matching each call site's prior label.
 */
export function pushWorkspaceEnvelope(fields: SyncWorkspaceEnvelopeOptions, logTag: string): Promise<void> {
  return syncWorkspaceEnvelope(fields).catch((e: unknown) =>
    console.warn(`${logTag} Failed to sync workspace envelope:`, e));
}

/**
 * Map an `AutoSavePayload` (the auto-save hook's canonical shape) to
 * `SyncWorkspaceEnvelopeOptions` — `filePath` becomes `ltwPath`, every other
 * field passes through unchanged.
 */
export function toEnvelopeOptions(payload: AutoSavePayload): SyncWorkspaceEnvelopeOptions {
  return {
    workspaceId: payload.workspaceId,
    workspaceName: payload.workspaceName,
    ltwPath: payload.filePath,
    editorTabs: payload.editorTabs,
    layout: payload.layout,
    pipelineChain: payload.pipelineChain,
    disabledChainIds: payload.disabledChainIds,
  };
}
