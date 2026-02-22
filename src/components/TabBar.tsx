import { useEffect, useRef, useState, useCallback } from 'react';
import type { Pane, PaneLayoutState, TabType, PaneTab } from '../hooks/usePaneLayout';
import { TAB_LABELS } from '../hooks/usePaneLayout';

/** All tab types available in the center pane area. */
const CENTER_TAB_TYPES: TabType[] = ['logviewer', 'dashboard', 'scratch'];

interface TabBarProps {
  pane: Pane;
  paneIndex: number;
  paneCount: number;
  layout: PaneLayoutState;
  pipelineHasResults: boolean;
  /** Whether a log session is currently loaded. */
  hasSession: boolean;
  /** Called when the user clicks close on a logviewer tab to close the session. */
  onCloseSession?: () => void;
}

interface ContextMenu {
  x: number;
  y: number;
  tab: PaneTab;
}

export default function TabBar({
  pane,
  paneIndex,
  paneCount,
  layout,
  pipelineHasResults,
  hasSession,
  onCloseSession,
}: TabBarProps) {
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [addMenuPos, setAddMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isCompact = layout.preset === 'compact';

  // Auto-focus rename input when it appears.
  useEffect(() => {
    if (renamingTabId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingTabId]);

  const startRename = useCallback((tab: PaneTab) => {
    setRenamingTabId(tab.id);
    setRenameValue(tab.label);
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingTabId && renameValue.trim()) {
      layout.renameTab(renamingTabId, renameValue.trim());
    }
    setRenamingTabId(null);
  }, [renamingTabId, renameValue, layout]);

  // Close menus on outside mousedown.
  useEffect(() => {
    if (!contextMenu && !addMenuPos) return;
    const handler = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null);
      }
      if (
        addMenuRef.current &&
        !addMenuRef.current.contains(e.target as Node) &&
        addBtnRef.current &&
        !addBtnRef.current.contains(e.target as Node)
      ) {
        setAddMenuPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu, addMenuPos]);

  const isTabDisabled = (type: TabType) => {
    if (type === 'dashboard' && !pipelineHasResults) return true;
    return false;
  };

  const canClose = (tab: PaneTab) => {
    if (isCompact) return false;
    if (tab.type === 'logviewer') {
      // Logviewer tab can be closed when a session is loaded (closes the session)
      return hasSession;
    }
    return true;
  };

  // Tabs already in this pane — exclude non-scratch types that are already present.
  // Scratch can always be added (allows multiple scratch tabs).
  const presentTypes = new Set(pane.tabs.map((t) => t.type));
  const addableTypes = CENTER_TAB_TYPES.filter((t) => {
    if (t === 'scratch') return true; // always addable
    return !presentTypes.has(t);
  });

  return (
    <>
      <div
        className={`tab-bar${dragOver ? ' tab-bar--drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const tabId = e.dataTransfer.getData('tab-id');
          const fromPane = e.dataTransfer.getData('from-pane');
          if (tabId && fromPane && fromPane !== pane.id) {
            layout.moveTab(tabId, fromPane, pane.id);
          }
        }}
      >
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeTabId;
          const disabled = isTabDisabled(tab.type);
          return (
            <div
              key={tab.id}
              className={`tab${active ? ' tab--active' : ''}${disabled ? ' tab--disabled' : ''}`}
              draggable={!isCompact && renamingTabId !== tab.id}
              onDragStart={(e) => {
                e.dataTransfer.setData('tab-id', tab.id);
                e.dataTransfer.setData('from-pane', pane.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => !disabled && renamingTabId !== tab.id && layout.setActiveTab(tab.id, pane.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, tab });
              }}
            >
              <span
                className="tab-label"
                onDoubleClick={(e) => { e.stopPropagation(); startRename(tab); }}
              >
                {renamingTabId === tab.id ? (
                  <input
                    ref={renameInputRef}
                    className="tab-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      if (e.key === 'Escape') setRenamingTabId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  tab.label
                )}
              </span>
              {canClose(tab) && (
                <button
                  className="tab-close"
                  title={tab.type === 'logviewer' ? 'Close file' : 'Close tab'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (tab.type === 'logviewer' && onCloseSession) {
                      onCloseSession();
                    } else {
                      layout.closeTab(tab.id, pane.id);
                    }
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        {/* Add-tab button */}
        {!isCompact && addableTypes.length > 0 && (
          <button
            ref={addBtnRef}
            className="tab-add-btn"
            title="Add tab"
            onClick={() => {
              if (addMenuPos) {
                setAddMenuPos(null);
              } else {
                const rect = addBtnRef.current!.getBoundingClientRect();
                setAddMenuPos({ x: rect.left, y: rect.bottom });
              }
            }}
          >
            +
          </button>
        )}
      </div>

      {/* Add-tab dropdown */}
      {addMenuPos && (
        <div
          ref={addMenuRef}
          className="context-menu"
          style={{ top: addMenuPos.y, left: addMenuPos.x }}
        >
          {addableTypes.map((type) => (
            <div
              key={type}
              className="context-menu-item"
              onClick={() => {
                layout.addTab(pane.id, type);
                setAddMenuPos(null);
              }}
            >
              {TAB_LABELS[type]}
            </div>
          ))}
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {paneCount < 3 && (
            <div
              className="context-menu-item"
              onClick={() => {
                layout.splitRight(contextMenu.tab.id, pane.id);
                setContextMenu(null);
              }}
            >
              Split Right
            </div>
          )}
          {paneIndex > 0 && (
            <div
              className="context-menu-item"
              onClick={() => {
                const leftPane = layout.panes[paneIndex - 1];
                layout.moveTab(contextMenu.tab.id, pane.id, leftPane.id);
                setContextMenu(null);
              }}
            >
              Move to Left Pane
            </div>
          )}
          {paneIndex < paneCount - 1 && (
            <div
              className="context-menu-item"
              onClick={() => {
                const rightPane = layout.panes[paneIndex + 1];
                layout.moveTab(contextMenu.tab.id, pane.id, rightPane.id);
                setContextMenu(null);
              }}
            >
              Move to Right Pane
            </div>
          )}
          <div
            className="context-menu-item"
            onClick={() => startRename(contextMenu.tab)}
          >
            Rename Tab
          </div>
          {canClose(contextMenu.tab) && (
            <div
              className="context-menu-item context-menu-item--danger"
              onClick={() => {
                if (contextMenu.tab.type === 'logviewer' && onCloseSession) {
                  onCloseSession();
                } else {
                  layout.closeTab(contextMenu.tab.id, pane.id);
                }
                setContextMenu(null);
              }}
            >
              {contextMenu.tab.type === 'logviewer' ? 'Close File' : 'Close Tab'}
            </div>
          )}
        </div>
      )}
    </>
  );
}
