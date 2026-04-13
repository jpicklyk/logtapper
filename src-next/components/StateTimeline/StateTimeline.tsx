import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineSeriesData, ProcessorSummary, Bookmark } from '../../bridge/types';
import type { AppEvents } from '../../events/events';
import { getTimelineData } from '../../bridge/commands';
import { Button } from '../../ui';
import {
  useSession,
  useProcessors,
  usePipelineChain,
  useNavigationActions,
  useSessionPipelineResults,
} from '../../context';
import { useStateTracker, useBookmarks, useSettings } from '../../hooks';
import { bus } from '../../events';
import { clamp } from '../../utils';
import styles from './StateTimeline.module.css';
import {
  type Viewport,
  type TrackerTimeline,
  formatTs,
  fmtDuration,
  linePct,
  doZoom,
  doPan,
  LABEL_W,
} from './timelineUtils';
import TimelineTrack from './TimelineTrack';
import SparklineTrack from './SparklineTrack';
import LineRuler from './LineRuler';

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
      <div className={styles.cursor} style={{ '--cursor-pos': linePct(selectedRange[0], maxLine, vpS, vpSpan) } as React.CSSProperties} />
      {selectedRange[0] !== selectedRange[1] && (
        <div className={styles.cursor} style={{ '--cursor-pos': linePct(selectedRange[1], maxLine, vpS, vpSpan) } as React.CSSProperties} />
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
            className={styles.bookmarkMarker}
            style={{ '--marker-pos': linePct(b.lineNumber, maxLine, vpS, vpSpan), '--marker-color': color } as React.CSSProperties}
            title={b.label}
            onClick={(e) => { e.stopPropagation(); jumpToLine(b.lineNumber); }}
          />
        );
      })}
    </div>
  );
});

// ── Main component ───────────────────────────────────────────────────────────

const StateTimeline = React.memo(function StateTimeline() {
  const session = useSession();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();
  const { runCount } = useSessionPipelineResults();
  const { jumpToLine } = useNavigationActions();
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
  const handlePan = useCallback((d: number) => {
    setVp((prev) => doPan(prev, d));
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
          onPan={handlePan}
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

