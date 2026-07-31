import { useEffect, useRef } from 'react';
import { bus } from '../events';
import { performAutoSave } from './workspace/workspacePersistence';
import { pushWorkspaceEnvelope, toEnvelopeOptions } from './workspace/envelopeSync';
import { createAutoSaveGate } from './workspace/autoSaveGate';
import type { LtwEditorTab } from '../bridge/types';

const AUTO_SAVE_DEBOUNCE_MS = 3000;

export interface AutoSavePayload {
  workspaceId: string;
  workspaceName: string;
  filePath: string | null;
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
  pipelineChain: string[];
  disabledChainIds: string[];
}

/**
 * Debounced auto-save hook that listens to `workspace:mutated` events and
 * acts after 3 seconds of inactivity. What it does depends on the event's
 * `source`:
 *
 *  - 'workspace' (file loads, pipeline chain edits, processor installs,
 *    editor-tab dirty state, ...): the frontend is the only persister for
 *    these, so this runs the full `.ltw` write via `performAutoSave`, exactly
 *    as before.
 *  - 'artifact' (bookmarks, analyses — including MCP-bridge-originated ones):
 *    the backend's `schedule_autosave` (`artifact_mutations.rs`) already
 *    writes the `.ltw` on every artifact mutation. Duplicating that write
 *    here would race the backend's own write and buy nothing, so this only
 *    pushes a fresh envelope to the backend's cache (`sync_workspace_envelope`
 *    — no file write) so the backend's write reflects the current
 *    layout/tabs/chain alongside the artifact change.
 *
 * A burst of mixed sources within one debounce window collapses to exactly
 * one action: if any 'workspace' event lands before the timer fires, the
 * full `performAutoSave` runs — it is a superset of what the 'artifact'
 * branch would have done, so 'workspace' always wins over 'artifact' within
 * the same window.
 *
 * Uses refs for all mutable state to avoid causing re-renders.
 */
export function useWorkspaceAutoSave(
  buildAutoSavePayload: () => AutoSavePayload | null,
): void {
  const buildPayloadRef = useRef(buildAutoSavePayload);
  buildPayloadRef.current = buildAutoSavePayload;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingSource: 'workspace' | 'artifact' | null = null;
    const gate = createAutoSaveGate();

    const cancelPending = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // Defined outside the setTimeout callback below on purpose: the
    // `no-side-effects-in-updater` lint rule treats any `set[A-Z]…` call
    // (including `setTimeout`) as a setState updater, so a `bus.emit` lexically
    // inside the timer arrow would be flagged. Hoisting keeps the emit clean.
    const runAutoSave = () => {
      const source = pendingSource;
      pendingSource = null;
      const payload = buildPayloadRef.current();
      if (!payload) return;

      if (source === 'artifact') {
        // Backend already owns the .ltw write for artifact mutations (see the
        // JSDoc above) — only refresh its cached envelope so that write picks
        // up the current layout/tabs/chain.
        void pushWorkspaceEnvelope(toEnvelopeOptions(payload), '[useWorkspaceAutoSave]');
        return;
      }

      // No separate envelope sync here: performAutoSave's underlying command
      // (saveWorkspaceV4 / autoSaveWorkspace) already calls autosave::cache_envelope
      // with this exact payload as the first thing it does (see
      // src-tauri/src/commands/workspace_cmd.rs) — a pre-sync would just write the
      // same fields to the backend cache a moment before the save command does.
      performAutoSave(payload)
        .then((savedPath) => {
          // A non-null path means the workspace had no explicit .ltw and was
          // auto-saved to the app-data dir. Announce it so WorkspaceContext can
          // record the recovery path + timestamp onto the entry (previously
          // this return was discarded, leaving the entry's filePath null).
          if (savedPath) {
            bus.emit('workspace:auto-saved', {
              workspaceId: payload.workspaceId,
              path: savedPath,
              savedAt: Date.now(),
            });
          }
        })
        .catch((e: unknown) =>
          console.warn('[useWorkspaceAutoSave] Auto-save failed:', e),
        );
    };

    const handler = (payload: { source: 'artifact' | 'workspace' }) => {
      // A restore emits a burst of tracked mutations as it loads each session.
      // Saving then would rewrite what was just read, and a partial restore
      // would overwrite the good .ltw with the partial state.
      if (gate.isSuppressed()) return;
      // 'workspace' wins and sticks for the rest of this debounce window —
      // see the JSDoc above for why a later 'artifact' event must not
      // downgrade an already-pending 'workspace' save.
      if (pendingSource !== 'workspace') {
        pendingSource = payload.source;
      }
      cancelPending();
      timer = setTimeout(() => {
        timer = null;
        runAutoSave();
      }, AUTO_SAVE_DEBOUNCE_MS);
    };

    const onRestoreBegin = () => {
      gate.beginRestore();
      // Drop anything already scheduled — it was queued against pre-restore
      // state and would fire mid-restore.
      cancelPending();
      pendingSource = null;
    };
    const onRestoreEnd = () => gate.endRestore();

    bus.on('workspace:mutated', handler);
    bus.on('workspace:restore-begin', onRestoreBegin);
    bus.on('workspace:restore-end', onRestoreEnd);
    return () => {
      bus.off('workspace:mutated', handler);
      bus.off('workspace:restore-begin', onRestoreBegin);
      bus.off('workspace:restore-end', onRestoreEnd);
      gate.reset();
      cancelPending();
    };
  }, []);
}
