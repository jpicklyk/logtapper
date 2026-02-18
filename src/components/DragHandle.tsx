import { useRef } from 'react';

interface DragHandleProps {
  onDrag: (delta: number) => void;
  onDragEnd?: () => void;
  orientation?: 'vertical' | 'horizontal';
  className?: string;
}

export default function DragHandle({
  onDrag,
  onDragEnd,
  orientation = 'vertical',
  className,
}: DragHandleProps) {
  const startPos = useRef<number | null>(null);
  const pending = useRef(0);
  const rafId = useRef<number | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startPos.current = orientation === 'vertical' ? e.clientX : e.clientY;
    pending.current = 0;

    const onMouseMove = (ev: MouseEvent) => {
      if (startPos.current === null) return;
      const current = orientation === 'vertical' ? ev.clientX : ev.clientY;
      const delta = current - startPos.current;
      startPos.current = current;
      pending.current += delta;

      // Throttle updates to one per animation frame.
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          onDrag(pending.current);
          pending.current = 0;
          rafId.current = null;
        });
      }
    };

    const onMouseUp = () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        // Flush any remaining delta.
        if (pending.current !== 0) onDrag(pending.current);
        rafId.current = null;
        pending.current = 0;
      }
      startPos.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      onDragEnd?.();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      className={`drag-handle drag-handle-${orientation}${className ? ` ${className}` : ''}`}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation={orientation}
    />
  );
}
