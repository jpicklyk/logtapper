/**
 * Global window-level keyboard shortcuts (C3), mirroring
 * `src-next/hooks/useFileShortcuts.ts:20-46`: Ctrl/Cmd+N new workspace, +O
 * open file, +Shift+O open in editor, +Shift+S save workspace, +Shift+E open
 * export.
 *
 * Plain Ctrl/Cmd+S is deliberately NOT classified here — it stays
 * `editor/EditorTabs.tsx:58`'s own `window` listener (the editor toolbar's
 * Save). `classifyShortcut` returns `null` for unshifted `s` for exactly that
 * reason; see that file's module doc for why the shortcut lives there instead
 * of being routed through this module's actions.
 *
 * `classifyShortcut` is a pure function of the event (repeat included, so a
 * held key classifies to `null` on every auto-repeat firing) — no DOM access,
 * no dispatch. `installShortcuts` is the only side-effecting piece: one
 * `window` `keydown` listener, returning a dispose function. `App.tsx` calls
 * it from `onMount` and disposes it from `onCleanup`.
 */

/** One of the combos this module owns. Ctrl/Cmd+S (unshifted) is excluded on
 *  purpose — see the module doc. */
export type ShortcutAction = 'newWorkspace' | 'openFile' | 'openInEditor' | 'saveWorkspace' | 'openExport';

export interface ShortcutActions {
  /** Ctrl/Cmd+N. Expected to go through the same flush-before-switch path the
   *  Switcher/`WorkspaceHome`'s "New workspace" button uses
   *  (`workspace.newWorkspace()` already does this internally). */
  newWorkspace: () => void;
  /** Ctrl/Cmd+O. */
  openFileDialog: () => void;
  /** Ctrl/Cmd+Shift+O. */
  openInEditor: () => void;
  /** Ctrl/Cmd+Shift+S. */
  saveWorkspace: () => void;
  /** Ctrl/Cmd+Shift+E. */
  openExport: () => void;
  /** Consulted before every classified combo; a busy app (e.g. a file
   *  already opening) ignores the keypress entirely — no `preventDefault`,
   *  no dispatch. */
  isBusy: () => boolean;
}

/**
 * Classifies a `keydown` event into one of this module's shortcuts, or
 * `null` when the event does not match (wrong key, no Ctrl/Cmd, or a
 * held-key auto-repeat).
 *
 * Ctrl (Windows/Linux) and Cmd (`metaKey`, mac) are both accepted, same as
 * the React reference. Case is normalised via `key.toLowerCase()` — Shift
 * changes `e.key` to the upper-case letter, not a separate flag, so the
 * shift/no-shift branches below are what actually distinguish e.g. `o` from
 * `O`.
 */
export function classifyShortcut(event: KeyboardEvent): ShortcutAction | null {
  if (event.repeat) return null;
  if (!(event.ctrlKey || event.metaKey)) return null;

  const key = event.key.toLowerCase();
  if (key === 'n' && !event.shiftKey) return 'newWorkspace';
  if (key === 'o' && !event.shiftKey) return 'openFile';
  if (key === 'o' && event.shiftKey) return 'openInEditor';
  if (key === 's' && event.shiftKey) return 'saveWorkspace';
  if (key === 'e' && event.shiftKey) return 'openExport';
  return null;
}

/**
 * Installs the one `window` `keydown` listener for this module's shortcuts.
 * Returns a dispose function; `App.tsx` pairs this with `onMount`/
 * `onCleanup` so exactly one listener exists for the app's lifetime.
 *
 * `preventDefault` is called only for a classified combo, after the busy
 * check — an ignored keypress (unmatched, repeat, or busy) is left alone so
 * it can still reach the browser/editor's own handling (e.g. plain Ctrl+S
 * reaching `EditorTabs.tsx`'s listener).
 */
export function installShortcuts(actions: ShortcutActions): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    const action = classifyShortcut(event);
    if (action === null) return;
    if (actions.isBusy()) return;

    event.preventDefault();
    switch (action) {
      case 'newWorkspace':
        actions.newWorkspace();
        break;
      case 'openFile':
        actions.openFileDialog();
        break;
      case 'openInEditor':
        actions.openInEditor();
        break;
      case 'saveWorkspace':
        actions.saveWorkspace();
        break;
      case 'openExport':
        actions.openExport();
        break;
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
