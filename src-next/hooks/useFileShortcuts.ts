import { useEffect, useRef } from 'react';

interface FileShortcutActions {
  openFileDialog: () => void;
  openInEditorDialog: () => void;
  saveFile: () => void;
  saveFileAs: () => void;
  exportSession: () => void;
}

export function useFileShortcuts(actions: FileShortcutActions): void {
  // Store actions in a ref so the keydown listener is registered once
  // and always calls the latest callbacks without re-subscribing.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle Ctrl (or Meta on Mac) combinations
      if (!(e.ctrlKey || e.metaKey)) return;

      const key = e.key.toLowerCase();
      const a = actionsRef.current;

      if (key === 'o' && !e.shiftKey) {
        e.preventDefault();
        a.openFileDialog();
      } else if (key === 'o' && e.shiftKey) {
        e.preventDefault();
        a.openInEditorDialog();
      } else if (key === 's' && !e.shiftKey) {
        e.preventDefault();
        a.saveFile();
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault();
        a.saveFileAs();
      } else if (key === 'e' && e.shiftKey) {
        e.preventDefault();
        a.exportSession();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
