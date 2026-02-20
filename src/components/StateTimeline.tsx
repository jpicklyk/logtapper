import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import type { StateTransition } from '../bridge/types';

interface TrackerTimeline {
  trackerId: string;
  trackerName: string;
  transitions: StateTransition[];
}

export default function StateTimeline() {
  const { viewer, pipeline, stateTracker, selectedLineNum } = useAppContext();
  const [timelines, setTimelines] = useState<TrackerTimeline[]>([]);
  const [loading, setLoading] = useState(false);
  // True once we've completed at least one successful fetch. While true,
  // subsequent fetches update silently — no loading flash on streaming ticks.
  const hasDataRef = useRef(false);

  const activeTrackers = pipeline.pipelineChain
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p != null && p.processorType === 'state_tracker');

  useEffect(() => {
    if (!viewer.session || activeTrackers.length === 0) {
      setTimelines([]);
      hasDataRef.current = false;
      return;
    }
    const sessionId = viewer.session.sessionId;

    // Only show the loading state on the very first fetch (no data yet).
    if (!hasDataRef.current) {
      setLoading(true);
    }

    Promise.allSettled(
      activeTrackers.map((t) =>
        stateTracker.getTransitions(sessionId, t.id).then((transitions) => ({
          trackerId: t.id,
          trackerName: t.name,
          transitions,
        })),
      ),
    ).then((results) => {
      const next = results
        .filter((r): r is PromiseFulfilledResult<TrackerTimeline> => r.status === 'fulfilled')
        .map((r) => r.value);

      hasDataRef.current = true;

      // Bail out if transition counts haven't changed — state_tracker_results
      // only updates on full pipeline runs, not on every streaming batch tick,
      // so the data is identical between ticks. Comparing counts is sufficient
      // since transitions are only ever appended.
      setTimelines((prev) => {
        if (
          prev.length === next.length &&
          prev.every((p, i) =>
            p.trackerId === next[i].trackerId &&
            p.transitions.length === next[i].transitions.length,
          )
        ) {
          return prev; // same reference → React skips the re-render
        }
        return next;
      });
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.runCount, viewer.session]);

  const totalLines = viewer.session?.totalLines ?? 1;

  if (!viewer.session) {
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
        <span className="timeline-header-range">
          {totalLines.toLocaleString()} lines
        </span>
      </div>
      <div className="timeline-tracks">
        {timelines
          .filter((tl) => tl.transitions.length > 0)
          .map((tl) => (
            <TimelineTrack
              key={tl.trackerId}
              timeline={tl}
              totalLines={totalLines}
              selectedLine={selectedLineNum}
              onJump={viewer.jumpToLine}
            />
          ))}
      </div>
      {/* X-axis ruler */}
      <TimelineRuler totalLines={totalLines} />
    </div>
  );
}

// ── Per-tracker row ──────────────────────────────────────────────────────────

function TimelineTrack({
  timeline,
  totalLines,
  selectedLine,
  onJump,
}: {
  timeline: TrackerTimeline;
  totalLines: number;
  selectedLine: number | null;
  onJump: (line: number) => void;
}) {
  // Use viewport coordinates so the tooltip renders with position:fixed and
  // escapes the overflow:hidden parent — avoiding clipping behind the header.
  const [tooltip, setTooltip] = useState<{ cx: number; cy: number; label: string } | null>(null);

  const pct = (line: number) =>
    `${((line / Math.max(totalLines - 1, 1)) * 100).toFixed(4)}%`;

  return (
    <div className="timeline-track">
      <div className="timeline-track-label" title={timeline.trackerName}>
        {timeline.trackerName}
      </div>
      <div className="timeline-track-body">
        {/* Background rail */}
        <div className="timeline-rail" />

        {/* Transitions */}
        {timeline.transitions.map((t, i) => (
          <button
            key={i}
            className="timeline-tick"
            style={{ left: pct(t.lineNum) }}
            onMouseEnter={(e) => {
              setTooltip({
                cx: e.clientX,
                cy: e.clientY,
                label: `${t.transitionName} · L${(t.lineNum + 1).toLocaleString()}`,
              });
            }}
            onMouseMove={(e) => {
              setTooltip((prev) => prev ? { ...prev, cx: e.clientX, cy: e.clientY } : prev);
            }}
            onMouseLeave={() => setTooltip(null)}
            onClick={() => onJump(t.lineNum)}
          />
        ))}

        {/* Selected-line cursor */}
        {selectedLine != null && (
          <div
            className="timeline-cursor"
            style={{ left: pct(selectedLine) }}
          />
        )}

        {/* Tooltip — fixed so it escapes overflow clipping */}
        {tooltip && (
          <div
            className="timeline-tooltip"
            style={{
              position: 'fixed',
              left: tooltip.cx,
              top: tooltip.cy - 36,
              transform: 'translateX(-50%)',
            }}
          >
            {tooltip.label}
          </div>
        )}
      </div>
    </div>
  );
}

// ── X-axis ruler ─────────────────────────────────────────────────────────────

function TimelineRuler({ totalLines }: { totalLines: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const tickCount = Math.max(2, Math.floor(width / 80));
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) =>
    Math.round((i / tickCount) * (totalLines - 1)),
  );

  return (
    <div className="timeline-ruler" ref={containerRef}>
      {ticks.map((line) => (
        <div
          key={line}
          className="timeline-ruler-tick"
          style={{ left: `${((line / Math.max(totalLines - 1, 1)) * 100).toFixed(4)}%` }}
        >
          <span className="timeline-ruler-label">
            {line === 0 ? '1' : (line + 1).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
