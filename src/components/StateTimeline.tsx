import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { getTimelineData } from '../bridge/commands';
import type { StateTransition, TimelineSeriesData } from '../bridge/types';

type Viewport = readonly [number, number];

interface TrackerTimeline {
  trackerId: string;
  trackerName: string;
  transitions: StateTransition[];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Timestamps are Unix nanoseconds computed with 2000-01-01 as the logcat year anchor.
// The raw i64 value IS a Unix nanosecond timestamp — do NOT add any epoch offset.
function formatTs(tsNanos: number): string {
  const d = new Date(tsNanos / 1_000_000); // Unix ns → Unix ms
  return [
    d.getUTCHours().toString().padStart(2, '0'),
    d.getUTCMinutes().toString().padStart(2, '00'),
    d.getUTCSeconds().toString().padStart(2, '0'),
  ].join(':') + '.' + d.getUTCMilliseconds().toString().padStart(3, '0');
}

function fmtDuration(nanos: number): string {
  if (nanos < 1e6)    return `${(nanos / 1e3).toFixed(1)}µs`;
  if (nanos < 1e9)    return `${(nanos / 1e6).toFixed(0)}ms`;
  if (nanos < 60e9)   return `${(nanos / 1e9).toFixed(2)}s`;
  if (nanos < 3600e9) return `${(nanos / 60e9).toFixed(1)}m`;
  return `${(nanos / 3600e9).toFixed(2)}h`;
}

function niceTimeInterval(raw: number): number {
  const steps = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,
    1e3, 2e3, 5e3, 10e3, 20e3, 50e3, 100e3,
    1e6, 2e6, 5e6, 10e6, 20e6, 50e6, 100e6, 200e6, 500e6,
    1e9, 2e9, 5e9, 10e9, 30e9, 60e9, 300e9, 600e9, 3600e9,
  ];
  for (const s of steps) if (s >= raw) return s;
  return steps[steps.length - 1];
}

function niceLineStep(raw: number): number {
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  for (const s of steps) if (s >= raw) return s;
  return steps[steps.length - 1];
}

function doZoom([s, e]: Viewport, xFrac: number, zoomIn: boolean): Viewport {
  const span = e - s;
  const factor = zoomIn ? 0.6 : 1 / 0.6;
  const newSpan = Math.min(1, Math.max(0.0005, span * factor));
  const center = s + xFrac * span;
  let ns = center - xFrac * newSpan;
  let ne = ns + newSpan;
  if (ns < 0) { ns = 0; ne = newSpan; }
  if (ne > 1) { ne = 1; ns = 1 - newSpan; }
  return [ns, ne];
}

function doPan([s, e]: Viewport, deltaNorm: number): Viewport {
  const span = e - s;
  const ns = Math.max(0, Math.min(1 - span, s + deltaNorm));
  return [ns, ns + span];
}

// ── Main component ────────────────────────────────────────────────────────────

// Must match .tl-ruler-spacer width (label column + gap)
const LABEL_W = 130;

export default function StateTimeline() {
  const { viewer, pipeline, stateTracker, selectedLineNum } = useAppContext();
  const [timelines, setTimelines] = useState<TrackerTimeline[]>([]);
  const [reporterTimelines, setReporterTimelines] = useState<TimelineSeriesData[]>([]);
  const [loading, setLoading] = useState(false);
  // Single viewport in normalized line-number space [0..1]
  const [vp, setVp] = useState<Viewport>([0, 1]);
  const hasDataRef = useRef(false);
  const interactRef = useRef<HTMLDivElement>(null);

  const activeTrackers = pipeline.pipelineChain
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p != null && p.processorType === 'state_tracker');

  const activeReporters = pipeline.pipelineChain
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p != null && p.processorType === 'reporter');

  useEffect(() => {
    if (!viewer.session) {
      setTimelines([]);
      setReporterTimelines([]);
      setVp([0, 1]);
      hasDataRef.current = false;
      return;
    }

    const hasTrackers = activeTrackers.length > 0;
    const hasReporters = activeReporters.length > 0;

    if (!hasTrackers && !hasReporters) {
      setTimelines([]);
      setReporterTimelines([]);
      setVp([0, 1]);
      hasDataRef.current = false;
      return;
    }

    const sessionId = viewer.session.sessionId;
    if (!hasDataRef.current) setLoading(true);

    // Fetch tracker transitions and reporter timeline data in parallel
    const trackerPromise = hasTrackers
      ? Promise.allSettled(
          activeTrackers.map((t) =>
            stateTracker.getTransitions(sessionId, t.id).then((trans) => ({
              trackerId: t.id,
              trackerName: t.name,
              transitions: trans,
            })),
          ),
        ).then((results) =>
          results
            .filter((r): r is PromiseFulfilledResult<TrackerTimeline> => r.status === 'fulfilled')
            .map((r) => r.value),
        )
      : Promise.resolve([] as TrackerTimeline[]);

    const reporterPromise = hasReporters
      ? getTimelineData(sessionId, activeReporters.map((r) => r.id)).catch(() => [] as TimelineSeriesData[])
      : Promise.resolve([] as TimelineSeriesData[]);

    Promise.all([trackerPromise, reporterPromise]).then(([nextTrackers, nextReporters]) => {
      hasDataRef.current = true;

      setTimelines((prev) => {
        if (
          prev.length === nextTrackers.length &&
          prev.every((p, i) =>
            p.trackerId === nextTrackers[i].trackerId &&
            p.transitions.length === nextTrackers[i].transitions.length,
          )
        ) return prev;
        return nextTrackers;
      });

      setReporterTimelines((prev) => {
        if (
          prev.length === nextReporters.length &&
          prev.every((p, i) =>
            p.processorId === nextReporters[i].processorId &&
            p.field === nextReporters[i].field &&
            p.points.length === nextReporters[i].points.length,
          )
        ) return prev;
        return nextReporters;
      });

      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.runCount, viewer.session]);

  const session = viewer.session;
  const totalLines = session?.totalLines ?? 1;

  // Session time bounds — derived from transition timestamps, NOT session metadata.
  const [minTs, tsRange, hasTimeData] = useMemo(() => {
    const anchors: { lineNum: number; ts: number }[] = [];
    for (const tl of timelines) {
      for (const t of tl.transitions) {
        if (t.timestamp > 0) anchors.push({ lineNum: t.lineNum, ts: t.timestamp });
      }
    }
    if (anchors.length === 0) return [0, 1, false] as const;

    anchors.sort((a, b) => a.lineNum - b.lineNum);
    const first = anchors[0];
    const last = anchors[anchors.length - 1];

    if (first.lineNum === last.lineNum || first.ts >= last.ts) {
      return [first.ts - 5_000_000_000, 10_000_000_000, true] as const;
    }

    const slope = (last.ts - first.ts) / (last.lineNum - first.lineNum);
    const extMin = Math.max(0, first.ts - first.lineNum * slope);
    const extMax = first.ts + (totalLines - 1 - first.lineNum) * slope;
    const extRange = extMax - extMin;

    if (extRange <= 0) return [0, 1, false] as const;

    return [extMin, extRange, true] as const;
  }, [timelines, totalLines]);

  // Scroll-wheel zoom — single viewport in line-number space
  useEffect(() => {
    const el = interactRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const bodyW = rect.width - LABEL_W;
      if (bodyW <= 0) return;
      const xInBody = Math.max(0, Math.min(bodyW, e.clientX - rect.left - LABEL_W));
      setVp(prev => doZoom(prev, xInBody / bodyW, e.deltaY < 0));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const resetZoom = useCallback(() => setVp([0, 1]), []);
  const isZoomed = vp[0] > 0.0001 || vp[1] < 0.9999;
  const zoomBy = useCallback((zoomIn: boolean) => {
    setVp(prev => doZoom(prev, 0.5, zoomIn));
  }, []);

  // Approximate visible time range (for header display)
  const visMinTs = minTs + vp[0] * tsRange;
  const visMaxTs = minTs + vp[1] * tsRange;

  // ── Empty states ────────────────────────────────────────────────────────────

  if (!session) {
    return (
      <div className="timeline-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" opacity="0.25">
          <rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor"/>
          <rect x="3" y="13" width="18" height="2" rx="1" fill="currentColor"/>
          <rect x="3" y="18" width="18" height="2" rx="1" fill="currentColor"/>
          <circle cx="8" cy="9" r="2.5" fill="currentColor"/>
          <circle cx="14" cy="14" r="2.5" fill="currentColor"/>
          <circle cx="10" cy="19" r="2.5" fill="currentColor"/>
        </svg>
        Open a log file first
      </div>
    );
  }

  if (activeTrackers.length === 0 && activeReporters.length === 0) {
    return (
      <div className="timeline-empty">
        No active state trackers or timeline-enabled reporters. Enable processors and run the pipeline.
      </div>
    );
  }

  if (loading) {
    return <div className="timeline-empty timeline-loading">Loading transitions…</div>;
  }

  const hasTrackerData = timelines.some((tl) => tl.transitions.length > 0);
  const hasReporterData = reporterTimelines.length > 0;
  if (!hasTrackerData && !hasReporterData) {
    return (
      <div className="timeline-empty">
        No data recorded. Run the pipeline to populate timeline.
      </div>
    );
  }

  return (
    <div className="state-timeline">
      <div className="timeline-header">
        <span className="timeline-header-label">Timeline</span>
        <div className="timeline-header-right">
          {hasTimeData && (
            <span className="timeline-header-range tl-time-badge">
              {isZoomed
                ? `${formatTs(visMinTs)} – ${formatTs(visMaxTs)} · ${fmtDuration(visMaxTs - visMinTs)}`
                : fmtDuration(tsRange)}
            </span>
          )}
          <div className="tl-zoom-btns">
            <button className="tl-zoom-btn" onClick={() => zoomBy(true)} title="Zoom in (scroll wheel up)">+</button>
            <button className="tl-zoom-btn" onClick={() => zoomBy(false)} title="Zoom out (scroll wheel down)">−</button>
            {isZoomed && (
              <button className="tl-zoom-btn tl-zoom-fit" onClick={resetZoom} title="Fit all">⊡</button>
            )}
          </div>
        </div>
      </div>

      <div className="timeline-interact" ref={interactRef}>
        <div className="timeline-tracks">
          {/* State tracker rows */}
          {timelines
            .filter((tl) => tl.transitions.length > 0)
            .map((tl) => (
              <TimelineTrack
                key={tl.trackerId}
                timeline={tl}
                vp={vp}
                totalLines={totalLines}
                selectedLine={selectedLineNum}
                onJump={viewer.jumpToLine}
              />
            ))}

          {/* Reporter sparkline rows */}
          {reporterTimelines.map((series) => (
            <SparklineTrack
              key={`${series.processorId}:${series.field}`}
              series={series}
              vp={vp}
              totalLines={totalLines}
              selectedLine={selectedLineNum}
              onJump={viewer.jumpToLine}
            />
          ))}
        </div>

        {/* Two-row ruler: time (approx) on top, line# below — both full width */}
        <TwoRowRuler
          vp={vp}
          totalLines={totalLines}
          minTs={minTs}
          tsRange={tsRange}
          hasTimeData={hasTimeData}
          onPan={(d) => setVp(prev => doPan(prev, d))}
        />
      </div>
    </div>
  );
}

// ── Per-tracker row — full-width body, all ticks positioned by line number ────

function TimelineTrack({
  timeline,
  vp,
  totalLines,
  selectedLine,
  onJump,
}: {
  timeline: TrackerTimeline;
  vp: Viewport;
  totalLines: number;
  selectedLine: number | null;
  onJump: (line: number) => void;
}) {
  const [tooltip, setTooltip] = useState<{ cx: number; cy: number; label: string } | null>(null);

  const [vpS, vpE] = vp;
  const vpSpan = Math.max(vpE - vpS, 1e-9);
  const maxLine = Math.max(totalLines - 1, 1);

  // All ticks use line-number position
  const pct = (lineNum: number) => {
    const norm = lineNum / maxLine;
    return `${((norm - vpS) / vpSpan * 100).toFixed(4)}%`;
  };

  // Viewport filter with small slack so edge ticks aren't clipped
  const visible = timeline.transitions.filter((t) => {
    const norm = t.lineNum / maxLine;
    return norm >= vpS - 0.01 && norm <= vpE + 0.01;
  });

  const cursorPct = selectedLine != null ? pct(selectedLine) : null;

  return (
    <div className="timeline-track">
      <div className="timeline-track-label" title={timeline.trackerName}>
        {timeline.trackerName}
      </div>

      <div className="timeline-track-body">
        <div className="timeline-rail" />
        {visible.map((t) => (
          <button
            key={t.lineNum}
            className={`timeline-tick${t.timestamp === 0 ? ' tl-line-tick' : ''}`}
            style={{ left: pct(t.lineNum) }}
            onMouseEnter={(e) => setTooltip({
              cx: e.clientX, cy: e.clientY,
              label: t.timestamp > 0
                ? `${t.transitionName} · ${formatTs(t.timestamp)} · L${(t.lineNum + 1).toLocaleString()}`
                : `${t.transitionName} · L${(t.lineNum + 1).toLocaleString()} (no timestamp)`,
            })}
            onMouseMove={(e) => setTooltip(prev => prev ? { ...prev, cx: e.clientX, cy: e.clientY } : prev)}
            onMouseLeave={() => setTooltip(null)}
            onClick={() => onJump(t.lineNum)}
          />
        ))}
        {cursorPct != null && (
          <div className="timeline-cursor" style={{ left: cursorPct }} />
        )}
      </div>

      {tooltip && (
        <div
          className="timeline-tooltip"
          style={{ position: 'fixed', left: tooltip.cx, top: tooltip.cy - 40, transform: 'translateX(-50%)' }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

// ── Sparkline track — SVG polyline for reporter numeric data ──────────────────

function SparklineTrack({
  series,
  vp,
  totalLines,
  selectedLine,
  onJump,
}: {
  series: TimelineSeriesData;
  vp: Viewport;
  totalLines: number;
  selectedLine: number | null;
  onJump: (line: number) => void;
}) {
  const [tooltip, setTooltip] = useState<{ cx: number; cy: number; label: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [vpS, vpE] = vp;
  const vpSpan = Math.max(vpE - vpS, 1e-9);
  const maxLine = Math.max(totalLines - 1, 1);
  const color = series.color ?? '#58a6ff';

  const TRACK_HEIGHT = 40;
  const PADDING_Y = 4;
  const drawH = TRACK_HEIGHT - PADDING_Y * 2;

  // Value range with a small guard against flat lines
  const valRange = series.maxValue - series.minValue;
  const effectiveRange = valRange > 0 ? valRange : 1;

  // Build SVG path — only points within the viewport
  const pathData = useMemo(() => {
    const pts = series.points;
    if (pts.length === 0) return { linePath: '', areaPath: '' };

    // Filter to visible points (with small margin)
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
      return PADDING_Y + drawH * (1 - normalized); // Flip Y: high values at top
    };

    const lineSegments = visiblePts.map((p) => `${toX(p.lineNum).toFixed(3)},${toY(p.value).toFixed(2)}`);
    const linePath = `M${lineSegments.join(' L')}`;

    // Area fill: same path but close at bottom
    const firstX = toX(visiblePts[0].lineNum).toFixed(3);
    const lastX = toX(visiblePts[visiblePts.length - 1].lineNum).toFixed(3);
    const bottomY = (TRACK_HEIGHT).toFixed(2);
    const areaPath = `${linePath} L${lastX},${bottomY} L${firstX},${bottomY} Z`;

    return { linePath, areaPath };
  }, [series.points, vpS, vpE, vpSpan, maxLine, series.minValue, effectiveRange, drawH]);

  // Cursor position
  const cursorPct = selectedLine != null
    ? `${((selectedLine / maxLine - vpS) / vpSpan * 100).toFixed(4)}%`
    : null;

  // Mouse interaction: find nearest point and show tooltip
  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const lineAtCursor = (vpS + xFrac * vpSpan) * maxLine;

    // Find the nearest point
    let nearest = series.points[0];
    let bestDist = Infinity;
    for (const p of series.points) {
      const dist = Math.abs(p.lineNum - lineAtCursor);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = p;
      }
    }

    if (nearest) {
      const formattedVal = Number.isInteger(nearest.value)
        ? nearest.value.toLocaleString()
        : nearest.value.toFixed(1);
      setTooltip({
        cx: e.clientX,
        cy: e.clientY,
        label: `${series.label}: ${formattedVal} · L${(nearest.lineNum + 1).toLocaleString()}`,
      });
    }
  }, [series.points, series.label, vpS, vpSpan, maxLine]);

  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const lineAtCursor = (vpS + xFrac * vpSpan) * maxLine;

    let nearest = series.points[0];
    let bestDist = Infinity;
    for (const p of series.points) {
      const dist = Math.abs(p.lineNum - lineAtCursor);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = p;
      }
    }
    if (nearest) onJump(nearest.lineNum);
  }, [series.points, vpS, vpSpan, maxLine, onJump]);

  // Min/max labels
  const minLabel = Number.isInteger(series.minValue) ? series.minValue.toLocaleString() : series.minValue.toFixed(1);
  const maxLabel = Number.isInteger(series.maxValue) ? series.maxValue.toLocaleString() : series.maxValue.toFixed(1);

  return (
    <div className="timeline-track timeline-sparkline-track">
      <div className="timeline-track-label timeline-sparkline-label" title={`${series.processorName}: ${series.label}`} style={{ color }}>
        {series.label}
      </div>

      <div className="timeline-track-body timeline-sparkline-body" style={{ height: TRACK_HEIGHT }}>
        <svg
          ref={svgRef}
          className="timeline-sparkline-svg"
          viewBox={`0 0 100 ${TRACK_HEIGHT}`}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setTooltip(null)}
          onClick={handleClick}
        >
          {/* Area fill */}
          {pathData.areaPath && (
            <path d={pathData.areaPath} fill={color} opacity="0.12" />
          )}
          {/* Line */}
          {pathData.linePath && (
            <path
              d={pathData.linePath}
              fill="none"
              stroke={color}
              strokeWidth="0.4"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          )}
        </svg>

        {/* Y-axis range labels */}
        <span className="timeline-sparkline-ymax">{maxLabel}</span>
        <span className="timeline-sparkline-ymin">{minLabel}</span>

        {/* Cursor */}
        {cursorPct != null && (
          <div className="timeline-cursor" style={{ left: cursorPct }} />
        )}
      </div>

      {tooltip && (
        <div
          className="timeline-tooltip"
          style={{ position: 'fixed', left: tooltip.cx, top: tooltip.cy - 40, transform: 'translateX(-50%)' }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

// ── Two-row ruler ─────────────────────────────────────────────────────────────

function TwoRowRuler({
  vp,
  totalLines,
  minTs,
  tsRange,
  hasTimeData,
  onPan,
}: {
  vp: Viewport;
  totalLines: number;
  minTs: number;
  tsRange: number;
  hasTimeData: boolean;
  onPan: (deltaNorm: number) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(0);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBodyW(e.contentRect.width));
    ro.observe(el);
    setBodyW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const [vpS, vpE] = vp;
  const vpSpan = Math.max(vpE - vpS, 1e-9);
  const maxLine = Math.max(totalLines - 1, 1);

  // [0..1] normalized line-number position → CSS left %
  const normPct = (norm: number) =>
    `${((norm - vpS) / vpSpan * 100).toFixed(4)}%`;

  // TIME row: tick positions derived from ts → norm = (ts - minTs) / tsRange
  const timeTicks = (() => {
    if (!hasTimeData || tsRange <= 0) return [];
    const visMinTs = minTs + vpS * tsRange;
    const visDurTs = vpSpan * tsRange;
    const count = Math.max(2, Math.floor(bodyW / 110));
    const interval = niceTimeInterval(visDurTs / count);
    const first = Math.ceil(visMinTs / interval) * interval;
    const result: { norm: number; label: string }[] = [];
    for (let ts = first; ts <= visMinTs + visDurTs; ts += interval) {
      result.push({ norm: (ts - minTs) / tsRange, label: formatTs(ts) });
      if (result.length > 200) break;
    }
    return result;
  })();

  // LINE# row: tick positions by line number
  const lineTicks = (() => {
    const visMinLine = vpS * maxLine;
    const visDurLine = vpSpan * maxLine;
    const count = Math.max(2, Math.floor(bodyW / 70));
    const step = niceLineStep(visDurLine / count);
    const first = Math.ceil(visMinLine / step) * step;
    const result: { norm: number; label: string }[] = [];
    for (let ln = first; ln <= visMinLine + visDurLine; ln += step) {
      result.push({ norm: ln / maxLine, label: (ln + 1).toLocaleString() });
      if (result.length > 200) break;
    }
    return result;
  })();

  // Drag-to-pan
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let lastX = e.clientX;
    const w = bodyRef.current?.getBoundingClientRect().width ?? 1;
    const span = vpSpan;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      onPan(-(dx / w) * span);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="tl-two-row-ruler">
      <div className="tl-ruler-spacer">
        <div
          className="tl-row-axis-label tl-time-label"
          title="Approximate time based on session start/end timestamps (assumes uniform log rate)"
        >
          ~Time
        </div>
        <div className="tl-row-axis-label tl-line-label">Line #</div>
      </div>

      <div className="tl-two-row-body" ref={bodyRef} onMouseDown={onMouseDown}>
        <div className="tl-ruler-row">
          {hasTimeData
            ? timeTicks.map((tick, i) => (
                <div key={i} className="tl-ruler-tick" style={{ left: normPct(tick.norm) }}>
                  <span className="tl-ruler-label">{tick.label}</span>
                </div>
              ))
            : <span className="tl-ruler-empty-label">no timestamps in session</span>
          }
        </div>

        <div className="tl-ruler-row tl-ruler-row-line">
          {lineTicks.map((tick, i) => (
            <div key={i} className="tl-ruler-tick tl-ruler-tick-line" style={{ left: normPct(tick.norm) }}>
              <span className="tl-ruler-label">{tick.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
