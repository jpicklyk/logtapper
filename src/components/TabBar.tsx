import { useEffect, useRef, useState } from 'react';
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
}: TabBarProps) {
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [addMenuPos, setAddMenuPos] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const isCompact = layout.preset === 'compact';

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
      const total = layout.panes.reduce(
        (n, p) => n + p.tabs.filter((t) => t.type === 'logviewer').length,
        0,
      );
      return total > 1;
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
              draggable={!isCompact}
              onDragStart={(e) => {
                e.dataTransfer.setData('tab-id', tab.id);
                e.dataTransfer.setData('from-pane', pane.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => !disabled && layout.setActiveTab(tab.id, pane.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, tab });
              }}
            >
              <span className="tab-label">{tab.label}</span>
              {canClose(tab) && (
                <button
                  className="tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    layout.closeTab(tab.id, pane.id);
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
          {canClose(contextMenu.tab) && (
            <div
              className="context-menu-item context-menu-item--danger"
              onClick={() => {
                layout.closeTab(contextMenu.tab.id, pane.id);
                setContextMenu(null);
              }}
            >
              Close Tab
            </div>
          )}
        </div>
      )}
    </>
  );
}
