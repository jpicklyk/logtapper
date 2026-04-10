import React, { useCallback, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDndContext,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { DragHandle } from '../DragHandle';
import { TabBar } from '../TabBar';
import { DropZoneOverlay } from './DropZoneOverlay';
import { clamp } from '../../utils';
import type { SplitNode, CenterPane, DropZone, Tab } from '../../hooks';
import styles from './CenterArea.module.css';

// Helper: find a pane by ID in the split tree
function findPane(tree: SplitNode, paneId: string): CenterPane | null {
  if (tree.type === 'leaf') return tree.pane.id === paneId ? tree.pane : null;
  return findPane(tree.children[0], paneId) ?? findPane(tree.children[1], paneId);
}

interface CenterAreaProps {
  tree: SplitNode;
  /** The specific logviewer tab that owns the focused session. */
  focusedLogviewerTabId?: string | null;
  /** Called with (paneId, element) when a leaf's content mount div is attached/detached.
   *  Consumers use this to portal pane content into the correct leaf. */
  onContentRef: (paneId: string, el: HTMLDivElement | null) => void;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
  onTabAdd?: (paneId: string) => void;
  onTabRename?: (tabId: string, newLabel: string) => void;
  onSplitResize: (nodeId: string, ratio: number) => void;
  onTabDrop?: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;
  onTabReorder?: (paneId: string, fromIndex: number, toIndex: number) => void;
}

export const CenterArea = React.memo(function CenterArea(props: CenterAreaProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const [draggingTab, setDraggingTab] = useState<{ label: string } | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === 'tab') {
      setDraggingTab({ label: data.label as string });
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setDraggingTab(null);
      if (!over) return;

      const activeData = active.data.current;
      if (!activeData || activeData.type !== 'tab') return;

      const tabId = activeData.tabId as string;
      const fromPaneId = activeData.paneId as string;
      const overData = over.data.current;

      // Dropped on a split/center zone
      if (overData?.type === 'zone') {
        props.onTabDrop?.(tabId, fromPaneId, overData.paneId as string, overData.zone as DropZone);
        return;
      }

      // Dropped on another tab
      if (overData?.type === 'tab') {
        const overPaneId = overData.paneId as string;
        const overTabId = over.id as string;
        if (fromPaneId === overPaneId) {
          // Same pane → reorder
          const pane = findPane(props.tree, fromPaneId);
          if (!pane) return;
          const fromIndex = pane.tabs.findIndex((t: Tab) => t.id === tabId);
          const toIndex = pane.tabs.findIndex((t: Tab) => t.id === overTabId);
          if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
            props.onTabReorder?.(fromPaneId, fromIndex, toIndex);
          }
        } else {
          // Different pane → move
          props.onTabDrop?.(tabId, fromPaneId, overPaneId, 'center');
        }
        return;
      }
    },
    [props.onTabDrop, props.onTabReorder, props.tree],
  );

  const handleDragCancel = useCallback(() => setDraggingTab(null), []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className={styles.root}>
        <SplitNodeRenderer {...props} node={props.tree} onContentRef={props.onContentRef} />
      </div>
      <DragOverlay dropAnimation={null}>
        {draggingTab ? <div className={styles.tabGhost}>{draggingTab.label}</div> : null}
      </DragOverlay>
    </DndContext>
  );
});

interface SplitNodeRendererProps {
  node: SplitNode;
  focusedLogviewerTabId?: string | null;
  onContentRef: (paneId: string, el: HTMLDivElement | null) => void;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
  onTabAdd?: (paneId: string) => void;
  onTabRename?: (tabId: string, newLabel: string) => void;
  onSplitResize: (nodeId: string, ratio: number) => void;
  onTabDrop?: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;
  onTabReorder?: (paneId: string, fromIndex: number, toIndex: number) => void;
}

const SplitNodeRenderer = React.memo(function SplitNodeRenderer({
  node,
  focusedLogviewerTabId,
  onContentRef,
  onTabActivate,
  onTabClose,
  onTabAdd,
  onTabRename,
  onSplitResize,
  onTabDrop,
  onTabReorder,
}: SplitNodeRendererProps) {
  if (node.type === 'leaf') {
    return (
      <LeafPane
        pane={node.pane}
        focusedLogviewerTabId={focusedLogviewerTabId}
        onContentRef={onContentRef}
        onTabActivate={onTabActivate}
        onTabClose={onTabClose}
        onTabAdd={onTabAdd}
        onTabRename={onTabRename}
        onTabDrop={onTabDrop}
        onTabReorder={onTabReorder}
      />
    );
  }

  const { ratio, children, id } = node;
  const isHorizontal = node.direction === 'horizontal';
  const firstPercent = `${ratio * 100}%`;
  const secondPercent = `${(1 - ratio) * 100}%`;

  return (
    <SplitContainer
      nodeId={id}
      firstPercent={firstPercent}
      secondPercent={secondPercent}
      isHorizontal={isHorizontal}
      ratio={ratio}
      first={children[0]}
      second={children[1]}
      focusedLogviewerTabId={focusedLogviewerTabId}
      onContentRef={onContentRef}
      onTabActivate={onTabActivate}
      onTabClose={onTabClose}
      onTabAdd={onTabAdd}
      onTabRename={onTabRename}
      onSplitResize={onSplitResize}
      onTabDrop={onTabDrop}
      onTabReorder={onTabReorder}
    />
  );
});

interface SplitContainerProps {
  nodeId: string;
  firstPercent: string;
  secondPercent: string;
  isHorizontal: boolean;
  ratio: number;
  first: SplitNode;
  second: SplitNode;
  focusedLogviewerTabId?: string | null;
  onContentRef: (paneId: string, el: HTMLDivElement | null) => void;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
  onTabAdd?: (paneId: string) => void;
  onTabRename?: (tabId: string, newLabel: string) => void;
  onSplitResize: (nodeId: string, ratio: number) => void;
  onTabDrop?: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;
  onTabReorder?: (paneId: string, fromIndex: number, toIndex: number) => void;
}

const SplitContainer = React.memo(function SplitContainer({
  nodeId,
  firstPercent,
  secondPercent,
  isHorizontal,
  ratio,
  first,
  second,
  focusedLogviewerTabId,
  onContentRef,
  onTabActivate,
  onTabClose,
  onTabAdd,
  onTabRename,
  onSplitResize,
  onTabDrop,
  onTabReorder,
}: SplitContainerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Use a ref so the drag callback always reads the latest ratio without
  // needing to recreate the callback (which the DragHandle's pointer listener
  // would not pick up mid-drag).
  const ratioRef = React.useRef(ratio);
  ratioRef.current = ratio;

  const handleDrag = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const totalSize = isHorizontal ? container.clientWidth : container.clientHeight;
      if (totalSize === 0) return;
      const ratioDelta = delta / totalSize;
      const newRatio = clamp(ratioRef.current + ratioDelta, 0.1, 0.9);
      onSplitResize(nodeId, newRatio);
    },
    [isHorizontal, onSplitResize, nodeId],
  );

  const splitDirClass = isHorizontal ? styles.splitRow : styles.splitCol;
  const handleOrientation = isHorizontal ? 'vertical' : 'horizontal';

  return (
    <div
      ref={containerRef}
      className={`${styles.split} ${splitDirClass}`}
    >
      <div style={{ '--split-basis': firstPercent } as React.CSSProperties} className={styles.splitChild}>
        <SplitNodeRenderer
          node={first}
          focusedLogviewerTabId={focusedLogviewerTabId}
          onContentRef={onContentRef}
          onTabActivate={onTabActivate}
          onTabClose={onTabClose}
          onTabAdd={onTabAdd}
          onTabRename={onTabRename}
          onSplitResize={onSplitResize}
          onTabDrop={onTabDrop}
          onTabReorder={onTabReorder}
        />
      </div>
      <DragHandle orientation={handleOrientation} onDrag={handleDrag} />
      <div style={{ '--split-basis': secondPercent } as React.CSSProperties} className={styles.splitChild}>
        <SplitNodeRenderer
          node={second}
          focusedLogviewerTabId={focusedLogviewerTabId}
          onContentRef={onContentRef}
          onTabActivate={onTabActivate}
          onTabClose={onTabClose}
          onTabAdd={onTabAdd}
          onTabRename={onTabRename}
          onSplitResize={onSplitResize}
          onTabDrop={onTabDrop}
          onTabReorder={onTabReorder}
        />
      </div>
    </div>
  );
});

interface LeafPaneProps {
  pane: CenterPane;
  focusedLogviewerTabId?: string | null;
  /** Called with (paneId, element) on mount/unmount of the content area.
   *  The caller portals pane content into this element. */
  onContentRef: (paneId: string, el: HTMLDivElement | null) => void;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
  onTabAdd?: (paneId: string) => void;
  onTabRename?: (tabId: string, newLabel: string) => void;
  onTabDrop?: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;
  onTabReorder?: (paneId: string, fromIndex: number, toIndex: number) => void;
}

const LeafPane = React.memo(function LeafPane({
  pane,
  focusedLogviewerTabId,
  onContentRef,
  onTabActivate,
  onTabClose,
  onTabAdd,
  onTabRename,
  onTabReorder,
}: LeafPaneProps) {
  const { active } = useDndContext();
  const isDragging = active !== null;

  const handleActivate = useCallback(
    (tabId: string) => onTabActivate(tabId, pane.id),
    [onTabActivate, pane.id],
  );
  const handleClose = useCallback(
    (tabId: string) => onTabClose(tabId, pane.id),
    [onTabClose, pane.id],
  );
  const handleAdd = useCallback(() => onTabAdd?.(pane.id), [onTabAdd, pane.id]);
  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) => onTabReorder?.(pane.id, fromIndex, toIndex),
    [onTabReorder, pane.id],
  );

  // Stable ref callback — notifies the parent when the mount div is attached/detached.
  // pane.id is stable for the lifetime of a pane, so this callback is also stable.
  const contentMountRef = useCallback(
    (el: HTMLDivElement | null) => { onContentRef(pane.id, el); },
    [pane.id, onContentRef],
  );

  return (
    <div className={styles.leaf}>
      <SortableContext
        items={pane.tabs.map((t) => t.id)}
        strategy={horizontalListSortingStrategy}
      >
        <TabBar
          tabs={pane.tabs}
          activeTabId={pane.activeTabId}
          paneId={pane.id}
          focusedLogviewerTabId={focusedLogviewerTabId}
          onActivate={handleActivate}
          onClose={handleClose}
          onAdd={onTabAdd ? handleAdd : undefined}
          onRename={onTabRename}
          onReorder={handleReorder}
        />
      </SortableContext>
      <div className={styles.leafContent}>
        {/* Portal target: pane content is injected here by AppShell via createPortal.
            Keeping it as a separate child div (with no React children of its own)
            avoids React reconciliation conflicts between portal and JSX children. */}
        <div className={styles.paneContentMount} ref={contentMountRef} />
        {isDragging && <DropZoneOverlay paneId={pane.id} />}
      </div>
    </div>
  );
});
