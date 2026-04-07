import React, { useCallback } from 'react';
import { Modal } from '../Modal/Modal';
import { Button } from '../Button/Button';
import styles from './SavePromptDialog.module.css';

export type SavePromptResult = 'save' | 'discard' | 'cancel';

interface SavePromptDialogProps {
  open: boolean;
  workspaceName: string;
  onResult: (result: SavePromptResult) => void;
}

/**
 * "Save changes?" dialog shown before destructive workspace transitions
 * (new workspace, open workspace, close app with unsaved changes).
 *
 * Three-button pattern matching VS Code / IntelliJ:
 *   Save — persist changes then continue
 *   Don't Save — discard changes and continue
 *   Cancel — abort the transition
 */
export const SavePromptDialog = React.memo<SavePromptDialogProps>(function SavePromptDialog({
  open,
  workspaceName,
  onResult,
}) {
  const handleSave = useCallback(() => onResult('save'), [onResult]);
  const handleDiscard = useCallback(() => onResult('discard'), [onResult]);
  const handleCancel = useCallback(() => onResult('cancel'), [onResult]);

  return (
    <Modal open={open} onClose={handleCancel} title="Save Changes?" width={400}>
      <p className={styles.message}>
        Do you want to save changes to <strong>{workspaceName}</strong>?
      </p>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={handleDiscard}>
          Don&apos;t Save
        </Button>
        <Button variant="secondary" onClick={handleCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave}>
          Save
        </Button>
      </div>
    </Modal>
  );
});
