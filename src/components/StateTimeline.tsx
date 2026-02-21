import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import type { StateTransition } from '../bridge/types';

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
  const [loading, setLoading] = useState(false);
  // Single viewport in normalized line-number space [0..1]
  const [vp, setVp] = useState<Viewport>([0, 1]);
  const hasDataRef = useRef(false);
  const interactRef = useRef<HTMLDivElement>(null);

  const activeTrackers = pipeline.pipelineChain
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p != null && p.processorType === 'state_tracker');

  useEffect(() => {
    if (!viewer.session || activeTrackers.length === 0) {
      setTimelines([]);
      setVp([0, 1]);
      hasDataRef.current = false;
      return;
    }
    const sessionId = viewer.session.sessionId;
    if (!hasDataRef.current) setLoading(true);

    Promise.allSettled(
      activeTrackers.map((t) =>
        stateTracker.getTransitions(sessionId, t.id).then((trans) => ({
          trackerId: t.id,
          trackerName: t.name,
          transitions: trans,
        })),
      ),
    ).then((results) => {
      const next = results
        .filter((r): r is PromiseFulfilledResult<TrackerTimeline> => r.status === 'fulfilled')
        .map((r) => r.value);
      hasDataRef.current = true;
      setTimelines((prev) => {
        if (
          prev.length === next.length &&
          prev.every((p, i) =>
            p.trackerId === next[i].trackerId &&
            p.transitions.length === next[i].transitions.length,
          )
        ) return prev;
        return next;
      });
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.runCount, viewer.session]);

  const session = viewer.session;
  const totalLines = session?.totalLines ?? 1;

  // Session time bounds — derived from transition timestamps, NOT session metadata.
  // session.firstTimestamp / lastTimestamp are unreliable for bugreport files because
  // the dumpstate header line gets a year-2026 Unix-ns timestamp while logcat lines
  // use a year-2000-base, making firstTs > lastTs and causing hasTimeData = false.
  const [minTs, tsRange, hasTimeData] = useMemo(() => {
    // Collect all transitions that carry a real timestamp
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

    // If all timestamps are on the same line, give a ±5 s window around that point
    if (first.lineNum === last.lineNum || first.ts >= last.ts) {
      return [first.ts - 5_000_000_000, 10_000_000_000, true] as const;
    }

    // Linear extrapolation: compute slope (ns per line) and extend to line 0 and totalLines-1
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

  if (activeTrackers.length === 0) {
    return (
      <div className="timeline-empty">
        No active state trackers. Enable a StateTracker and run the pipeline.
      </div>
    );
  }

  if (loading) {
    return <div className="timeline-empty timeline-loading">Loading transitions…</div>;
  }

  const hasData = timelines.some((tl) => tl.transitions.length > 0);
  if (!hasData) {
    return (
      <div className="timeline-empty">
        No transitions recorded. Run the pipeline to populate state history.
      </div>
    );
  }

  return (
    <div className="state-timeline">
      <div className="timeline-header">
        <span className="timeline-header-label">State Timeline</span>
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
//
// Ticks with timestamp > 0 render in accent-blue.
// Ticks with timestamp == 0 (kernel lines / no-timestamp) render in amber.
// Hovering any tick shows its exact line number; timestamped ticks also show time.

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

// ── Two-row ruler ─────────────────────────────────────────────────────────────
//
// Both rows share the same horizontal coordinate: normalized line-number space.
//
// TIME row (top): tick labels at regular time intervals. Each label's x-position
// is derived from ts → approx line via linear interpolation using session bounds:
//   norm = (ts - minTs) / tsRange
// This assumes uniform log rate, so is approximate — but gives useful time context
// for any visible region. Hover a transition tick above to see its exact time.
//
// LINE# row (bottom): tick labels at regular line-number intervals. Always exact.
//
// Drag-to-pan on the body pans both rows simultaneously (same viewport).

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
  // (same as approxLine / maxLine, cancels out)
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

  // Drag-to-pan — captures vpSpan at mousedown for stable pan speed
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let lastX = e.clientX;
    const w = bodyRef.current?.getBoundingClientRect().width ?? 1;
    const span = vpSpan; // capture at drag start
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
      {/* Label column — shows axis names aligned with their ruler rows */}
      <div className="tl-ruler-spacer">
        <div
          className="tl-row-axis-label tl-time-label"
          title="Approximate time based on session start/end timestamps (assumes uniform log rate)"
        >
          ~Time
        </div>
        <div className="tl-row-axis-label tl-line-label">Line #</div>
      </div>

      {/* Body — drag to pan both rows */}
      <div className="tl-two-row-body" ref={bodyRef} onMouseDown={onMouseDown}>

        {/* Row 1: Time (approx) */}
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

        {/* Row 2: Line number */}
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
