import React, { useCallback } from 'react';
import { DragHandle } from '../DragHandle';
import { TabBar } from '../TabBar';
import type { SplitNode, CenterPane } from '../../hooks';
import styles from './CenterArea.module.css';

interface CenterAreaProps {
  tree: SplitNode;
  renderContent: (pane: CenterPane) => React.ReactNode;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
  onSplitResize: (nodeId: string, ratio: number) => void;
}

export const CenterArea = React.memo(function CenterArea(props: CenterAreaProps) {
  return (
    <div className={styles.root}>
      <SplitNodeRenderer {...props} node={props.tree} />
    </div>
  );
});

interface SplitNodeRendererProps {
  node: SplitNode;
  renderContent: (pane: CenterPane) => React.ReactNode;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
  onSplitResize: (nodeId: string, ratio: number) => void;
}

const SplitNodeRenderer = React.memo(function SplitNodeRenderer({
  node,
  renderContent,
  onTabActivate,
  onTabClose,
  onSplitResize,
}: SplitNodeRendererProps) {
  if (node.type === 'leaf') {
    return (
      <LeafPane
        pane={node.pane}
        renderContent={renderContent}
        onTabActivate={onTabActivate}
        onTabClose={onTabClose}
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
      renderContent={renderContent}
      onTabActivate={onTabActivate}
      onTabClose={onTabClose}
      onSplitResize={onSplitResize}
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
  renderContent: (pane: CenterPane) => React.ReactNode;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
  onSplitResize: (nodeId: string, ratio: number) => void;
}

const SplitContainer = React.memo(function SplitContainer({
  nodeId,
  firstPercent,
  secondPercent,
  isHorizontal,
  ratio,
  first,
  second,
  renderContent,
  onTabActivate,
  onTabClose,
  onSplitResize,
}: SplitContainerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  const handleDrag = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const totalSize = isHorizontal
        ? container.clientWidth
        : container.clientHeight;
      if (totalSize === 0) return;
      const ratioDelta = delta / totalSize;
      const newRatio = Math.max(0.1, Math.min(0.9, ratio + ratioDelta));
      onSplitResize(nodeId, newRatio);
    },
    [isHorizontal, ratio, onSplitResize, nodeId],
  );

  const flexDir = isHorizontal ? 'row' : 'column';
  const handleOrientation = isHorizontal ? 'vertical' : 'horizontal';

  return (
    <div
      ref={containerRef}
      className={styles.split}
      style={{ flexDirection: flexDir as 'row' | 'column' }}
    >
      <div style={{ flexBasis: firstPercent }} className={styles.splitChild}>
        <SplitNodeRenderer
          node={first}
          renderContent={renderContent}
          onTabActivate={onTabActivate}
          onTabClose={onTabClose}
          onSplitResize={onSplitResize}
        />
      </div>
      <DragHandle orientation={handleOrientation} onDrag={handleDrag} />
      <div style={{ flexBasis: secondPercent }} className={styles.splitChild}>
        <SplitNodeRenderer
          node={second}
          renderContent={renderContent}
          onTabActivate={onTabActivate}
          onTabClose={onTabClose}
          onSplitResize={onSplitResize}
        />
      </div>
    </div>
  );
});

interface LeafPaneProps {
  pane: CenterPane;
  renderContent: (pane: CenterPane) => React.ReactNode;
  onTabActivate: (tabId: string, paneId: string) => void;
  onTabClose: (tabId: string, paneId: string) => void;
}

const LeafPane = React.memo(function LeafPane({
  pane,
  renderContent,
  onTabActivate,
  onTabClose,
}: LeafPaneProps) {
  const handleActivate = useCallback(
    (tabId: string) => onTabActivate(tabId, pane.id),
    [onTabActivate, pane.id],
  );
  const handleClose = useCallback(
    (tabId: string) => onTabClose(tabId, pane.id),
    [onTabClose, pane.id],
  );

  return (
    <div className={styles.leaf}>
      <TabBar
        tabs={pane.tabs}
        activeTabId={pane.activeTabId}
        onActivate={handleActivate}
        onClose={handleClose}
      />
      <div className={styles.leafContent}>{renderContent(pane)}</div>
    </div>
  );
});
