import { useEffect } from 'react';

interface FileShortcutActions {
  openFileDialog: () => void;
  openBugreportDialog: () => void;
  saveFile: () => void;
  saveFileAs: () => void;
}

export function useFileShortcuts(actions: FileShortcutActions): void {
  const { openFileDialog, openBugreportDialog, saveFile, saveFileAs } = actions;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle Ctrl (or Meta on Mac) combinations
      if (!(e.ctrlKey || e.metaKey)) return;

      const key = e.key.toLowerCase();

      if (key === 'o' && !e.shiftKey) {
        e.preventDefault();
        openFileDialog();
      } else if (key === 'o' && e.shiftKey) {
        e.preventDefault();
        openBugreportDialog();
      } else if (key === 's' && !e.shiftKey) {
        e.preventDefault();
        saveFile();
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault();
        saveFileAs();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openFileDialog, openBugreportDialog, saveFile, saveFileAs]);
}
