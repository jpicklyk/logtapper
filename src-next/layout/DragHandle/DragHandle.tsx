import React, { useRef, useCallback } from 'react';
import clsx from 'clsx';
import styles from './DragHandle.module.css';

interface DragHandleProps {
  orientation: 'vertical' | 'horizontal';
  onDrag: (delta: number) => void;
  className?: string;
}

export const DragHandle = React.memo(function DragHandle({
  orientation,
  onDrag,
  className,
}: DragHandleProps) {
  const pending = useRef(0);
  const rafId = useRef<number | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      let lastPos = orientation === 'vertical' ? e.clientX : e.clientY;
      pending.current = 0;

      const onPointerMove = (ev: PointerEvent) => {
        const current = orientation === 'vertical' ? ev.clientX : ev.clientY;
        const delta = current - lastPos;
        lastPos = current;
        pending.current += delta;

        if (rafId.current === null) {
          rafId.current = requestAnimationFrame(() => {
            onDrag(pending.current);
            pending.current = 0;
            rafId.current = null;
          });
        }
      };

      const onPointerUp = () => {
        if (rafId.current !== null) {
          cancelAnimationFrame(rafId.current);
          if (pending.current !== 0) onDrag(pending.current);
          rafId.current = null;
          pending.current = 0;
        }
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onPointerUp);
        target.removeEventListener('pointercancel', onPointerUp);
      };

      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onPointerUp);
    },
    [orientation, onDrag],
  );

  return (
    <div
      className={clsx(styles.handle, styles[orientation], className)}
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation={orientation}
    />
  );
});
