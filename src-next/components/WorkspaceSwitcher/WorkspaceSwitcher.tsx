import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Plus, FolderOpen, Save, X, Pencil } from 'lucide-react';
import clsx from 'clsx';
import { useWorkspaceList, useActiveWorkspaceId, useWorkspaceActions, useRenameWorkspaceAction } from '../../context';
import { useAnchoredPanel } from '../../ui';
import styles from './WorkspaceSwitcher.module.css';

/**
 * Workspace switcher dropdown — shows the list of open workspaces with
 * active/dirty indicators and close buttons. Mounted in the Header brand area.
 * Double-click a workspace name to rename it inline.
 */
export const WorkspaceSwitcher = React.memo(function WorkspaceSwitcher() {
  const workspaces = useWorkspaceList();
  const activeId = useActiveWorkspaceId();
  const { newWorkspace, openWorkspace, closeWorkspace, switchWorkspace,
          saveWorkspace, saveWorkspaceAs } = useWorkspaceActions();
  const renameWorkspace = useRenameWorkspaceAction();

  const [open, setOpen] = useState(false);

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const activeWs = workspaces.find(w => w.id === activeId);
  const displayName = activeWs?.name ?? 'LogTapper';
  const isDirty = activeWs?.dirty ?? false;

  const closePanel = useCallback(() => setOpen(false), []);
  const { triggerRef, panelRef, panelStyle } = useAnchoredPanel<HTMLButtonElement, HTMLDivElement>({
    open,
    onClose: closePanel,
    panelWidth: 260,
  });

  const handleToggle = useCallback(() => setOpen(prev => !prev), []);

  const handleSwitch = useCallback((id: string) => {
    switchWorkspace(id);
    setOpen(false);
  }, [switchWorkspace]);

  const handleClose = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeWorkspace(id);
    if (workspaces.length <= 2) setOpen(false);
  }, [closeWorkspace, workspaces.length]);

  const handleNew = useCallback(() => {
    newWorkspace();
    setOpen(false);
  }, [newWorkspace]);

  const handleOpen = useCallback(() => {
    openWorkspace();
    setOpen(false);
  }, [openWorkspace]);

  const handleSave = useCallback(() => {
    saveWorkspace();
    setOpen(false);
  }, [saveWorkspace]);

  const handleSaveAs = useCallback(() => {
    saveWorkspaceAs();
    setOpen(false);
  }, [saveWorkspaceAs]);

  const handleStartRename = useCallback((e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setRenamingId(id);
    setRenameValue(name);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }, []);

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameWorkspace(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }, [renamingId, renameValue, renameWorkspace]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRenamingId(null);
    }
  }, [commitRename]);

  return (
    <>
      <button
        ref={triggerRef}
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        onClick={handleToggle}
        title={activeWs ? `${activeWs.name}${isDirty ? ' (unsaved)' : ''}` : 'No workspace'}
      >
        {isDirty && <span className={styles.dirtyDot} />}
        <span>{displayName}</span>
        <ChevronDown size={12} className={clsx(styles.chevron, open && styles.chevronOpen)} />
      </button>

      {open && panelStyle && createPortal(
        <div ref={panelRef} className={styles.panel} style={panelStyle}>
          {workspaces.length > 0 && (
            <>
              <div className={styles.sectionLabel}>Workspaces</div>
              {workspaces.map(ws => (
                <div
                  key={ws.id}
                  className={clsx(styles.workspaceItem, ws.id === activeId && styles.workspaceItemActive)}
                >
                  {renamingId === ws.id ? (
                    <>
                      <span className={ws.id === activeId ? styles.activeDot : styles.inactiveDot} />
                      <input
                        ref={renameInputRef}
                        className={styles.renameInput}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={handleRenameKeyDown}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.activateBtn}
                      onClick={() => handleSwitch(ws.id)}
                    >
                      <span className={ws.id === activeId ? styles.activeDot : styles.inactiveDot} />
                      <span className={styles.wsName}>{ws.name}</span>
                      {ws.dirty && <span className={styles.wsDirty}>*</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.renameBtn}
                    onClick={(e) => handleStartRename(e, ws.id, ws.name)}
                    title="Rename workspace"
                  >
                    <Pencil size={11} />
                  </button>
                  {ws.id !== activeId && (
                    <button
                      type="button"
                      className={styles.closeBtn}
                      onClick={(e) => handleClose(e, ws.id)}
                      title="Close workspace"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          <div className={styles.separator} />
          <button className={styles.actionItem} onClick={handleSave}>
            <Save size={14} />
            <span>Save Workspace</span>
          </button>
          <button className={styles.actionItem} onClick={handleSaveAs}>
            <Save size={14} />
            <span>Save Workspace As...</span>
          </button>
          <div className={styles.separator} />
          <button className={styles.actionItem} onClick={handleNew}>
            <Plus size={14} />
            <span>New Workspace</span>
          </button>
          <button className={styles.actionItem} onClick={handleOpen}>
            <FolderOpen size={14} />
            <span>Open Workspace...</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
});
