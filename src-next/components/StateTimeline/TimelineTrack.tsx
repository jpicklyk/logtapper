import React, { useMemo, useState } from 'react';
import type { Viewport, TrackerTimeline } from './timelineUtils';
import { linePct, formatTs } from './timelineUtils';
import trackStyles from './Track.module.css';
import styles from './TimelineTrack.module.css';

export interface TimelineTrackProps {
  timeline: TrackerTimeline;
  vp: Viewport;
  totalLines: number;
  onJump: (line: number) => void;
  showDate?: boolean;
}

const TimelineTrack = React.memo(function TimelineTrack({
  timeline,
  vp,
  totalLines,
  onJump,
  showDate = false,
}: TimelineTrackProps) {
  const [tooltip, setTooltip] = useState<{ cx: number; cy: number; label: string } | null>(null);

  const [vpS, vpE] = vp;
  const vpSpan = Math.max(vpE - vpS, 1e-9);
  const maxLine = Math.max(totalLines - 1, 1);

  const visible = useMemo(() => timeline.transitions.filter((t) => {
    const norm = t.lineNum / maxLine;
    return norm >= vpS - 0.01 && norm <= vpE + 0.01;
  }), [timeline.transitions, vpS, vpE, maxLine]);

  return (
    <div className={trackStyles.track}>
      <div className={trackStyles.trackLabel} title={timeline.trackerName}>
        {timeline.trackerName}
      </div>
      <div className={trackStyles.trackBody}>
        <div className={styles.rail} />
        {visible.map((t) => (
          <button
            key={t.lineNum}
            className={`${styles.tick}${t.timestamp === 0 ? ` ${styles.tickNoTs}` : ''}`}
            style={{ '--tick-pos': linePct(t.lineNum, maxLine, vpS, vpSpan) } as React.CSSProperties}
            onMouseEnter={(e) =>
              setTooltip({
                cx: e.clientX,
                cy: e.clientY,
                label: t.timestamp > 0
                  ? `${t.transitionName} . ${formatTs(t.timestamp, showDate)} . L${(t.lineNum + 1).toLocaleString()}`
                  : `${t.transitionName} . L${(t.lineNum + 1).toLocaleString()} (no timestamp)`,
              })
            }
            onMouseMove={(e) => setTooltip((prev) => (prev ? { ...prev, cx: e.clientX, cy: e.clientY } : prev))}
            onMouseLeave={() => setTooltip(null)}
            onClick={() => onJump(t.lineNum)}
          />
        ))}
      </div>
      {tooltip && (
        <div
          className={trackStyles.tooltip}
          style={{ '--tt-x': `${tooltip.cx}px`, '--tt-y': `${tooltip.cy - 40}px` } as React.CSSProperties}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
});

export default TimelineTrack;
