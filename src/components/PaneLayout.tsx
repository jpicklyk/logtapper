import { Fragment, useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { PaneLayoutState, PaneTab } from '../hooks/usePaneLayout';
import { useAppContext } from '../context/AppContext';
import TabBar, { TabDragOverlay } from './TabBar';
import PaneContent from './PaneContent';
import DragHandle from './DragHandle';
import LeftSidebar from './LeftSidebar';
import ToolWindow from './ToolWindow';
import IconRail from './IconRail';

interface Props {
  layout: PaneLayoutState;
  pipelineHasResults: boolean;
  onOpenSettings: () => void;
}

// ── Drop Zone Overlay ───────────────────────────────────────────────────────

function PaneDropZone({ id, side }: { id: string; side: 'left' | 'right' }) {
  const { isOver, setNodeRef } = useDroppable({
    id,
    data: { type: 'split-zone', side },
  });
  return (
    <div
      ref={setNodeRef}
      className={`tab-drop-zone tab-drop-zone--${side}${isOver ? ' tab-drop-zone--active' : ''}`}
    />
  );
}

// ── Tab Bar Drop Target (for cross-pane drops onto a tab bar) ───────────────

function TabBarDropTarget({ paneId }: { paneId: string }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `tabbar-drop-${paneId}`,
    data: { type: 'tabbar', paneId },
  });
  return (
    <div
      ref={setNodeRef}
      className={`tab-bar-drop-target${isOver ? ' tab-bar-drop-target--active' : ''}`}
    />
  );
}

export default function PaneLayout({ layout, pipelineHasResults, onOpenSettings }: Props) {
  const { viewer, onCloseSession } = useAppContext();
  const {
    panes,
    preset,
    containerRef,
    centerRef,
    resizePane,
    leftSidebarWidth,
    resizeLeftSidebar,
    rightTool,
    rightPanelWidth,
    toggleRightTool,
    resizeRightPanel,
  } = layout;

  const isCompact = preset === 'compact';

  // ── DnD state ───────────────────────────────────────────────────────────

  const [activeTab, setActiveTab] = useState<PaneTab | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);


  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === 'tab') {
      setActiveTab(data.tab as PaneTab);
      setActivePaneId(data.paneId as string);

    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTab(null);
    setActivePaneId(null);


    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;
    if (!activeData || activeData.type !== 'tab') return;

    const tabId = active.id as string;
    const fromPaneId = activeData.paneId as string;

    // Case 1: Dropped on a split zone → create split (forceMove=true: always move, never duplicate)
    if (overData?.type === 'split-zone') {
      const side = overData.side as 'left' | 'right';
      if (side === 'right') {
        layout.splitRight(tabId, fromPaneId, true);
      } else {
        layout.splitLeft(tabId, fromPaneId, true);
      }
      return;
    }

    // Case 2: Dropped on a tab bar drop target → move to that pane
    if (overData?.type === 'tabbar') {
      const toPaneId = overData.paneId as string;
      if (fromPaneId !== toPaneId) {
        layout.moveTab(tabId, fromPaneId, toPaneId);
      }
      return;
    }

    // Case 3: Dropped on another sortable tab → reorder or cross-pane move
    if (overData?.type === 'tab') {
      const overPaneId = overData.paneId as string;
      const overTabId = over.id as string;

      if (fromPaneId === overPaneId) {
        // Same pane → reorder
        const pane = panes.find((p) => p.id === fromPaneId);
        if (!pane) return;
        const fromIndex = pane.tabs.findIndex((t) => t.id === tabId);
        const toIndex = pane.tabs.findIndex((t) => t.id === overTabId);
        if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
          layout.reorderTab(fromPaneId, fromIndex, toIndex);
        }
      } else {
        // Different pane → move tab to the position of the target tab
        const targetPane = panes.find((p) => p.id === overPaneId);
        if (!targetPane) return;
        const insertIndex = targetPane.tabs.findIndex((t) => t.id === overTabId);
        layout.moveTabToIndex(tabId, fromPaneId, overPaneId, insertIndex >= 0 ? insertIndex : targetPane.tabs.length);
      }
      return;
    }
  }, [layout, panes]);

  const handleDragCancel = useCallback(() => {
    setActiveTab(null);
    setActivePaneId(null);

  }, []);

  // Show split zones only when dragging and the pane has content
  const showDropZones = activeTab !== null;

  return (
    <div ref={containerRef} className={`app-workspace app-workspace--${preset}`}>

      {/* ── Left sidebar — permanent navigation, no tabs ── */}
      {!isCompact && (
        <>
          <LeftSidebar width={leftSidebarWidth} />
          <DragHandle onDrag={resizeLeftSidebar} />
        </>
      )}

      {/* ── Center tabbed pane area ── */}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div ref={centerRef} className="pane-area">
          {panes.map((pane, i) => (
            <Fragment key={pane.id}>
              {i > 0 && (
                <DragHandle
                  onDrag={(delta) => {
                    const w = centerRef.current?.getBoundingClientRect().width ?? 1;
                    resizePane(panes[i - 1].id, delta / w);
                  }}
                />
              )}
              <div className="pane" style={{ flex: pane.flexBasis }}>
                {pane.tabs.length > 0 && (
                  <SortableContext
                    items={pane.tabs.map((t) => t.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    <TabBar
                      pane={pane}
                      paneIndex={i}
                      paneCount={panes.length}
                      layout={layout}
                      pipelineHasResults={pipelineHasResults}
                      hasSession={!!viewer.session}
                      onCloseSession={onCloseSession}
                    />
                    {/* Invisible drop target over the tab bar for cross-pane drops */}
                    {showDropZones && activePaneId !== pane.id && (
                      <TabBarDropTarget paneId={pane.id} />
                    )}
                  </SortableContext>
                )}
                <div className="pane-content">
                  <PaneContent pane={pane} />
                  {/* Split drop zones — shown only during drag */}
                  {showDropZones && (
                    <>
                      <PaneDropZone id={`split-left-${pane.id}`} side="left" />
                      <PaneDropZone id={`split-right-${pane.id}`} side="right" />
                    </>
                  )}
                </div>
              </div>
            </Fragment>
          ))}
        </div>

        {/* Drag overlay — floating ghost tab */}
        <DragOverlay dropAnimation={null}>
          {activeTab ? <TabDragOverlay tab={activeTab} /> : null}
        </DragOverlay>
      </DndContext>

      {/* ── Right tool window — collapsible via icon rail ── */}
      {!isCompact && rightTool !== null && (
        <>
          <DragHandle onDrag={resizeRightPanel} />
          <ToolWindow tool={rightTool} width={rightPanelWidth} />
        </>
      )}

      {/* ── Icon rail — far right edge ── */}
      {!isCompact && (
        <IconRail activeTool={rightTool} onToggle={toggleRightTool} onOpenSettings={onOpenSettings} />
      )}

    </div>
  );
}
