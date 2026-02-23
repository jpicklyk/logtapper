import { useEffect, useRef, useState, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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

// ── Sortable Tab Item ───────────────────────────────────────────────────────

interface SortableTabProps {
  tab: PaneTab;
  active: boolean;
  disabled: boolean;
  closeable: boolean;
  isCompact: boolean;
  renamingTabId: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement>;
  onSetActive: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  paneId: string;
}

function SortableTab({
  tab,
  active,
  disabled,
  closeable,
  isCompact,
  renamingTabId,
  renameValue,
  renameInputRef,
  onSetActive,
  onClose,
  onContextMenu,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  paneId,
}: SortableTabProps) {
  const isRenaming = renamingTabId === tab.id;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.id,
    disabled: isCompact || isRenaming,
    data: { type: 'tab', tab, paneId },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`tab${active ? ' tab--active' : ''}${disabled ? ' tab--disabled' : ''}${isDragging ? ' tab--dragging' : ''}`}
      onClick={() => !disabled && !isRenaming && onSetActive()}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      <span
        className="tab-label"
        onDoubleClick={(e) => { e.stopPropagation(); onStartRename(); }}
      >
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="tab-rename-input"
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onRenameCommit(); }
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          tab.label
        )}
      </span>
      {closeable && (
        <button
          className="tab-close"
          title={tab.type === 'logviewer' ? 'Close file' : 'Close tab'}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── TabBar ──────────────────────────────────────────────────────────────────

export default function TabBar({
  pane,
  paneIndex,
  paneCount,
  layout,
  pipelineHasResults,
  hasSession,
  onCloseSession,
}: TabBarProps) {
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
      return hasSession;
    }
    return true;
  };

  // Tabs already in this pane — exclude non-scratch types that are already present.
  const presentTypes = new Set(pane.tabs.map((t) => t.type));
  const addableTypes = CENTER_TAB_TYPES.filter((t) => {
    if (t === 'scratch') return true;
    return !presentTypes.has(t);
  });

  return (
    <>
      <div className="tab-bar" data-pane-id={pane.id}>
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeTabId;
          const disabled = isTabDisabled(tab.type);
          return (
            <SortableTab
              key={tab.id}
              tab={tab}
              active={active}
              disabled={disabled}
              closeable={canClose(tab)}
              isCompact={isCompact}
              renamingTabId={renamingTabId}
              renameValue={renameValue}
              renameInputRef={renameInputRef}
              onSetActive={() => layout.setActiveTab(tab.id, pane.id)}
              onClose={() => {
                if (tab.type === 'logviewer' && onCloseSession) {
                  onCloseSession();
                } else {
                  layout.closeTab(tab.id, pane.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, tab });
              }}
              onStartRename={() => startRename(tab)}
              onRenameChange={setRenameValue}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenamingTabId(null)}
              paneId={pane.id}
            />
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

// ── Tab Drag Overlay (rendered in PaneLayout's DragOverlay) ─────────────────

export function TabDragOverlay({ tab }: { tab: PaneTab }) {
  return (
    <div className="tab tab--active tab-drag-overlay">
      <span className="tab-label">{tab.label}</span>
    </div>
  );
}
