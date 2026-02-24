import React from 'react';
import clsx from 'clsx';
import { DragHandle } from '../DragHandle';
import styles from './ToolPane.module.css';

interface ToolPaneProps {
  position: 'left' | 'right' | 'bottom';
  visible: boolean;
  size: number;
  onResize: (delta: number) => void;
  minSize?: number;
  maxSize?: number;
  children: React.ReactNode;
}

export const ToolPane = React.memo(function ToolPane({
  position,
  visible,
  size,
  onResize,
  children,
}: ToolPaneProps) {
  const isHorizontal = position === 'bottom';
  const handleOrientation = isHorizontal ? 'horizontal' : 'vertical';

  // For left pane, positive drag = grow. For right pane, positive drag = shrink.
  const handleDrag = React.useCallback(
    (delta: number) => {
      if (position === 'right') {
        onResize(-delta);
      } else if (position === 'bottom') {
        onResize(-delta);
      } else {
        onResize(delta);
      }
    },
    [position, onResize],
  );

  const sizeStyle: React.CSSProperties = isHorizontal
    ? { height: visible ? size : 0 }
    : { width: visible ? size : 0 };

  const handle = (
    <DragHandle orientation={handleOrientation} onDrag={handleDrag} />
  );

  return (
    <div
      className={clsx(styles.pane, styles[position], !visible && styles.collapsed)}
      style={sizeStyle}
    >
      {position === 'right' && handle}
      {position === 'bottom' && handle}
      <div className={styles.content}>{children}</div>
      {position === 'left' && handle}
    </div>
  );
});
