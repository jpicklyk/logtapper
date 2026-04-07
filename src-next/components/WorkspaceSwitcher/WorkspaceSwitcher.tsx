import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Plus, FolderOpen, X } from 'lucide-react';
import clsx from 'clsx';
import { useWorkspaceList, useActiveWorkspaceId, useWorkspaceActions, useWorkspaceContext } from '../../context';
import styles from './WorkspaceSwitcher.module.css';

/**
 * Workspace switcher dropdown — shows the list of open workspaces with
 * active/dirty indicators and close buttons. Mounted in the Header brand area.
 * Double-click a workspace name to rename it inline.
 */
export const WorkspaceSwitcher = React.memo(function WorkspaceSwitcher() {
  const workspaces = useWorkspaceList();
  const activeId = useActiveWorkspaceId();
  const { newWorkspace, openWorkspace, closeWorkspace, switchWorkspace } = useWorkspaceActions();
  const { renameWorkspace } = useWorkspaceContext();

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const activeWs = workspaces.find(w => w.id === activeId);
  const displayName = activeWs?.name ?? 'LogTapper';
  const isDirty = activeWs?.dirty ?? false;

  // Position panel below trigger
  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const top = rect.bottom + 4;
      let left = rect.left;
      const panelWidth = 260;
      if (left + panelWidth > window.innerWidth) {
        left = rect.right - panelWidth;
      }
      if (left < 4) left = 4;
      setPanelStyle({ position: 'fixed', top, left, zIndex: 1050 });
    } else {
      setPanelStyle(null);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleToggle = useCallback(() => setOpen(prev => !prev), []);

  const handleSwitch = useCallback((id: string) => {
    switchWorkspace(id);
    setOpen(false);
  }, [switchWorkspace]);

  const handleClose = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // don't trigger switch
    // If closing the active workspace, the context will auto-select the next one
    if (id === activeId) {
      closeWorkspace();
    } else {
      // TODO: close non-active workspace — for now only close active is supported
      // This would need saveWorkspace for that specific workspace first
    }
    if (workspaces.length <= 1) setOpen(false);
  }, [activeId, closeWorkspace, workspaces.length]);

  const handleNew = useCallback(() => {
    newWorkspace();
    setOpen(false);
  }, [newWorkspace]);

  const handleOpen = useCallback(() => {
    openWorkspace();
    setOpen(false);
  }, [openWorkspace]);

  const handleDoubleClick = useCallback((e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setRenamingId(id);
    setRenameValue(name);
    // Focus the input after React renders it
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
                <button
                  key={ws.id}
                  className={clsx(styles.workspaceItem, ws.id === activeId && styles.workspaceItemActive)}
                  onClick={() => handleSwitch(ws.id)}
                  onDoubleClick={(e) => handleDoubleClick(e, ws.id, ws.name)}
                >
                  <span className={ws.id === activeId ? styles.activeDot : styles.inactiveDot} />
                  {renamingId === ws.id ? (
                    <input
                      ref={renameInputRef}
                      className={styles.renameInput}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={handleRenameKeyDown}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className={styles.wsName}>{ws.name}</span>
                  )}
                  {ws.dirty && renamingId !== ws.id && <span className={styles.wsDirty}>*</span>}
                  <button
                    className={styles.closeBtn}
                    onClick={(e) => handleClose(e, ws.id)}
                    title="Close workspace"
                  >
                    <X size={12} />
                  </button>
                </button>
              ))}
            </>
          )}
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
