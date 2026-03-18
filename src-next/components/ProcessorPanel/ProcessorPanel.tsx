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
  useDisabledChainIds,
  usePipelineRunning,
  usePipelineResults,
  usePipelineProgress,
  usePipelineError,
} from '../../context';
import { usePipeline } from '../../hooks';
import { ProcessorLibrary } from '../ProcessorLibrary';
import { bus } from '../../events';
import styles from './ProcessorPanel.module.css';
import badgeCss from '../../ui/processorBadge.module.css';
import { PROC_TYPE_LABELS, PROC_TYPE_CLASS_KEY } from '../../ui/processorBadgeTypes';

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

function getProcTypeMeta(type: string): [string, string] {
  const label = PROC_TYPE_LABELS[type] ?? type;
  const cls = badgeCss[PROC_TYPE_CLASS_KEY[type] as keyof typeof badgeCss] ?? '';
  return [label, cls];
}

// PII anonymizer is the only transformer — show a dedicated badge instead
// of the generic "Transformer" label.
const PII_TYPE_META: [string, string] = [
  'PII',
  badgeCss[PROC_TYPE_CLASS_KEY['transformer'] as keyof typeof badgeCss] ?? '',
];

const PROC_TYPE_ACCENT: Record<string, string> = {
  transformer: '#2dd4bf',
  reporter: '#58a6ff',
  state_tracker: '#60a5fa',
  correlator: '#c084fc',
  annotator: '#fb923c',
};

const PINNED_TAIL_IDS = new Set(['__pii_anonymizer']);

const LS_COMPACT_KEY = 'logtapper_pipeline_compact';

// ── SVG Icons ────────────────────────────────────────────────────────────────

const DragHandleSvg = (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
    <circle cx="3" cy="2.5" r="1.2" fill="currentColor" />
    <circle cx="7" cy="2.5" r="1.2" fill="currentColor" />
    <circle cx="3" cy="7" r="1.2" fill="currentColor" />
    <circle cx="7" cy="7" r="1.2" fill="currentColor" />
    <circle cx="3" cy="11.5" r="1.2" fill="currentColor" />
    <circle cx="7" cy="11.5" r="1.2" fill="currentColor" />
  </svg>
);

const LockSvg = (
  <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
    <rect x="2" y="5.5" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3 5.5V3.5a2 2 0 014 0v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const RemoveSvg = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
    <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Eye icon (enabled)
const EyeSvg = (
  <svg width="12" height="10" viewBox="0 0 16 12" fill="none">
    <path d="M1 6s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

// Eye-off icon (disabled)
const EyeOffSvg = (
  <svg width="12" height="10" viewBox="0 0 16 12" fill="none">
    <path d="M1 6s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 1l10 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

// ── ChainConnector ───────────────────────────────────────────────────────────

const ChainConnector = React.memo(function ChainConnector({
  isActive,
  compact,
}: {
  isActive: boolean;
  compact: boolean;
}) {
  const cls = `${styles.connector}${isActive ? ` ${styles.connectorActive}` : ''}${compact ? ` ${styles.connectorCompact}` : ''}`;
  return (
    <div className={cls}>
      <div className={styles.connectorDot} />
      <div className={styles.connectorDot} />
      <div className={styles.connectorDot} />
    </div>
  );
});

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

/** Format a compact stat string from a result. */
function compactStatText(result?: PipelineRunSummary): string {
  if (!result) return '';
  return result.matchedLines.toLocaleString();
}

// ── Toggle button ────────────────────────────────────────────────────────────

function ToggleEnabledBtn({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`${styles.toggleBtn}${disabled ? ` ${styles.toggleBtnOff}` : ''}`}
      title={disabled ? 'Enable processor' : 'Disable processor'}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {disabled ? EyeOffSvg : EyeSvg}
    </button>
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
  compact: boolean;
  disabled: boolean;
  onRemove: (id: string) => void;
  onToggleEnabled: (id: string) => void;
}

const ChainNode = React.memo(function ChainNode({
  id,
  name,
  processorType,
  builtin,
  result,
  progress,
  running,
  compact,
  disabled,
  onRemove,
  onToggleEnabled,
}: ChainNodeProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const accentColor = PROC_TYPE_ACCENT[processorType] ?? '#58a6ff';

  if (compact) {
    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.5 : 1,
      '--proc-accent': accentColor,
    } as React.CSSProperties;

    const cls = `${styles.chainNodeCompact}${isDragging ? ` ${styles.chainNodeDragging}` : ''}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

    return (
      <div ref={setNodeRef} style={style} className={cls} {...attributes} {...listeners}>
        <div className={styles.compactDot} />
        <span className={styles.compactName}>{name}</span>
        {result && <span className={styles.compactStat}>{compactStatText(result)}</span>}
        <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
        <button className={styles.nodeRemove} title="Remove from chain" onClick={(e) => { e.stopPropagation(); onRemove(id); }}>
          {RemoveSvg}
        </button>
      </div>
    );
  }

  // Detailed mode
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    '--proc-accent': accentColor,
  } as React.CSSProperties;

  const [typeLabel, typeBadgeClass] = (PINNED_TAIL_IDS.has(id) ? PII_TYPE_META : null)
    ?? getProcTypeMeta(processorType);

  const cls = `${styles.chainNode}${isDragging ? ` ${styles.chainNodeDragging}` : ''}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

  return (
    <div ref={setNodeRef} style={style} className={cls}>
      <div className={styles.nodeHandle} {...attributes} {...listeners} title="Drag to reorder">
        {DragHandleSvg}
      </div>
      <div className={styles.nodeAccent} />
      <div className={styles.nodeBody}>
        <div className={styles.nodeName}>{name}</div>
        <div className={styles.nodeMeta}>
          <span className={`${badgeCss.typeBadge} ${typeBadgeClass}`}>{typeLabel}</span>
          {builtin && <span className={styles.builtinBadge}>built-in</span>}
        </div>
        <StatLine processorType={processorType} result={result} progress={progress} running={running} />
      </div>
      <div className={styles.nodeActions}>
        <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
      </div>
      <button className={styles.nodeRemove} title="Remove from chain" onClick={() => onRemove(id)}>
        {RemoveSvg}
      </button>
    </div>
  );
});

// ── PinnedChainNode ──────────────────────────────────────────────────────────

const PinnedChainNode = React.memo(function PinnedChainNode({
  id,
  name,
  processorType,
  builtin,
  result,
  progress,
  running,
  compact,
  disabled,
  onRemove,
  onToggleEnabled,
}: ChainNodeProps) {
  const accentColor = PROC_TYPE_ACCENT[processorType] ?? '#58a6ff';

  if (compact) {
    const style: React.CSSProperties = {
      '--proc-accent': accentColor,
    } as React.CSSProperties;

    const cls = `${styles.chainNodeCompact} ${styles.chainNodePinned}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

    return (
      <div style={style} className={cls}>
        <span className={styles.compactLock}>{LockSvg}</span>
        <div className={styles.compactDot} />
        <span className={styles.compactName}>{name}</span>
        {result && <span className={styles.compactStat}>{compactStatText(result)}</span>}
        <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
        <button className={styles.nodeRemove} title="Remove from chain" onClick={(e) => { e.stopPropagation(); onRemove(id); }}>
          {RemoveSvg}
        </button>
      </div>
    );
  }

  // Detailed mode
  const style: React.CSSProperties = {
    '--proc-accent': accentColor,
  } as React.CSSProperties;

  const [typeLabel, typeBadgeClass] = (PINNED_TAIL_IDS.has(id) ? PII_TYPE_META : null)
    ?? getProcTypeMeta(processorType);

  const cls = `${styles.chainNode} ${styles.chainNodePinned}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

  return (
    <>
      <div className={styles.outputGateSep}>
        <span className={styles.outputGateLabel}>output gate</span>
      </div>
      <div style={style} className={cls}>
        <div className={`${styles.nodeHandle} ${styles.nodeHandleLocked}`} title="Pinned to end">
          {LockSvg}
        </div>
        <div className={styles.nodeAccent} />
        <div className={styles.nodeBody}>
          <div className={styles.nodeName}>{name}</div>
          <div className={styles.nodeMeta}>
            <span className={`${badgeCss.typeBadge} ${typeBadgeClass}`}>{typeLabel}</span>
            {builtin && <span className={styles.builtinBadge}>built-in</span>}
          </div>
          <StatLine processorType={processorType} result={result} progress={progress} running={running} />
        </div>
        <div className={styles.nodeActions}>
          <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
        </div>
        <button className={styles.nodeRemove} title="Remove from chain" onClick={() => onRemove(id)}>
          {RemoveSvg}
        </button>
      </div>
    </>
  );
});

// ── ProcessorPanel ───────────────────────────────────────────────────────────

const ProcessorPanel = React.memo(function ProcessorPanel() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();
  const disabledChainIds = useDisabledChainIds();
  const running = usePipelineRunning();
  const { results: lastResults } = usePipelineResults();
  const progress = usePipelineProgress();
  const pipelineError = usePipelineError();
  const pipeline = usePipeline();

  // ── Compact mode (persisted to localStorage) ──
  const [compact, setCompact] = useState(() => localStorage.getItem(LS_COMPACT_KEY) === '1');
  const handleToggleCompact = useCallback(() => {
    setCompact((prev) => {
      const next = !prev;
      localStorage.setItem(LS_COMPACT_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  // ── Chain filter (local ephemeral state) ──
  const [chainFilter, setChainFilter] = useState('');

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

  const disabledSet = useMemo(() => new Set(disabledChainIds), [disabledChainIds]);

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

  // ── Filtered lists for search ──
  const filteredSortable = useMemo(() => {
    if (!chainFilter) return sortableProcessors;
    const q = chainFilter.toLowerCase();
    return sortableProcessors.filter((p) => p.name.toLowerCase().includes(q));
  }, [sortableProcessors, chainFilter]);

  const filteredPinned = useMemo(() => {
    if (!chainFilter) return pinnedProcessors;
    const q = chainFilter.toLowerCase();
    return pinnedProcessors.filter((p) => p.name.toLowerCase().includes(q));
  }, [pinnedProcessors, chainFilter]);

  const filteredSortableIds = useMemo(
    () => filteredSortable.map((p) => p.id),
    [filteredSortable],
  );

  const filteredTotal = filteredSortable.length + filteredPinned.length;

  const isActive = running || isStreaming;
  const sessionId = session?.sessionId ?? null;
  const canRun = pipelineChain.length > 0 && !!sessionId && !running;

  // Progress map from context
  const progressMap = useMemo(() => {
    if (!progress) return {};
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
        <div className={styles.headerActions}>
          {/* Compact/detailed toggle */}
          <button
            className={styles.actionBtn}
            title={compact ? 'Detailed view' : 'Compact view'}
            onClick={handleToggleCompact}
          >
            {compact ? (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="2" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1" y="9" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <line x1="1" y1="3.5" x2="13" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="1" y1="10.5" x2="13" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          {/* Add processor */}
          <button className={styles.actionBtn} title="Add processor" onClick={handleOpenLibrary}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Chain filter — only show when chain has 4+ processors */}
      {allChainProcessors.length >= 4 && (
        <div className={styles.chainFilterRow}>
          <input
            className={styles.chainFilterInput}
            type="text"
            placeholder="Filter..."
            value={chainFilter}
            onChange={(e) => setChainFilter(e.target.value)}
          />
          {chainFilter && (
            <>
              <span className={styles.chainFilterCount}>
                {filteredTotal}/{allChainProcessors.length}
              </span>
              <button
                className={styles.chainFilterClear}
                title="Clear filter"
                onClick={() => setChainFilter('')}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                  <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </>
          )}
        </div>
      )}

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
            <ChainConnector isActive={false} compact={compact} />
            <div className={styles.emptyHint}>
              Add processors with{' '}
              <button className={styles.emptyHintBtn} onClick={handleOpenLibrary}>
                +
              </button>
            </div>
            <ChainConnector isActive={false} compact={compact} />
          </div>
        ) : chainFilter && filteredTotal === 0 ? (
          <div className={styles.chainFilterEmpty}>No matches</div>
        ) : (
          <>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={filteredSortableIds} strategy={verticalListSortingStrategy}>
                {filteredSortable.map((proc) => (
                  <Fragment key={proc.id}>
                    <ChainConnector isActive={isActive} compact={compact} />
                    <ChainNode
                      id={proc.id}
                      name={proc.name}
                      processorType={proc.processorType}
                      builtin={proc.builtin}
                      result={resultMap.get(proc.id)}
                      progress={progressMap[proc.id]}
                      running={running}
                      compact={compact}
                      disabled={disabledSet.has(proc.id)}
                      onRemove={pipeline.removeFromChain}
                      onToggleEnabled={pipeline.toggleChainEnabled}
                    />
                  </Fragment>
                ))}
              </SortableContext>
            </DndContext>
            {filteredPinned.map((proc) => (
              <Fragment key={proc.id}>
                <ChainConnector isActive={isActive} compact={compact} />
                <PinnedChainNode
                  id={proc.id}
                  name={proc.name}
                  processorType={proc.processorType}
                  builtin={proc.builtin}
                  result={resultMap.get(proc.id)}
                  progress={progressMap[proc.id]}
                  running={running}
                  compact={compact}
                  disabled={disabledSet.has(proc.id)}
                  onRemove={pipeline.removeFromChain}
                  onToggleEnabled={pipeline.toggleChainEnabled}
                />
              </Fragment>
            ))}
          </>
        )}

        {allChainProcessors.length > 0 && filteredTotal > 0 && (
          <ChainConnector isActive={isActive} compact={compact} />
        )}

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
