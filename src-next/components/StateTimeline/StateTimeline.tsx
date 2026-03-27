import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StateTransition, TimelineSeriesData, ProcessorSummary, Bookmark } from '../../bridge/types';
import type { AppEvents } from '../../events/events';
import { getTimelineData } from '../../bridge/commands';
import { Button } from '../../ui';
import {
  useSession,
  useProcessors,
  usePipelineChain,
  usePipelineResults,
  useViewerActions,
} from '../../context';
import { useStateTracker, useBookmarks, useSettings } from '../../hooks';
import { bus } from '../../events';
import { clamp } from '../../utils';
import styles from './StateTimeline.module.css';

type Viewport = readonly [number, number];

interface TrackerTimeline {
  trackerId: string;
  trackerName: string;
  transitions: StateTransition[];
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatTs(tsNanos: number, includeDate = false): string {
  const d = new Date(tsNanos / 1_000_000);
  const time = [
    d.getUTCHours().toString().padStart(2, '0'),
    d.getUTCMinutes().toString().padStart(2, '0'),
    d.getUTCSeconds().toString().padStart(2, '0'),
  ].join(':') + '.' + d.getUTCMilliseconds().toString().padStart(3, '0');
  if (!includeDate) return time;
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${month}-${day} ${time}`;
}

function fmtDuration(nanos: number): string {
  if (nanos < 1e6) return `${(nanos / 1e3).toFixed(1)}us`;
  if (nanos < 1e9) return `${(nanos / 1e6).toFixed(0)}ms`;
  if (nanos < 60e9) return `${(nanos / 1e9).toFixed(2)}s`;
  if (nanos < 3600e9) return `${(nanos / 60e9).toFixed(1)}m`;
  return `${(nanos / 3600e9).toFixed(2)}h`;
}

/** Convert a line number to a CSS percentage position within the viewport. */
function linePct(lineNum: number, maxLine: number, vpS: number, vpSpan: number): string {
  return `${((lineNum / maxLine - vpS) / vpSpan * 100).toFixed(4)}%`;
}

function niceLineStep(raw: number): number {
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  for (const s of steps) if (s >= raw) return s;
  return steps[steps.length - 1];
}

/** Selection cursor overlay — spans the full height of the interact area.
 *  The overlay div covers the track body area (left: LABEL_W, right: 0)
 *  so cursors inside use simple percentage positioning. */
function SelectionCursors({
  selectedRange,
  maxLine,
  vpS,
  vpSpan,
}: {
  selectedRange: [number, number] | null;
  maxLine: number;
  vpS: number;
  vpSpan: number;
}) {
  if (!selectedRange) return null;
  return (
    <div className={styles.cursorOverlay}>
      <div className={styles.cursor} style={{ left: linePct(selectedRange[0], maxLine, vpS, vpSpan) }} />
      {selectedRange[0] !== selectedRange[1] && (
        <div className={styles.cursor} style={{ left: linePct(selectedRange[1], maxLine, vpS, vpSpan) }} />
      )}
    </div>
  );
}

/** Bookmark markers overlay — positioned over the track body area (left: LABEL_W).
 *  Follows the same pattern as SelectionCursors. */
const BookmarkMarkers = React.memo(function BookmarkMarkers({
  bookmarks,
  maxLine,
  vpS,
  vpSpan,
  jumpToLine,
  categoryColorMap,
}: {
  bookmarks: Bookmark[];
  maxLine: number;
  vpS: number;
  vpSpan: number;
  jumpToLine: (lineNum: number) => void;
  categoryColorMap: Record<string, string>;
}) {
  if (bookmarks.length === 0 || maxLine === 0) return null;
  return (
    <div className={`${styles.cursorOverlay} ${styles.noPointerEvents}`}>
      {bookmarks.map((b) => {
        const norm = b.lineNumber / maxLine;
        // Skip markers outside the visible viewport (with a small margin)
        if (norm < vpS - 0.005 || norm > vpSpan + vpS + 0.005) return null;
        const color = categoryColorMap[b.category ?? 'custom'] ?? 'var(--text-dimmed)';
        return (
          <div
            key={b.id}
            style={{
              position: 'absolute',
              left: linePct(b.lineNumber, maxLine, vpS, vpSpan),
              top: 0,
              bottom: 0,
              width: 2,
              backgroundColor: color,
              opacity: 0.7,
              cursor: 'pointer',
              zIndex: 3, // TODO: use z-index token once CSS var() works in inline styles
              pointerEvents: 'auto',
            }}
            title={b.label}
            onClick={(e) => { e.stopPropagation(); jumpToLine(b.lineNumber); }}
          />
        );
      })}
    </div>
  );
});

function doZoom([s, e]: Viewport, xFrac: number, zoomIn: boolean): Viewport {
  const span = e - s;
  const factor = zoomIn ? 0.6 : 1 / 0.6;
  const newSpan = clamp(span * factor, 0.0005, 1);
  const center = s + xFrac * span;
  let ns = center - xFrac * newSpan;
  let ne = ns + newSpan;
  if (ns < 0) { ns = 0; ne = newSpan; }
  if (ne > 1) { ne = 1; ns = 1 - newSpan; }
  return [ns, ne];
}

function doPan([s, e]: Viewport, deltaNorm: number): Viewport {
  const span = e - s;
  const ns = clamp(s + deltaNorm, 0, 1 - span);
  return [ns, ns + span];
}

const LABEL_W = 130;

// ── Main component ───────────────────────────────────────────────────────────

const StateTimeline = React.memo(function StateTimeline() {
  const session = useSession();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();
  const { runCount } = usePipelineResults();
  const { jumpToLine } = useViewerActions();
  const stateTracker = useStateTracker();
  const { bookmarks } = useBookmarks(session?.sessionId ?? null);
  const { settings } = useSettings();
  const timelineCategoryColors = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of settings.bookmarkCategories) map[c.id] = c.color;
    return map;
  }, [settings.bookmarkCategories]);

  const [timelines, setTimelines] = useState<TrackerTimeline[]>([]);
  const [reporterTimelines, setReporterTimelines] = useState<TimelineSeriesData[]>([]);
  const [loading, setLoading] = useState(false);
  const [vp, setVp] = useState<Viewport>([0, 1]);
  const hasDataRef = useRef(false);
  const interactRef = useRef<HTMLDivElement>(null);

  // Selection cursor(s) driven by the event bus
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);

  useEffect(() => {
    const handler = (ev: AppEvents['selection:changed']) => {
      if (ev.sessionId === session?.sessionId) {
        setSelectedRange(ev.range);
      } else {
        setSelectedRange(null);
      }
    };
    bus.on('selection:changed', handler);
    return () => { bus.off('selection:changed', handler); };
  }, [session?.sessionId]);

  const activeTrackers = useMemo<ProcessorSummary[]>(
    () =>
      pipelineChain
        .map((id) => processors.find((p) => p.id === id))
        .filter((p): p is ProcessorSummary =>
          p != null && p.processorType === 'state_tracker' && p.trackerTimeline !== false),
    [pipelineChain, processors],
  );

  const activeReporters = useMemo<ProcessorSummary[]>(
    () =>
      pipelineChain
        .map((id) => processors.find((p) => p.id === id))
        .filter((p): p is ProcessorSummary => p != null && p.processorType === 'reporter'),
    [pipelineChain, processors],
  );

  // Fetch timeline data when the session or pipeline run changes.
  // Depend on sessionId (not the full session object) to avoid refetching on
  // every ADB batch — session.totalLines updates ~50ms during streaming, but
  // timeline data only changes when the pipeline re-runs (runCount bump).
  const sessionId = session?.sessionId ?? null;

  useEffect(() => {
    if (!sessionId) {
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

    if (!hasDataRef.current) setLoading(true);

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
          prev.every(
            (p, i) =>
              p.trackerId === nextTrackers[i].trackerId &&
              p.transitions.length === nextTrackers[i].transitions.length,
          )
        )
          return prev;
        return nextTrackers;
      });
      setReporterTimelines((prev) => {
        if (
          prev.length === nextReporters.length &&
          prev.every(
            (p, i) =>
              p.processorId === nextReporters[i].processorId &&
              p.field === nextReporters[i].field &&
              p.points.length === nextReporters[i].points.length,
          )
        )
          return prev;
        return nextReporters;
      });
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCount, sessionId]);

  const totalLines = session?.totalLines ?? 1;
  const maxLine = Math.max(totalLines - 1, 1);

  const [minTs, tsRange, hasTimeData, spansMultipleDays] = useMemo(() => {
    const anchors: { lineNum: number; ts: number }[] = [];
    for (const tl of timelines) {
      for (const t of tl.transitions) {
        if (t.timestamp > 0) anchors.push({ lineNum: t.lineNum, ts: t.timestamp });
      }
    }
    if (anchors.length === 0) return [0, 1, false, false] as const;
    anchors.sort((a, b) => a.lineNum - b.lineNum);
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    if (first.lineNum === last.lineNum || first.ts >= last.ts) {
      return [first.ts - 5_000_000_000, 10_000_000_000, true, false] as const;
    }
    const slope = (last.ts - first.ts) / (last.lineNum - first.lineNum);
    const extMin = Math.max(0, first.ts - first.lineNum * slope);
    const extMax = first.ts + (totalLines - 1 - first.lineNum) * slope;
    const extRange = extMax - extMin;
    if (extRange <= 0) return [0, 1, false, false] as const;
    // Check if range spans more than 24 hours (in nanos)
    const multiDay = extRange > 86_400_000_000_000;
    return [extMin, extRange, true, multiDay] as const;
  }, [timelines, totalLines]);

  // Scroll-wheel zoom
  useEffect(() => {
    const el = interactRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const bodyW = rect.width - LABEL_W;
      if (bodyW <= 0) return;
      const xInBody = clamp(e.clientX - rect.left - LABEL_W, 0, bodyW);
      setVp((prev) => doZoom(prev, xInBody / bodyW, e.deltaY < 0));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const resetZoom = useCallback(() => setVp([0, 1]), []);
  const isZoomed = vp[0] > 0.0001 || vp[1] < 0.9999;
  const zoomBy = useCallback((zoomIn: boolean) => {
    setVp((prev) => doZoom(prev, 0.5, zoomIn));
  }, []);


  const visMinTs = minTs + vp[0] * tsRange;
  const visMaxTs = minTs + vp[1] * tsRange;

  if (!session) {
    return (
      <div className={styles.empty}>Open a log file first</div>
    );
  }

  if (activeTrackers.length === 0 && activeReporters.length === 0) {
    return (
      <div className={styles.empty}>
        No active state trackers or timeline-enabled reporters. Enable processors and run the pipeline.
      </div>
    );
  }

  if (loading) {
    return <div className={`${styles.empty} ${styles.loading}`}>Loading transitions...</div>;
  }

  const hasTrackerData = timelines.some((tl) => tl.transitions.length > 0);
  const hasReporterData = reporterTimelines.length > 0;
  if (!hasTrackerData && !hasReporterData) {
    return (
      <div className={styles.empty}>
        No data recorded. Run the pipeline to populate timeline.
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Timeline</span>
        <div className={styles.headerRight}>
          {hasTimeData && (
            <span className={styles.headerRange}>
              {isZoomed
                ? `${formatTs(visMinTs, spansMultipleDays)} -- ${formatTs(visMaxTs, spansMultipleDays)} . ${fmtDuration(visMaxTs - visMinTs)}`
                : fmtDuration(tsRange)}
            </span>
          )}
          <div className={styles.zoomBtns}>
            <Button variant="ghost" size="sm" className={styles.zoomBtn} onClick={() => zoomBy(true)} title="Zoom in">
              +
            </Button>
            <Button variant="ghost" size="sm" className={styles.zoomBtn} onClick={() => zoomBy(false)} title="Zoom out">
              -
            </Button>
            {isZoomed && (
              <Button variant="ghost" size="sm" className={styles.zoomBtn} onClick={resetZoom} title="Fit all">
                Fit
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className={styles.interact} ref={interactRef}>
        <div className={styles.tracks}>
          {timelines
            .filter((tl) => tl.transitions.length > 0)
            .map((tl) => (
              <TimelineTrack
                key={tl.trackerId}
                timeline={tl}
                vp={vp}
                totalLines={totalLines}
                onJump={jumpToLine}
                showDate={spansMultipleDays}
              />
            ))}

          {reporterTimelines.map((series) => (
            <SparklineTrack
              key={`${series.processorId}:${series.field}`}
              series={series}
              vp={vp}
              totalLines={totalLines}
              onJump={jumpToLine}
              minTs={minTs}
              tsRange={tsRange}
              hasTimeData={hasTimeData}
              showDate={spansMultipleDays}
            />
          ))}
        </div>

        <LineRuler
          vp={vp}
          totalLines={totalLines}
          onPan={(d) => setVp((prev) => doPan(prev, d))}
        />

        {/* Selection cursors span the full height of the interact area (all tracks + ruler) */}
        <SelectionCursors selectedRange={selectedRange} maxLine={maxLine} vpS={vp[0]} vpSpan={Math.max(vp[1] - vp[0], 1e-9)} />

        {/* Bookmark markers span the full height of the interact area */}
        <BookmarkMarkers
          bookmarks={bookmarks}
          maxLine={maxLine}
          vpS={vp[0]}
          vpSpan={Math.max(vp[1] - vp[0], 1e-9)}
          jumpToLine={jumpToLine}
          categoryColorMap={timelineCategoryColors}
        />
      </div>
    </div>
  );
});

export default StateTimeline;

// ── TimelineTrack ────────────────────────────────────────────────────────────

function TimelineTrack({
  timeline,
  vp,
  totalLines,
  onJump,
  showDate = false,
}: {
  timeline: TrackerTimeline;
  vp: Viewport;
  totalLines: number;
  onJump: (line: number) => void;
  showDate?: boolean;
}) {
  const [tooltip, setTooltip] = useState<{ cx: number; cy: number; label: string } | null>(null);

  const [vpS, vpE] = vp;
  const vpSpan = Math.max(vpE - vpS, 1e-9);
  const maxLine = Math.max(totalLines - 1, 1);

  const visible = timeline.transitions.filter((t) => {
    const norm = t.lineNum / maxLine;
    return norm >= vpS - 0.01 && norm <= vpE + 0.01;
  });

  return (
    <div className={styles.track}>
      <div className={styles.trackLabel} title={timeline.trackerName}>
        {timeline.trackerName}
      </div>
      <div className={styles.trackBody}>
        <div className={styles.rail} />
        {visible.map((t) => (
          <button
            key={t.lineNum}
            className={`${styles.tick}${t.timestamp === 0 ? ` ${styles.tickNoTs}` : ''}`}
            style={{ left: linePct(t.lineNum, maxLine, vpS, vpSpan) }}
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
          className={styles.tooltip}
          style={{ position: 'fixed', left: tooltip.cx, top: tooltip.cy - 40, transform: 'translateX(-50%)' }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

// ── SparklineTrack ───────────────────────────────────────────────────────────

function SparklineTrack({
  series,
  vp,
  totalLines,
  onJump,
  minTs,
  tsRange,
  hasTimeData,
  showDate = false,
}: {
  series: TimelineSeriesData;
  vp: Viewport;
  totalLines: number;
  onJump: (line: number) => void;
  minTs: number;
  tsRange: number;
  hasTimeData: boolean;
  showDate?: boolean;
}) {
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

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const lineAtCursor = (vpS + xFrac * vpSpan) * maxLine;
    let nearest = series.points[0];
    let bestDist = Infinity;
    for (const p of series.points) {
      const dist = Math.abs(p.lineNum - lineAtCursor);
      if (dist < bestDist) { bestDist = dist; nearest = p; }
    }
    if (nearest) {
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
    }
  }, [series.points, series.label, vpS, vpSpan, maxLine, hasTimeData, tsRange, minTs, showDate]);

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
      if (dist < bestDist) { bestDist = dist; nearest = p; }
    }
    if (nearest) onJump(nearest.lineNum);
  }, [series.points, vpS, vpSpan, maxLine, onJump]);

  const minLabel = Number.isInteger(series.minValue) ? series.minValue.toLocaleString() : series.minValue.toFixed(1);
  const maxLabel = Number.isInteger(series.maxValue) ? series.maxValue.toLocaleString() : series.maxValue.toFixed(1);

  return (
    <div className={styles.track}>
      <div className={styles.trackLabel} title={`${series.processorName}: ${series.label}`} style={{ color }}>
        {series.processorName}: {series.label}
      </div>
      <div className={styles.trackBody} style={{ height: TRACK_HEIGHT }}>
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
        <div className={styles.tooltip} style={{ position: 'fixed', left: tooltip.cx, top: tooltip.cy - 40, transform: 'translateX(-50%)' }}>
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

// ── LineRuler ─────────────────────────────────────────────────────────────────

function LineRuler({
  vp,
  totalLines,
  onPan,
}: {
  vp: Viewport;
  totalLines: number;
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

  const normPct = (norm: number) => linePct(norm * maxLine, maxLine, vpS, vpSpan);

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
    <div className={styles.ruler}>
      <div className={styles.rulerSpacer}>
        <div className={styles.rulerAxisLabel}>Line #</div>
      </div>
      <div className={styles.rulerBody} ref={bodyRef} onMouseDown={onMouseDown}>
        <div className={styles.rulerRow}>
          {lineTicks.map((tick, i) => (
            <div key={i} className={styles.rulerTick} style={{ left: normPct(tick.norm) }}>
              <span className={styles.rulerLabel}>{tick.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
