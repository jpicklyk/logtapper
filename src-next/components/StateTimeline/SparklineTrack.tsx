import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { TimelineSeriesData } from '../../bridge/types';
import type { Viewport } from './timelineUtils';
import { formatTs } from './timelineUtils';
import trackStyles from './Track.module.css';
import styles from './SparklineTrack.module.css';

export interface SparklineTrackProps {
  series: TimelineSeriesData;
  vp: Viewport;
  totalLines: number;
  onJump: (line: number) => void;
  minTs: number;
  tsRange: number;
  hasTimeData: boolean;
  showDate?: boolean;
}

const SparklineTrack = React.memo(function SparklineTrack({
  series,
  vp,
  totalLines,
  onJump,
  minTs,
  tsRange,
  hasTimeData,
  showDate = false,
}: SparklineTrackProps) {
  const [tooltip, setTooltip] = useState<{ cx: number; cy: number; label: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [vpS, vpE] = vp;
  const vpSpan = Math.max(vpE - vpS, 1e-9);
  const maxLine = Math.max(totalLines - 1, 1);
  const color = series.color ?? 'var(--accent)';
  const TRACK_HEIGHT = 40;
  const PADDING_Y = 4;
  const drawH = TRACK_HEIGHT - PADDING_Y * 2;
  const valRange = series.maxValue - series.minValue;
  const effectiveRange = valRange > 0 ? valRange : 1;

  const pathData = useMemo(() => {
    const pts = series.points;
    if (pts.length === 0) return { linePath: '', areaPath: '' };
    const margin = vpSpan * 0.02;
    const visiblePts = pts.filter((p) => {
      const norm = p.lineNum / maxLine;
      return norm >= vpS - margin && norm <= vpE + margin;
    });
    if (visiblePts.length === 0) return { linePath: '', areaPath: '' };
    const toX = (lineNum: number) => {
      const norm = lineNum / maxLine;
      return ((norm - vpS) / vpSpan) * 100;
    };
    const toY = (val: number) => {
      const normalized = (val - series.minValue) / effectiveRange;
      return PADDING_Y + drawH * (1 - normalized);
    };
    const lineSegments = visiblePts.map((p) => `${toX(p.lineNum).toFixed(3)},${toY(p.value).toFixed(2)}`);
    const linePath = `M${lineSegments.join(' L')}`;
    const firstX = toX(visiblePts[0].lineNum).toFixed(3);
    const lastX = toX(visiblePts[visiblePts.length - 1].lineNum).toFixed(3);
    const bottomY = TRACK_HEIGHT.toFixed(2);
    const areaPath = `${linePath} L${lastX},${bottomY} L${firstX},${bottomY} Z`;
    return { linePath, areaPath };
  }, [series.points, vpS, vpE, vpSpan, maxLine, series.minValue, effectiveRange, drawH]);

  const nearestAtEvent = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const lineAtCursor = (vpS + xFrac * vpSpan) * maxLine;
    let nearest = series.points[0];
    let bestDist = Infinity;
    for (const p of series.points) {
      const dist = Math.abs(p.lineNum - lineAtCursor);
      if (dist < bestDist) { bestDist = dist; nearest = p; }
    }
    return nearest ?? null;
  }, [series.points, vpS, vpSpan, maxLine]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const nearest = nearestAtEvent(e);
    if (!nearest) return;
    const formattedVal = Number.isInteger(nearest.value)
      ? nearest.value.toLocaleString()
      : nearest.value.toFixed(1);
    let tsLabel = '';
    if (hasTimeData && tsRange > 0) {
      const norm = nearest.lineNum / maxLine;
      const approxTs = minTs + norm * tsRange;
      tsLabel = ` . ~${formatTs(approxTs, showDate)}`;
    }
    setTooltip({
      cx: e.clientX,
      cy: e.clientY,
      label: `${series.label}: ${formattedVal} . L${(nearest.lineNum + 1).toLocaleString()}${tsLabel}`,
    });
  }, [nearestAtEvent, series.label, maxLine, hasTimeData, tsRange, minTs, showDate]);

  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const nearest = nearestAtEvent(e);
    if (nearest) onJump(nearest.lineNum);
  }, [nearestAtEvent, onJump]);

  const minLabel = Number.isInteger(series.minValue) ? series.minValue.toLocaleString() : series.minValue.toFixed(1);
  const maxLabel = Number.isInteger(series.maxValue) ? series.maxValue.toLocaleString() : series.maxValue.toFixed(1);

  return (
    <div className={trackStyles.track}>
      <div
        className={trackStyles.trackLabel}
        title={`${series.processorName}: ${series.label}`}
        style={{ '--track-color': color } as React.CSSProperties}
      >
        {series.processorName}: {series.label}
      </div>
      <div className={trackStyles.trackBody}>
        <svg
          ref={svgRef}
          className={styles.sparklineSvg}
          viewBox={`0 0 100 ${TRACK_HEIGHT}`}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setTooltip(null)}
          onClick={handleClick}
        >
          {pathData.areaPath && <path d={pathData.areaPath} fill={color} opacity="0.12" />}
          {pathData.linePath && (
            <path d={pathData.linePath} fill="none" stroke={color} strokeWidth="0.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          )}
        </svg>
        <span className={styles.ymax}>{maxLabel}</span>
        <span className={styles.ymin}>{minLabel}</span>
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

export default SparklineTrack;
