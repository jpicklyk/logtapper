import { Fragment, useEffect, useCallback } from 'react';
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
import type { PipelineRunSummary, PipelineProgress } from '../bridge/types';

interface Props {
  pipeline: PipelineState;
  sessionId: string | null;
  isStreaming: boolean;
  onOpenLibrary: () => void;
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
      {!builtin && (
        <button
          className="chain-node-remove"
          title="Remove from chain"
          onClick={() => onRemove(id)}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      )}
    </div>
  );
}

// ── ProcessorPanel ───────────────────────────────────────────────────────────

export default function ProcessorPanel({ pipeline, sessionId, isStreaming, onOpenLibrary }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    pipeline.loadProcessors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
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

  const chainProcessors = pipeline.pipelineChain
    .map((id) => pipeline.processors.find((p) => p.id === id))
    .filter(Boolean) as NonNullable<(typeof pipeline.processors)[0]>[];

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
        {chainProcessors.length === 0 ? (
          <div className="pipeline-chain-empty">
            <ChainConnector isActive={false} />
            <div className="pipeline-empty-hint">
              Add processors with{' '}
              <button className="pipeline-empty-hint-btn" onClick={onOpenLibrary}>+</button>
            </div>
            <ChainConnector isActive={false} />
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={pipeline.pipelineChain} strategy={verticalListSortingStrategy}>
              {chainProcessors.map((proc) => (
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
        )}

        {/* Last connector before sink */}
        {chainProcessors.length > 0 && <ChainConnector isActive={isActive} />}

        {/* Sink node */}
        <div className="pipeline-node-sink">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M9 1.5l-7 4.5 7 4.5V1.5z" fill="currentColor"/>
          </svg>
          LOG STREAM OUT
        </div>
      </div>

      {/* ── Run row ── */}
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

      {/* ── Error ── */}
      {pipeline.error && (
        <div className="proc-error">{pipeline.error}</div>
      )}
    </div>
  );
}
