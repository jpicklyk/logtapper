import { useEffect, useRef } from 'react';
import { useWorkspaceActions } from '../context';
import { bus } from '../events/bus';
import type { ToastItem } from '../ui';

let toastCounter = 0;

/**
 * Surfaces the Q3 "untrusted auto-save" notice (design:
 * `plans/workspace-restore-design.md` §Q3). When Q2's startup restore finds a
 * candidate auto-save `.ltw` that fails the trust gate, it emits
 * `workspace:untrusted-autosave`; the app has already fallen back to the plain
 * localStorage plan (no regression). This shows a **non-blocking** toast at the
 * same altitude as `file:lts-already-open` (see `useLtsImportToast`):
 *
 *   "An auto-saved workspace from {date} was found but doesn't match this
 *    workspace ({reason}). [Open it] [Dismiss]"
 *
 * The whole toast is the "Open it" affordance — it routes through the normal
 * `openWorkspace(path)` flow as a **new** workspace entry, so the recovered file
 * can never contaminate the current workspace. The toast's built-in close (✕) is
 * "Dismiss". There is no delete action — eviction (Q4 housekeeping) handles
 * cleanup.
 *
 * Mount alongside the other toast hooks (see `useAppShellSetup`). The producer
 * (`workspace:untrusted-autosave`) is Q2's `useStartupRestore`, which does not
 * exist yet; until it lands this hook simply idles.
 */
export function useUntrustedAutoSaveToast(addToast: (toast: ToastItem) => void): void {
  const { openWorkspace } = useWorkspaceActions();

  // Refs so the persistent bus subscription always calls the latest callbacks.
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;
  const openWorkspaceRef = useRef(openWorkspace);
  openWorkspaceRef.current = openWorkspace;

  useEffect(() => {
    const onUntrusted = (e: {
      workspaceId: string;
      candidatePath: string;
      savedAt: number;
      reasons: string[];
    }) => {
      addToastRef.current({
        id: `untrusted-autosave-${++toastCounter}`,
        title: 'Auto-saved workspace not restored',
        message:
          `An auto-saved workspace from ${formatSavedAt(e.savedAt)} was found but ` +
          `doesn't match this workspace (${describeReason(e.reasons[0])}). ` +
          `Click to open it as a new workspace.`,
        // Whole-toast click = "Open it"; opens as a NEW workspace entry so it
        // cannot overwrite the current one.
        onClick: () => openWorkspaceRef.current(e.candidatePath),
      });
    };
    bus.on('workspace:untrusted-autosave', onUntrusted);
    return () => {
      bus.off('workspace:untrusted-autosave', onUntrusted);
    };
  }, []);
}

/** Format the manifest `savedAt` epoch-ms as a short human date for the notice. */
function formatSavedAt(savedAt: number): string {
  try {
    return new Date(savedAt).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'an earlier session';
  }
}

/** Map a machine-readable verdict reason to a short human phrase. */
function describeReason(reason: string | undefined): string {
  switch (reason) {
    case 'workspace-id-mismatch':
      return 'it belongs to a different workspace';
    case 'timestamp-outside-tolerance':
      return "its save time doesn't line up";
    case 'legacy-no-path-intersection':
      return 'none of its files are open here';
    case 'legacy-no-tab-paths':
      return 'there are no open files to match it against';
    case 'candidate-unreadable':
      return 'its file could not be read';
    default:
      return 'it failed a safety check';
  }
}
