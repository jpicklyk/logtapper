/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { groupProcessorsByPack, resolveChainProcessors } from '@bridge/types';
import type { ProcessorSummary } from '@bridge/types';
import type { CallerLike } from '../ui';
import { AddAnalyzer } from './AddAnalyzer';
import { AnalyzerCard } from './AnalyzerCard';
import { AnalyzerDetail } from './AnalyzerDetail';
import type { AnalyzerController, AnalyzerStore } from './analyzerStore';
import styles from './analyzers.module.css';

export interface AnalyzersPanelProps {
  store: AnalyzerStore;
  controller: AnalyzerController;
  sessionId: string;
  sessionName?: string;
  onOpenDeviceState?: (processorId: string) => void;
  /** Who last ran this session's pipeline, from the presence store's activity
   *  journal (`pipeline.run`). Omitted entirely when the caller has no such
   *  wiring — the badge is then simply not shown, per W4a/A2's contract. */
  lastRunCaller?: (sessionId: string) => CallerLike | null;
}

/**
 * The `analyzers` surface: header (run/stop, add, reset), the active set as
 * cards grouped by pack, the pinned anonymizer's display-only trailing row,
 * and the detail/add-analyzer drawers. Mounted through the shell's `analyzers`
 * slot (region on standard+, drawer on compact — S1's placement, not decided
 * here).
 */
export function AnalyzersPanel(props: AnalyzersPanelProps): JSX.Element {
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const [addOpen, setAddOpen] = createSignal(false);

  const chain = createMemo(() => props.store.chain(props.sessionId));
  const result = createMemo(() => props.store.result(props.sessionId));
  const running = createMemo(() => props.store.running(props.sessionId));
  const progress = createMemo(() => props.store.progress(props.sessionId));

  const orderedProcessors = createMemo<ProcessorSummary[]>(() =>
    resolveChainProcessors(chain().order, props.store.catalog()),
  );

  // `store.groups()` groups the WHOLE catalog (W4a's documented deviation) —
  // this session's chain needs its own resolve-then-group, exactly as
  // `groupProcessorsByPack`'s own doc comment describes for a caller with an
  // already-resolved, orderable list.
  const grouped = createMemo(() => groupProcessorsByPack(orderedProcessors(), props.store.packs()));

  const pinnedProcessors = createMemo<ProcessorSummary[]>(() =>
    props.store
      .pinnedTail()
      .map((id) => props.store.byId(id))
      .filter((p): p is ProcessorSummary => p !== undefined),
  );

  const skippedCount = createMemo(
    () => result()?.summaries.filter((s) => s.skipped).length ?? 0,
  );
  const skippedSourceType = createMemo(
    () => result()?.summaries.find((s) => s.skipped)?.skipped?.actual,
  );

  const overallProgress = createMemo<number | null>(() => {
    const entries = [...progress().values()];
    if (entries.length === 0) return null;
    return Math.round(entries.reduce((sum, p) => sum + p.percent, 0) / entries.length);
  });

  const lastRunCaller = createMemo<CallerLike | null>(
    () => props.lastRunCaller?.(props.sessionId) ?? null,
  );

  const indexOf = (id: string): number => chain().order.indexOf(id);

  const renderCard = (processor: ProcessorSummary, pinned = false): JSX.Element => (
    <AnalyzerCard
      store={props.store}
      controller={props.controller}
      sessionId={props.sessionId}
      processor={processor}
      pinned={pinned}
      disabled={!pinned && chain().disabled.includes(processor.id)}
      running={running()}
      progress={progress().get(processor.id)}
      summary={props.store.summaryFor(props.sessionId, processor.id)}
      lastRunCaller={lastRunCaller()}
      addedBy={pinned ? null : props.store.addedBy(props.sessionId, processor.id)}
      index={pinned ? undefined : indexOf(processor.id)}
      total={pinned ? undefined : chain().order.length}
      onToggle={() => props.store.toggle(props.sessionId, processor.id)}
      onMoveUp={() => props.store.reorder(props.sessionId, indexOf(processor.id), indexOf(processor.id) - 1)}
      onMoveDown={() => props.store.reorder(props.sessionId, indexOf(processor.id), indexOf(processor.id) + 1)}
      onRemove={() => props.store.remove(props.sessionId, processor.id)}
      onOpenDeviceState={props.onOpenDeviceState}
      onOpenDetail={setDetailId}
    />
  );

  const handleRun = (): void => {
    void props.store.run(props.sessionId);
  };
  const handleStop = (): void => {
    void props.store.stop(props.sessionId);
  };

  return (
    <div class={styles.panel}>
      <div class={styles.header}>
        <span class={styles.sessionName}>{props.sessionName ?? 'Analyzers'}</span>
        <Show
          when={!running()}
          fallback={
            <button type="button" class={`${styles.btn} ${styles.btnDanger}`} onClick={handleStop}>
              Stop
              <Show when={overallProgress() !== null}>
                <span class={styles.runProgress}>{overallProgress()}%</span>
              </Show>
            </button>
          }
        >
          <button type="button" class={`${styles.btn} ${styles.btnPrimary}`} onClick={handleRun}>
            Run
          </button>
        </Show>
        <button type="button" class={styles.btn} onClick={() => setAddOpen(true)}>
          Add analyzer
        </button>
        <button type="button" class={styles.btn} onClick={() => props.store.resetToDefault(props.sessionId)}>
          Reset
        </button>
      </div>

      <Show when={skippedCount() > 0}>
        <div class={styles.banner}>
          {skippedCount()} not applicable to this {skippedSourceType()} source
        </div>
      </Show>

      <Show
        when={chain().order.length > 0 || pinnedProcessors().length > 0}
        fallback={
          <div class={styles.empty}>
            <span>No active analyzers.</span>
            <span>Add an analyzer to start finding things in this log.</span>
          </div>
        }
      >
        <div class={styles.list}>
          <For each={grouped().packGroups}>
            {(group) => (
              <>
                <div class={styles.groupLabel}>{group.pack.name}</div>
                <For each={group.processors}>{(p) => renderCard(p)}</For>
              </>
            )}
          </For>
          <For each={grouped().standaloneProcessors}>{(p) => renderCard(p)}</For>
          <For each={pinnedProcessors()}>{(p) => renderCard(p, true)}</For>
        </div>
      </Show>

      <Show when={detailId()}>
        {(id) => (
          <AnalyzerDetail
            store={props.store}
            sessionId={props.sessionId}
            processorId={id()}
            onClose={() => setDetailId(null)}
          />
        )}
      </Show>

      <Show when={addOpen()}>
        <AddAnalyzer store={props.store} sessionId={props.sessionId} onClose={() => setAddOpen(false)} />
      </Show>
    </div>
  );
}
