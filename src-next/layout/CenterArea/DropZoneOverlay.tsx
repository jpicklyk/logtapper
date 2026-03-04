import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { DropZone } from '../../hooks';
import styles from './DropZoneOverlay.module.css';

interface DropZoneProps {
  id: string;
  zone: DropZone;
  paneId: string;
}

// Preview areas: what gets highlighted when each zone is active (the resulting split)
const PREVIEW_CLASS: Record<DropZone, string> = {
  left:   styles.previewLeft,
  right:  styles.previewRight,
  top:    styles.previewTop,
  bottom: styles.previewBottom,
  center: styles.previewCenter,
};

function Zone({ id, zone, paneId }: DropZoneProps) {
  const { isOver, setNodeRef } = useDroppable({
    id,
    data: { type: 'zone', zone, paneId },
  });

  return (
    <>
      <div ref={setNodeRef} className={`${styles.zone} ${styles[zone]}`} />
      {isOver && <div className={`${styles.preview} ${PREVIEW_CLASS[zone]}`} />}
    </>
  );
}

interface DropZoneOverlayProps {
  paneId: string;
}

export const DropZoneOverlay = React.memo(function DropZoneOverlay({ paneId }: DropZoneOverlayProps) {
  return (
    <div className={styles.overlay}>
      <Zone id={`zone-top-${paneId}`}    zone="top"    paneId={paneId} />
      <Zone id={`zone-bottom-${paneId}`} zone="bottom" paneId={paneId} />
      <Zone id={`zone-left-${paneId}`}   zone="left"   paneId={paneId} />
      <Zone id={`zone-right-${paneId}`}  zone="right"  paneId={paneId} />
      <Zone id={`zone-center-${paneId}`} zone="center" paneId={paneId} />
    </div>
  );
});
