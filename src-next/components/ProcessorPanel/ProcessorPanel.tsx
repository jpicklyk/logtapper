import React, { Fragment, useEffect, useCallback, useState, useMemo } from 'react';
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
import type { PipelineRunSummary, PipelineProgress, McpStatus } from '../../bridge/types';
import { getMcpStatus } from '../../bridge/commands';
import {
  useSession,
  useIsStreaming,
  useProcessors,
  usePipelineChain,
  usePipelineRunning,
  usePipelineResults,
  usePipelineProgress,
  usePipelineError,
} from '../../context';
import { usePipeline } from '../../hooks';
import { ProcessorLibrary } from '../ProcessorLibrary';
import { bus } from '../../events';
import styles from './ProcessorPanel.module.css';

// ── McpStatusWidget ──────────────────────────────────────────────────────────

const MCP_ACTIVE_THRESHOLD_SECS = 30;
type McpConnState = 'checking' | 'offline' | 'ready' | 'connected';

function mcpConnState(status: McpStatus | null): McpConnState {
  if (status === null) return 'checking';
  if (!status.running) return 'offline';
  if (status.idleSecs === null) return 'ready';
  if (status.idleSecs <= MCP_ACTIVE_THRESHOLD_SECS) return 'connected';
  return 'ready';
}

const MCP_CONN_LABELS: Record<McpConnState, string> = {
  checking: '...',
  offline: 'offline',
  ready: 'ready',
  connected: 'connected',
};

const McpStatusWidget = React.memo(function McpStatusWidget() {
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
  const running = connState !== 'offline' && connState !== 'checking';
  const active = connState === 'connected';

  return (
    <div className={styles.mcpWidget}>
      <div className={styles.mcpHeader}>
        <span className={styles.mcpTitle}>MCP Bridge</span>
        <span className={`${styles.mcpPill} ${styles[`mcpPill_${connState}`]}`}>
          {MCP_CONN_LABELS[connState]}
        </span>
      </div>
      <div className={styles.mcpConnRow}>
        <div className={`${styles.mcpNode} ${running ? styles.mcpNodeOn : ''}`}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="3" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4 3V2M7 3V1.5M10 3V2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
        <div className={styles.mcpLine}>
          {active && (
            <>
              <div className={styles.mcpPacket} style={{ animationDelay: '0s' }} />
              <div className={styles.mcpPacket} style={{ animationDelay: '1.1s' }} />
              <div className={styles.mcpPacket} style={{ animationDelay: '2.2s' }} />
            </>
          )}
        </div>
        <div className={styles.mcpAddr}>
          {status?.running ? `127.0.0.1:${status.port}` : 'not bound'}
        </div>
      </div>
      <div className={styles.mcpReadsRow}>
        <span className={styles.mcpReadsLabel}>reads</span>
        <div className={styles.mcpReadsCaps}>
          <span className={styles.mcpCap}>Sessions</span>
          <span className={styles.mcpCapSep}>.</span>
          <span className={styles.mcpCap}>Pipeline</span>
          <span className={styles.mcpCapSep}>.</span>
          <span className={styles.mcpCap}>Events</span>
        </div>
      </div>
    </div>
  );
});

// ── Type metadata ────────────────────────────────────────────────────────────

const PROC_TYPE_META: Record<string, [string, string]> = {
  reporter: ['Reporter', styles.typeReporter],
  state_tracker: ['StateTracker', styles.typeTracker],
  correlator: ['Correlator', styles.typeCorrelator],
  annotator: ['Annotator', styles.typeAnnotator],
};

// PII anonymizer is the only transformer — show a dedicated badge instead
// of the generic "Transformer" label.
const PII_TYPE_META: [string, string] = ['PII', styles.typeTransformer];

const PROC_TYPE_ACCENT: Record<string, string> = {
  transformer: '#2dd4bf',
  reporter: '#58a6ff',
  state_tracker: '#60a5fa',
  correlator: '#c084fc',
  annotator: '#fb923c',
};

const PINNED_TAIL_IDS = new Set(['__pii_anonymizer']);

// ── ChainConnector ───────────────────────────────────────────────────────────

function ChainConnector({ isActive }: { isActive: boolean }) {
  return (
    <div className={`${styles.connector}${isActive ? ` ${styles.connectorActive}` : ''}`}>
      <div className={styles.connectorDot} />
      <div className={styles.connectorDot} />
      <div className={styles.connectorDot} />
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
      <div className={styles.nodeStat}>
        <div className={styles.nodeProgress}>
          <div className={styles.nodeProgressFill} style={{ width: `${progress.percent.toFixed(0)}%` }} />
          <div className={styles.progressShimmer} />
        </div>
      </div>
    );
  }
  if (!result) return null;

  if (processorType === 'state_tracker') {
    return <div className={styles.nodeStat}>{result.matchedLines.toLocaleString()} transitions</div>;
  }
  if (processorType === 'transformer') {
    return <div className={styles.nodeStat}>PII anonymization active</div>;
  }
  return (
    <div className={styles.nodeStat}>
      {result.matchedLines.toLocaleString()} matched
      {result.emissionCount > 0 && ` . ${result.emissionCount.toLocaleString()} emitted`}
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

  const [typeLabel, typeBadgeClass] = (PINNED_TAIL_IDS.has(id) ? PII_TYPE_META : null)
    ?? PROC_TYPE_META[processorType] ?? ['Unknown', ''];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.chainNode}${isDragging ? ` ${styles.chainNodeDragging}` : ''}`}
    >
      <div className={styles.nodeHandle} {...attributes} {...listeners} title="Drag to reorder">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
          <circle cx="3" cy="2.5" r="1.2" fill="currentColor" />
          <circle cx="7" cy="2.5" r="1.2" fill="currentColor" />
          <circle cx="3" cy="7" r="1.2" fill="currentColor" />
          <circle cx="7" cy="7" r="1.2" fill="currentColor" />
          <circle cx="3" cy="11.5" r="1.2" fill="currentColor" />
          <circle cx="7" cy="11.5" r="1.2" fill="currentColor" />
        </svg>
      </div>
      <div className={styles.nodeAccent} />
      <div className={styles.nodeBody}>
        <div className={styles.nodeName}>{name}</div>
        <div className={styles.nodeMeta}>
          <span className={`${styles.typeBadge} ${typeBadgeClass}`}>{typeLabel}</span>
          {builtin && <span className={styles.builtinBadge}>built-in</span>}
        </div>
        <StatLine processorType={processorType} result={result} progress={progress} running={running} />
      </div>
      <button className={styles.nodeRemove} title="Remove from chain" onClick={() => onRemove(id)}>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// ── PinnedChainNode ──────────────────────────────────────────────────────────

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

  const [typeLabel, typeBadgeClass] = (PINNED_TAIL_IDS.has(id) ? PII_TYPE_META : null)
    ?? PROC_TYPE_META[processorType] ?? ['Unknown', ''];

  return (
    <>
      <div className={styles.outputGateSep}>
        <span className={styles.outputGateLabel}>output gate</span>
      </div>
      <div style={style} className={`${styles.chainNode} ${styles.chainNodePinned}`}>
        <div className={`${styles.nodeHandle} ${styles.nodeHandleLocked}`} title="Pinned to end">
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
            <rect x="2" y="5.5" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3 5.5V3.5a2 2 0 014 0v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
        <div className={styles.nodeAccent} />
        <div className={styles.nodeBody}>
          <div className={styles.nodeName}>{name}</div>
          <div className={styles.nodeMeta}>
            <span className={`${styles.typeBadge} ${typeBadgeClass}`}>{typeLabel}</span>
            {builtin && <span className={styles.builtinBadge}>built-in</span>}
          </div>
          <StatLine processorType={processorType} result={result} progress={progress} running={running} />
        </div>
        <button className={styles.nodeRemove} title="Remove from chain" onClick={() => onRemove(id)}>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </>
  );
}

// ── ProcessorPanel ───────────────────────────────────────────────────────────

const ProcessorPanel = React.memo(function ProcessorPanel() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();
  const running = usePipelineRunning();
  const { results: lastResults } = usePipelineResults();
  const progress = usePipelineProgress();
  const pipelineError = usePipelineError();
  const pipeline = usePipeline();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    pipeline.loadProcessors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = pipelineChain.indexOf(String(active.id));
      const toIndex = pipelineChain.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) return;
      pipeline.reorderChain(fromIndex, toIndex);
    },
    [pipelineChain, pipeline],
  );

  const handleRun = useCallback(async () => {
    const sessionId = session?.sessionId;
    if (!sessionId) return;
    await pipeline.run(sessionId);
  }, [session, pipeline]);

  const [libraryOpen, setLibraryOpen] = useState(false);

  useEffect(() => {
    const handler = () => setLibraryOpen(true);
    bus.on('pipeline:library-open', handler);
    return () => { bus.off('pipeline:library-open', handler); };
  }, []);

  const handleOpenLibrary = useCallback(() => {
    setLibraryOpen(true);
  }, []);

  const handleCloseLibrary = useCallback(() => {
    setLibraryOpen(false);
  }, []);

  const resultMap = useMemo(
    () =>
      new Map<string, PipelineRunSummary>(
        (lastResults as PipelineRunSummary[]).map((r) => [r.processorId, r]),
      ),
    [lastResults],
  );

  const allChainProcessors = useMemo(
    () =>
      pipelineChain
        .map((id) => processors.find((p) => p.id === id))
        .filter(Boolean) as NonNullable<(typeof processors)[0]>[],
    [pipelineChain, processors],
  );

  const sortableProcessors = useMemo(
    () => allChainProcessors.filter((p) => !PINNED_TAIL_IDS.has(p.id)),
    [allChainProcessors],
  );
  const pinnedProcessors = useMemo(
    () => allChainProcessors.filter((p) => PINNED_TAIL_IDS.has(p.id)),
    [allChainProcessors],
  );
  const sortableIds = useMemo(
    () => sortableProcessors.map((p) => p.id),
    [sortableProcessors],
  );

  const isActive = running || isStreaming;
  const sessionId = session?.sessionId ?? null;
  const canRun = pipelineChain.length > 0 && !!sessionId && !running;

  // Progress map from context
  const progressMap = useMemo(() => {
    if (!progress) return {};
    // The progress object from context is a simple { current, total }
    // Map it to per-processor PipelineProgress for StatLine
    const map: Record<string, PipelineProgress> = {};
    for (const id of pipelineChain) {
      map[id] = {
        sessionId: sessionId ?? '',
        processorId: id,
        linesProcessed: progress.current,
        totalLines: progress.total,
        percent: progress.total > 0 ? (progress.current / progress.total) * 100 : 0,
      };
    }
    return map;
  }, [progress, pipelineChain]);

  return (
    <div className={styles.root}>
      {/* Header */}
      <div className={styles.panelHeader}>
        <div className={styles.titleGroup}>
          <span className={styles.title}>Pipeline</span>
          {pipelineChain.length > 0 && (
            <span className={styles.count}>{pipelineChain.length}</span>
          )}
        </div>
        <button className={styles.actionBtn} title="Add processor" onClick={handleOpenLibrary}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Pipeline chain */}
      <div className={styles.chain}>
        <div className={styles.sourceNode}>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M3 1.5l7 4.5-7 4.5V1.5z" fill="currentColor" />
          </svg>
          LOG STREAM IN
        </div>

        {allChainProcessors.length === 0 ? (
          <div className={styles.chainEmpty}>
            <ChainConnector isActive={false} />
            <div className={styles.emptyHint}>
              Add processors with{' '}
              <button className={styles.emptyHintBtn} onClick={handleOpenLibrary}>
                +
              </button>
            </div>
            <ChainConnector isActive={false} />
          </div>
        ) : (
          <>
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
                      progress={progressMap[proc.id]}
                      running={running}
                      onRemove={pipeline.removeFromChain}
                    />
                  </Fragment>
                ))}
              </SortableContext>
            </DndContext>
            {pinnedProcessors.map((proc) => (
              <Fragment key={proc.id}>
                <ChainConnector isActive={isActive} />
                <PinnedChainNode
                  id={proc.id}
                  name={proc.name}
                  processorType={proc.processorType}
                  builtin={proc.builtin}
                  result={resultMap.get(proc.id)}
                  progress={progressMap[proc.id]}
                  running={running}
                  onRemove={pipeline.removeFromChain}
                />
              </Fragment>
            ))}
          </>
        )}

        {allChainProcessors.length > 0 && <ChainConnector isActive={isActive} />}

        <div className={styles.sinkNode}>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M9 1.5l-7 4.5 7 4.5V1.5z" fill="currentColor" />
          </svg>
          LOG STREAM OUT
        </div>

        <div className={styles.postChain}>
          <McpStatusWidget />
        </div>
      </div>

      {/* Run row */}
      {isStreaming ? (
        <div className={`${styles.runRow} ${styles.runRowStreaming}`}>
          <span className={styles.streamingIndicator}>
            <span className={styles.streamDot} />
            Pipeline running live
          </span>
        </div>
      ) : (
        <div className={styles.runRow}>
          <button
            className={`${styles.runBtn}${canRun ? ` ${styles.runBtnReady}` : ''}${running ? ` ${styles.runBtnRunning}` : ''}`}
            onClick={handleRun}
            disabled={!canRun}
            title={
              !sessionId
                ? 'Load a log file first'
                : pipelineChain.length === 0
                  ? 'Add processors to the chain first'
                  : 'Run pipeline on loaded log'
            }
          >
            {running ? (
              <>
                <span className={styles.runSpinner} />
                Running...
              </>
            ) : (
              <>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M3 1.5l7 4.5-7 4.5V1.5z" fill="currentColor" />
                </svg>
                Run Pipeline
              </>
            )}
          </button>
          {running && sessionId && (
            <button className={styles.stopBtn} onClick={() => pipeline.stop(sessionId)}>
              Stop
            </button>
          )}
        </div>
      )}

      {/* Error */}
      {pipelineError && (
        <div className={styles.error}>{pipelineError}</div>
      )}

      {libraryOpen && <ProcessorLibrary onClose={handleCloseLibrary} />}
    </div>
  );
});

export default ProcessorPanel;
