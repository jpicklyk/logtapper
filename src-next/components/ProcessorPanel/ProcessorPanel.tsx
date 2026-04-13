import React, { Fragment, useEffect, useCallback, useState } from 'react';
import { Button } from '../../ui';
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
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import PackGroup from './PackGroup';
import packGroupStyles from './PackGroup.module.css';
import {
  useSession,
  useIsStreaming,
  useProcessors,
  usePacks,
  usePipelineChain,
  useDisabledChainIds,
  usePipelineActions,
  usePipelineGlobalError,
  useSessionPipelineResults,
  useSessionPipelineRunning,
  useSessionPipelineProgress,
  useSessionPipelineError,
} from '../../context';
import { usePipeline } from '../../hooks';
import { ProcessorLibrary } from '../ProcessorLibrary';
import { bus } from '../../events';
import { storageGet, storageSet } from '../../utils';
import styles from './ProcessorPanel.module.css';
import { ChainNode, PinnedChainNode, ChainConnector } from './ChainNode';
import { useChainGroups } from './useChainGroups';

const LS_COMPACT_KEY = 'logtapper_pipeline_compact';

// ── ProcessorPanel ───────────────────────────────────────────────────────────

const ProcessorPanel = React.memo(function ProcessorPanel() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();
  const disabledChainIds = useDisabledChainIds();
  const running = useSessionPipelineRunning();
  const { results: lastResults } = useSessionPipelineResults();
  const progress = useSessionPipelineProgress();
  const sessionError = useSessionPipelineError();
  const globalError = usePipelineGlobalError();
  // Per-session run errors take priority over global processor install/remove errors
  const pipelineError = sessionError ?? globalError;
  const pipeline = usePipeline();
  const { removeFromChain, reorderChain, toggleChainEnabled } = usePipelineActions();

  const isActive = running || isStreaming;
  const sessionId = session?.sessionId ?? null;
  const canRun = pipelineChain.length > 0 && !!sessionId && !running;

  // ── Compact mode (persisted to localStorage) ──
  const [compact, setCompact] = useState(() => storageGet(LS_COMPACT_KEY) === '1');
  const handleToggleCompact = useCallback(() => {
    setCompact((prev) => {
      const next = !prev;
      storageSet(LS_COMPACT_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const packs = usePacks();

  const {
    expandedPacks,
    handleTogglePackExpand,
    chainFilter,
    setChainFilter,
    disabledSet,
    resultMap,
    allChainProcessors,
    filteredPinned,
    filteredPackGroups,
    filteredStandalone,
    filteredStandaloneIds,
    filteredTotal,
    progressMap,
    handleTogglePackEnabled,
    handleRemovePack,
  } = useChainGroups({
    processors,
    pipelineChain,
    disabledChainIds,
    packs,
    lastResults,
    progress,
    sessionId,
    removeFromChain,
    toggleChainEnabled,
  });

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
      reorderChain(fromIndex, toIndex);
    },
    [pipelineChain, reorderChain],
  );

  const handleRun = useCallback(async () => {
    if (!sessionId) return;
    await pipeline.run(sessionId);
  }, [sessionId, pipeline]);

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
          <Button
            variant="ghost"
            size="sm"
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
          </Button>
          {/* Add processor */}
          <Button variant="ghost" size="sm" className={styles.actionBtn} title="Add processor" onClick={handleOpenLibrary}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </Button>
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
              <Button
                variant="ghost"
                size="sm"
                className={styles.chainFilterClear}
                title="Clear filter"
                onClick={() => setChainFilter('')}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                  <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </Button>
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
        ) : chainFilter && filteredPackGroups.length === 0 && filteredStandalone.length === 0 && filteredPinned.length === 0 ? (
          <div className={styles.chainFilterEmpty}>No matches</div>
        ) : (
          <>
            {/* Pack groups */}
            {filteredPackGroups.map((g) => {
              const packIds = g.processors.map((p) => p.id);
              const allEnabled = packIds.every((id) => !disabledSet.has(id));
              const someDisabled = !allEnabled && packIds.some((id) => disabledSet.has(id));
              return (
                <Fragment key={g.pack.id}>
                  <ChainConnector isActive={isActive} compact={compact} />
                  <PackGroup
                    packId={g.pack.id}
                    packName={g.pack.name}
                    processors={g.processors}
                    expanded={expandedPacks.has(g.pack.id)}
                    compact={compact}
                    onToggleExpand={handleTogglePackExpand}
                    allEnabled={allEnabled}
                    someDisabled={someDisabled}
                    onTogglePackEnabled={handleTogglePackEnabled}
                    onRemovePack={handleRemovePack}
                    onToggleProcessor={toggleChainEnabled}
                    onRemoveProcessor={removeFromChain}
                    disabledIds={disabledSet}
                    resultsByProcessor={resultMap}
                    pipelineRunning={running}
                  />
                </Fragment>
              );
            })}

            {/* Separator between packs and standalone processors */}
            {filteredPackGroups.length > 0 && filteredStandalone.length > 0 && (
              <div className={packGroupStyles.packStandaloneSep}>
                <div className={packGroupStyles.packStandaloneSepLine} />
                <span className={packGroupStyles.packStandaloneSepLabel}>standalone</span>
                <div className={packGroupStyles.packStandaloneSepLine} />
              </div>
            )}

            {/* Standalone processors (DnD-enabled) */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={filteredStandaloneIds} strategy={verticalListSortingStrategy}>
                {filteredStandalone.map((proc) => (
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
                      onRemove={removeFromChain}
                      onToggleEnabled={toggleChainEnabled}
                    />
                  </Fragment>
                ))}
              </SortableContext>
            </DndContext>

            {/* Pinned tail nodes */}
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
                  onRemove={removeFromChain}
                  onToggleEnabled={toggleChainEnabled}
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

        <div className={styles.postChain} />
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
            <Button variant="danger" size="sm" className={styles.stopBtn} onClick={() => pipeline.stop(sessionId)}>
              Stop
            </Button>
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
