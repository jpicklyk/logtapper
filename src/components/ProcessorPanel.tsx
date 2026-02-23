import { Fragment, useEffect, useCallback, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { PipelineState } from '../hooks/usePipeline';
import type { PipelineRunSummary, PipelineProgress, McpStatus } from '../bridge/types';
import { getMcpStatus } from '../bridge/commands';

interface Props {
  pipeline: PipelineState;
  sessionId: string | null;
  isStreaming: boolean;
  onOpenLibrary: () => void;
  cacheSize: number;
  cacheMax: number;
}

// ── RingBufferWidget ─────────────────────────────────────────────────────────

function RingBufferWidget({ cacheSize, cacheMax, isStreaming }: {
  cacheSize: number;
  cacheMax: number;
  isStreaming: boolean;
}) {
  const R = 30;
  const CX = 44;
  const CY = 44;
  const TRACK_W = 7;
  const circumference = 2 * Math.PI * R;
  const fill = cacheMax > 0 ? Math.min(cacheSize / cacheMax, 1) : 0;
  const dashOffset = circumference * (1 - fill);
  const pct = fill < 0.005 ? 0 : Math.round(fill * 100);

  // Colour shifts amber when buffer is nearly full — a warning cue
  const arcColor  = fill > 0.88 ? '#f59e0b' : fill > 0.65 ? '#3b82f6' : '#2563eb';
  const glowColor = fill > 0.88 ? '#f59e0b55' : '#3b82f650';
  const evicting  = isStreaming && cacheMax > 0 && cacheSize >= cacheMax;

  const TICK_COUNT = 24;

  return (
    <div className="ring-buf-widget">
      <div className="ring-buf-header">
        <span className="ring-buf-title">Display Cache</span>
        {isStreaming && (
          <span className={`ring-buf-badge ${evicting ? 'ring-buf-badge--evict' : 'ring-buf-badge--live'}`}>
            {evicting ? 'EVICTING' : 'LIVE'}
          </span>
        )}
      </div>

      <div className="ring-buf-body">
        <svg width="88" height="88" viewBox="0 0 88 88" className="ring-buf-svg">
          {/* Gauge tick marks */}
          {Array.from({ length: TICK_COUNT }, (_, i) => {
            const angleDeg = (i / TICK_COUNT) * 360 - 90;
            const rad = (angleDeg * Math.PI) / 180;
            const isFilled = i / TICK_COUNT < fill;
            const inner = R + TRACK_W / 2 + 3;
            const outer = inner + (i % 6 === 0 ? 5 : 3);
            return (
              <line
                key={i}
                x1={CX + inner * Math.cos(rad)} y1={CY + inner * Math.sin(rad)}
                x2={CX + outer * Math.cos(rad)} y2={CY + outer * Math.sin(rad)}
                stroke={isFilled ? arcColor : '#1c2640'}
                strokeWidth={i % 6 === 0 ? 2 : 1}
                strokeLinecap="round"
                style={{ opacity: isFilled ? 0.9 : 0.5 }}
              />
            );
          })}

          {/* Track */}
          <circle cx={CX} cy={CY} r={R} fill="none" stroke="#0f1729" strokeWidth={TRACK_W} />

          {/* Fill arc with glow */}
          <circle
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke={arcColor}
            strokeWidth={TRACK_W}
            strokeDasharray={circumference}
            strokeDashoffset={fill > 0 ? dashOffset : circumference}
            strokeLinecap="round"
            transform={`rotate(-90 ${CX} ${CY})`}
            className="ring-fill-arc"
            style={{ filter: `drop-shadow(0 0 6px ${glowColor})` }}
          />

          {/* Orbiting flow particles — 3 staggered, only while streaming */}
          {isStreaming && [0, 0.73, 1.47].map((delay, i) => (
            <g
              key={i}
              className="ring-orbit-group"
              style={{ animationDelay: `${delay}s`, opacity: 1 - i * 0.25 }}
            >
              <circle cx={CX + R} cy={CY} r={i === 0 ? 3 : 2} fill="#93c5fd" />
            </g>
          ))}

          {/* Inner dark backing */}
          <circle cx={CX} cy={CY} r={R - TRACK_W / 2 - 1} fill="#080c14" />

          {/* Centre readout */}
          <text x={CX} y={CY - 4} textAnchor="middle" className="ring-pct-text">
            {cacheMax === 0 ? '∞' : `${pct}%`}
          </text>
          <text x={CX} y={CY + 9} textAnchor="middle" className="ring-sub-text">
            full
          </text>
        </svg>

        <div className="ring-buf-stats">
          <div className="ring-stat-row">
            <span className="ring-stat-key">cached</span>
            <span className="ring-stat-val">{cacheSize.toLocaleString()}</span>
          </div>
          <div className="ring-stat-row">
            <span className="ring-stat-key">cap</span>
            <span className="ring-stat-val">
              {cacheMax > 0 ? cacheMax.toLocaleString() : '∞'}
            </span>
          </div>
          {evicting && (
            <div className="ring-evict-note">oldest lines dropping</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── McpStatusWidget ──────────────────────────────────────────────────────────

// How recently the MCP client must have queried to be considered "connected".
const MCP_ACTIVE_THRESHOLD_SECS = 30;

type McpConnState = 'checking' | 'offline' | 'ready' | 'connected';

function mcpConnState(status: McpStatus | null): McpConnState {
  if (status === null) return 'checking';
  if (!status.running) return 'offline';
  if (status.idleSecs === null) return 'ready';          // bound but never queried
  if (status.idleSecs <= MCP_ACTIVE_THRESHOLD_SECS) return 'connected';
  return 'ready';                                         // bound, queried before, now idle
}

const MCP_CONN_LABELS: Record<McpConnState, string> = {
  checking:  '…',
  offline:   'offline',
  ready:     'ready',
  connected: 'connected',
};

function McpStatusWidget() {
  const [status, setStatus] = useState<McpStatus | null>(null);

  useEffect(() => {
    const check = () =>
      getMcpStatus()
        .then(setStatus)
        .catch(() => setStatus({ running: false, port: 40404, idleSecs: null }));

    check();
    const id = setInterval(check, 5_000);
    return () => clearInterval(id);
  }, []);

  const connState = mcpConnState(status);
  const running   = connState !== 'offline' && connState !== 'checking';
  const active    = connState === 'connected';

  return (
    <div className="mcp-widget">
      <div className="mcp-widget-header">
        <span className="mcp-widget-title">MCP Bridge</span>
        <span className={`mcp-pill mcp-pill--${connState}`}>
          {MCP_CONN_LABELS[connState]}
        </span>
      </div>

      {/* Connection line with animated data packets */}
      <div className="mcp-conn-row">
        <div className={`mcp-conn-node ${running ? 'mcp-conn-node--on' : ''}`}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="3" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M4 3V2M7 3V1.5M10 3V2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </div>
        <div className="mcp-conn-line">
          {active && (
            <>
              <div className="mcp-packet" style={{ animationDelay: '0s' }} />
              <div className="mcp-packet" style={{ animationDelay: '1.1s' }} />
              <div className="mcp-packet" style={{ animationDelay: '2.2s' }} />
            </>
          )}
        </div>
        <div className="mcp-conn-addr">
          {status?.running ? `127.0.0.1:${status.port}` : 'not bound'}
        </div>
      </div>

      {/* What the bridge exposes */}
      <div className="mcp-reads-row">
        <span className="mcp-reads-label">reads</span>
        <div className="mcp-reads-caps">
          <span className="mcp-cap">Sessions</span>
          <span className="mcp-cap-sep">·</span>
          <span className="mcp-cap">Pipeline</span>
          <span className="mcp-cap-sep">·</span>
          <span className="mcp-cap">Events</span>
        </div>
      </div>
    </div>
  );
}

// Type → [label, CSS class]
const PROC_TYPE_META: Record<string, [string, string]> = {
  transformer:   ['Transformer',  'proc-type-transformer'],
  reporter:      ['Reporter',     'proc-type-reporter'],
  state_tracker: ['StateTracker', 'proc-type-tracker'],
  correlator:    ['Correlator',   'proc-type-correlator'],
  annotator:     ['Annotator',    'proc-type-annotator'],
};

// Accent color per type (for left border of chain nodes)
const PROC_TYPE_ACCENT: Record<string, string> = {
  transformer:   '#2dd4bf',
  reporter:      '#58a6ff',
  state_tracker: '#60a5fa',
  correlator:    '#c084fc',
  annotator:     '#fb923c',
};

// ── ChainConnector ──────────────────────────────────────────────────────────

function ChainConnector({ isActive }: { isActive: boolean }) {
  return (
    <div className={`chain-connector${isActive ? ' chain-connector--active' : ''}`}>
      <div className="chain-dot" />
      <div className="chain-dot" />
      <div className="chain-dot" />
    </div>
  );
}

// ── StatLine ─────────────────────────────────────────────────────────────────

function StatLine({
  processorType,
  result,
  progress,
  running,
}: {
  processorType: string;
  result?: PipelineRunSummary;
  progress?: PipelineProgress;
  running: boolean;
}) {
  if (running && progress) {
    return (
      <div className="chain-node-stat">
        <div className="chain-node-progress">
          <div className="chain-node-progress-fill" style={{ width: `${progress.percent.toFixed(0)}%` }} />
          <div className="proc-progress-shimmer" />
        </div>
      </div>
    );
  }
  if (!result) return null;

  if (processorType === 'state_tracker') {
    return (
      <div className="chain-node-stat">
        {result.matchedLines.toLocaleString()} transitions
      </div>
    );
  }
  if (processorType === 'transformer') {
    return (
      <div className="chain-node-stat">
        {result.matchedLines.toLocaleString()} lines passed
      </div>
    );
  }
  return (
    <div className="chain-node-stat">
      {result.matchedLines.toLocaleString()} matched
      {result.emissionCount > 0 && ` · ${result.emissionCount.toLocaleString()} emitted`}
    </div>
  );
}

// ── ChainNode ────────────────────────────────────────────────────────────────

interface ChainNodeProps {
  id: string;
  name: string;
  processorType: string;
  builtin: boolean;
  result?: PipelineRunSummary;
  progress?: PipelineProgress;
  running: boolean;
  onRemove: (id: string) => void;
}

function ChainNode({
  id,
  name,
  processorType,
  builtin,
  result,
  progress,
  running,
  onRemove,
}: ChainNodeProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    '--proc-accent': PROC_TYPE_ACCENT[processorType] ?? '#58a6ff',
  } as React.CSSProperties;

  const [typeLabel, typeBadgeClass] = PROC_TYPE_META[processorType] ?? ['Unknown', ''];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`chain-node${isDragging ? ' chain-node--dragging' : ''}`}
    >
      {/* Drag handle */}
      <div className="chain-node-handle" {...attributes} {...listeners} title="Drag to reorder">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
          <circle cx="3" cy="2.5" r="1.2" fill="currentColor"/>
          <circle cx="7" cy="2.5" r="1.2" fill="currentColor"/>
          <circle cx="3" cy="7" r="1.2" fill="currentColor"/>
          <circle cx="7" cy="7" r="1.2" fill="currentColor"/>
          <circle cx="3" cy="11.5" r="1.2" fill="currentColor"/>
          <circle cx="7" cy="11.5" r="1.2" fill="currentColor"/>
        </svg>
      </div>

      {/* Accent bar */}
      <div className="chain-node-accent" />

      {/* Body */}
      <div className="chain-node-body">
        <div className="chain-node-name">{name}</div>
        <div className="chain-node-meta">
          <span className={`proc-type-badge ${typeBadgeClass}`}>{typeLabel}</span>
          {builtin && <span className="proc-item-builtin-badge">built-in</span>}
        </div>
        <StatLine
          processorType={processorType}
          result={result}
          progress={progress}
          running={running}
        />
      </div>

      {/* Remove button */}
      <button
        className="chain-node-remove"
        title="Remove from chain"
        onClick={() => onRemove(id)}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}

// ── PinnedChainNode ───────────────────────────────────────────────────────────
// Non-draggable node for processors locked to the end of the chain (e.g. PII anonymizer).

function PinnedChainNode({
  id,
  name,
  processorType,
  builtin,
  result,
  progress,
  running,
  onRemove,
}: ChainNodeProps) {
  const style: React.CSSProperties = {
    '--proc-accent': PROC_TYPE_ACCENT[processorType] ?? '#58a6ff',
  } as React.CSSProperties;

  const [typeLabel, typeBadgeClass] = PROC_TYPE_META[processorType] ?? ['Unknown', ''];

  return (
    <>
      {/* Output-gate separator */}
      <div className="chain-output-gate-sep">
        <span className="chain-output-gate-label">output gate</span>
      </div>

      <div style={style} className="chain-node chain-node--pinned">
        {/* Lock icon — not interactive */}
        <div className="chain-node-handle chain-node-handle--locked" title="Pinned to end — always processes output last">
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
            <rect x="2" y="5.5" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M3 5.5V3.5a2 2 0 014 0v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Accent bar */}
        <div className="chain-node-accent" />

        {/* Body */}
        <div className="chain-node-body">
          <div className="chain-node-name">{name}</div>
          <div className="chain-node-meta">
            <span className={`proc-type-badge ${typeBadgeClass}`}>{typeLabel}</span>
            {builtin && <span className="proc-item-builtin-badge">built-in</span>}
          </div>
          <StatLine
            processorType={processorType}
            result={result}
            progress={progress}
            running={running}
          />
        </div>

        {/* Remove button */}
        <button
          className="chain-node-remove"
          title="Remove from chain"
          onClick={() => onRemove(id)}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </>
  );
}

// ── ProcessorPanel ───────────────────────────────────────────────────────────

export default function ProcessorPanel({ pipeline, sessionId, isStreaming, onOpenLibrary, cacheSize, cacheMax }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    pipeline.loadProcessors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      // Reorder within the full pipelineChain using the full-chain indices.
      // Pinned-tail items are excluded from the sortable context so they
      // can never appear as active or over here.
      const fromIndex = pipeline.pipelineChain.indexOf(String(active.id));
      const toIndex = pipeline.pipelineChain.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) return;
      pipeline.reorderChain(fromIndex, toIndex);
    },
    [pipeline],
  );

  async function handleRun() {
    if (!sessionId) return;
    await pipeline.run(sessionId);
  }

  // Build a lookup from processorId → result
  const resultMap = new Map<string, PipelineRunSummary>(
    pipeline.lastResults.map((r) => [r.processorId, r]),
  );

  const PINNED_TAIL_IDS = new Set(['__pii_anonymizer']);

  const allChainProcessors = pipeline.pipelineChain
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter(Boolean) as NonNullable<(typeof pipeline.processors)[0]>[];

  // Split into freely-sortable processors and pinned-tail processors.
  const sortableProcessors = allChainProcessors.filter((p) => !PINNED_TAIL_IDS.has(p.id));
  const pinnedProcessors   = allChainProcessors.filter((p) =>  PINNED_TAIL_IDS.has(p.id));
  const sortableIds        = sortableProcessors.map((p) => p.id);

  const isActive = pipeline.running || isStreaming;
  const canRun = pipeline.pipelineChain.length > 0 && !!sessionId && !pipeline.running;

  return (
    <div className="processor-panel">
      {/* ── Header ── */}
      <div className="proc-panel-header">
        <div className="proc-panel-title-group">
          <span className="proc-panel-title">Pipeline</span>
          {pipeline.pipelineChain.length > 0 && (
            <span className="proc-panel-count">{pipeline.pipelineChain.length}</span>
          )}
        </div>
        <button
          className="proc-action-btn"
          title="Add processor"
          onClick={onOpenLibrary}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* ── Pipeline chain ── */}
      <div className="pipeline-chain">
        {/* Source node */}
        <div className="pipeline-node-source">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M3 1.5l7 4.5-7 4.5V1.5z" fill="currentColor"/>
          </svg>
          LOG STREAM IN
        </div>

        {/* Chain items or empty hint */}
        {allChainProcessors.length === 0 ? (
          <div className="pipeline-chain-empty">
            <ChainConnector isActive={false} />
            <div className="pipeline-empty-hint">
              Add processors with{' '}
              <button className="pipeline-empty-hint-btn" onClick={onOpenLibrary}>+</button>
            </div>
            <ChainConnector isActive={false} />
          </div>
        ) : (
          <>
            {/* Freely sortable processors */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                {sortableProcessors.map((proc) => (
                  <Fragment key={proc.id}>
                    <ChainConnector isActive={isActive} />
                    <ChainNode
                      id={proc.id}
                      name={proc.name}
                      processorType={proc.processorType}
                      builtin={proc.builtin}
                      result={resultMap.get(proc.id)}
                      progress={pipeline.progress[proc.id]}
                      running={pipeline.running}
                      onRemove={pipeline.removeFromChain}
                    />
                  </Fragment>
                ))}
              </SortableContext>
            </DndContext>

            {/* Pinned-tail processors (e.g. PII Anonymizer) — always last, not draggable */}
            {pinnedProcessors.map((proc) => (
              <Fragment key={proc.id}>
                <ChainConnector isActive={isActive} />
                <PinnedChainNode
                  id={proc.id}
                  name={proc.name}
                  processorType={proc.processorType}
                  builtin={proc.builtin}
                  result={resultMap.get(proc.id)}
                  progress={pipeline.progress[proc.id]}
                  running={pipeline.running}
                  onRemove={pipeline.removeFromChain}
                />
              </Fragment>
            ))}
          </>
        )}

        {/* Last connector before sink */}
        {allChainProcessors.length > 0 && <ChainConnector isActive={isActive} />}

        {/* Sink node */}
        <div className="pipeline-node-sink">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M9 1.5l-7 4.5 7 4.5V1.5z" fill="currentColor"/>
          </svg>
          LOG STREAM OUT
        </div>

        {/* Post-pipeline visualizations */}
        <div className="pipeline-post-chain">
          {isStreaming && (
            <RingBufferWidget cacheSize={cacheSize} cacheMax={cacheMax} isStreaming={isStreaming} />
          )}
          <div className="pipeline-post-divider" />
          <McpStatusWidget />
        </div>
      </div>

      {/* ── Run row ── */}
      {isStreaming ? (
        <div className="proc-run-row proc-run-row--streaming">
          <span className="proc-streaming-indicator">
            <span className="stream-dot" />
            Pipeline running live
          </span>
        </div>
      ) : (
        <div className="proc-run-row">
          <button
            className={`proc-run-btn${canRun ? ' proc-run-btn--ready' : ''}${pipeline.running ? ' proc-run-btn--running' : ''}`}
            onClick={handleRun}
            disabled={!canRun}
            title={
              !sessionId ? 'Load a log file first' :
              pipeline.pipelineChain.length === 0 ? 'Add processors to the chain first' :
              'Run pipeline on loaded log'
            }
          >
            {pipeline.running ? (
              <>
                <span className="proc-run-spinner" />
                Running…
              </>
            ) : (
              <>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M3 1.5l7 4.5-7 4.5V1.5z" fill="currentColor"/>
                </svg>
                Run Pipeline
              </>
            )}
          </button>
          {pipeline.running && (
            <button className="btn-secondary" onClick={pipeline.stop}>
              Stop
            </button>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {pipeline.error && (
        <div className="proc-error">{pipeline.error}</div>
      )}
    </div>
  );
}
