/** @jsxImportSource solid-js */
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AnonymizerMode, CorrelatorResult, PipelineRunSummary, ProcessorSummary } from '@bridge/types';
import type { CallerLike } from '../ui';
import { CallerBadge, callerClient, normalizeCaller } from '../ui';
import type { AnalyzerController, AnalyzerProgress, AnalyzerStore } from './analyzerStore';
import { AnonymizerModeControl } from './AnonymizerModeControl';
import styles from './analyzers.module.css';

const TYPE_LABEL: Record<string, string> = {
  reporter: 'Reporter',
  state_tracker: 'Tracker',
  correlator: 'Correlator',
  transformer: 'PII',
};

const TYPE_ACCENT: Record<string, string> = {
  reporter: 'var(--processor-reporter)',
  state_tracker: 'var(--processor-tracker)',
  correlator: 'var(--processor-correlator)',
  transformer: 'var(--processor-transformer)',
};

export interface AnalyzerCardProps {
  store: AnalyzerStore;
  controller: AnalyzerController;
  sessionId: string;
  processor: ProcessorSummary;
  disabled: boolean;
  running: boolean;
  progress?: AnalyzerProgress;
  summary?: PipelineRunSummary;
  /** Trailing row for the pinned anonymizer — no toggle, reorder or remove;
   *  its body is the mode control (`anonymizer`) instead of a stat line. */
  pinned?: boolean;
  /** The global anonymizer mode and its writer, for the pinned card only. The
   *  panel resolves both from the settings store; a pinned card without them
   *  (tests, a host with no settings store) keeps the display-only `--`. */
  anonymizer?: AnonymizerControlBinding;
  index?: number;
  total?: number;
  lastRunCaller?: CallerLike | null;
  /** Who introduced this analyzer into the session's chain, when that was an
   *  agent (`store.addedBy`). A human addition carries no badge. */
  addedBy?: CallerLike | null;
  onToggle?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Drop this analyzer from the session's chain (the processor stays
   *  installed). The undo for anything an agent added. */
  onRemove?: () => void;
  onOpenDeviceState?: (processorId: string) => void;
  onOpenDetail?: (processorId: string) => void;
}

/** What the pinned card needs to render and drive the mode control. Plain
 *  values, not accessors: read from the panel's props in its render, so the
 *  card re-renders through Solid's prop getters like every other prop here. */
export interface AnonymizerControlBinding {
  mode: AnonymizerMode;
  setMode: (mode: AnonymizerMode) => Promise<void>;
  bridgeRunning: boolean;
  agentConnected: boolean;
  /** The config has not loaded yet. */
  loading: boolean;
}

/** One analyzer's row: dispatches its stat line on `processorType`, plus the
 *  inline banners (skipped / script errors / progress) every kind shares. */
export function AnalyzerCard(props: AnalyzerCardProps): JSX.Element {
  const [correlator, setCorrelator] = createSignal<CorrelatorResult | null>(null);

  // Correlator events are fetched lazily, only once a run has produced a
  // summary for this processor — refetched whenever that summary changes
  // (a new run replaces the summary object wholesale).
  createEffect(() => {
    const summary = props.summary;
    if (props.processor.processorType !== 'correlator' || !summary) {
      setCorrelator(null);
      return;
    }
    let cancelled = false;
    void props.store
      .correlatorEvents(props.sessionId, props.processor.id)
      .then((result) => { if (!cancelled) setCorrelator(result); })
      .catch(() => { if (!cancelled) setCorrelator(null); });
    onCleanup(() => { cancelled = true; });
  });

  const accent = (): string => TYPE_ACCENT[props.processor.processorType] ?? 'var(--border)';
  const typeLabel = (): string => TYPE_LABEL[props.processor.processorType] ?? props.processor.processorType;
  /** Only an agent's addition is worth a badge — the store never records a
   *  human's, but the prop is `CallerLike`, so say so here rather than trust it. */
  const addedByAgent = (): CallerLike | null =>
    props.addedBy && normalizeCaller(props.addedBy) === 'agent' ? props.addedBy : null;

  const handleShowMatched = (): void => {
    void props.store.showMatched(props.sessionId, props.processor.id);
  };
  const handleClearMatched = (): void => {
    props.store.clearMatched(props.sessionId);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || props.pinned) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      props.onMoveUp?.();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      props.onMoveDown?.();
    }
  };

  const cardClass = (): string =>
    [styles.card, props.disabled && styles.cardDisabled, props.pinned && styles.cardPinned]
      .filter(Boolean)
      .join(' ');

  // The card is a tab stop because Alt+Arrow reorders it from anywhere inside;
  // without a role and a name it was announced as nothing at all (D1-L8), and
  // the shortcut was discoverable only through the reorder buttons' `title`.
  // `aria-keyshortcuts` states it on the element that actually handles the key.
  return (
    <div
      class={cardClass()}
      style={{ '--card-accent': accent() } as JSX.CSSProperties}
      tabIndex={0}
      role="group"
      aria-label={`${props.processor.name} — ${typeLabel()}`}
      aria-keyshortcuts={props.pinned ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
      data-testid={`analyzer-card-${props.processor.id}`}
      data-processor-id={props.processor.id}
      onKeyDown={onKeyDown}
    >
      <div class={styles.cardRow}>
        <Show when={!props.pinned}>
          <input
            type="checkbox"
            checked={!props.disabled}
            aria-label={`Enable ${props.processor.name}`}
            onChange={() => props.onToggle?.()}
          />
        </Show>
        <button type="button" class={styles.cardName} onClick={() => props.onOpenDetail?.(props.processor.id)}>
          {props.processor.name}
        </button>
        <span class={styles.typeBadge}>{typeLabel()}</span>
        <Show when={addedByAgent()}>
          {(caller) => (
            <CallerBadge
              caller={caller()}
              label="Added"
              title={`Added by ${callerClient(caller()) ?? 'an agent'}`}
            />
          )}
        </Show>
        <Show when={props.lastRunCaller}>
          {(caller) => <CallerBadge caller={caller()} label="Ran" title="Last ran this analyzer" />}
        </Show>
        <Show when={!props.pinned}>
          <button
            type="button"
            class={styles.iconBtn}
            disabled={(props.index ?? 0) <= 0}
            title="Move up (Alt+Up)"
            aria-label="Move up"
            onClick={() => props.onMoveUp?.()}
          >
            ▲
          </button>
          <button
            type="button"
            class={styles.iconBtn}
            disabled={(props.index ?? 0) >= (props.total ?? 1) - 1}
            title="Move down (Alt+Down)"
            aria-label="Move down"
            onClick={() => props.onMoveDown?.()}
          >
            ▼
          </button>
          <button
            type="button"
            class={styles.iconBtn}
            title="Remove from this session's chain"
            aria-label={`Remove ${props.processor.name}`}
            onClick={() => props.onRemove?.()}
          >
            ×
          </button>
        </Show>
      </div>

      <Show when={props.summary?.skipped}>
        {(skip) => (
          <div class={styles.skipRow} title={`Declares ${skip().declared.join(', ')}`}>
            Not applicable to this {skip().actual} source
          </div>
        )}
      </Show>

      {/* The pinned anonymizer's body is the global mode control, not a
          per-run stat: a transformer has no summary worth a line, and this is
          the one place in the UI the mode is written (Settings → PII only
          mirrors it). */}
      <Show when={props.pinned && props.anonymizer}>
        {(binding) => (
          <AnonymizerModeControl
            mode={binding().mode}
            onChange={binding().setMode}
            bridgeRunning={binding().bridgeRunning}
            agentConnected={binding().agentConnected}
            disabled={binding().loading}
          />
        )}
      </Show>

      <Show when={!props.summary?.skipped && !(props.pinned && props.anonymizer)}>
        <div class={styles.statLine}>
          <Show when={props.processor.processorType === 'reporter'}>
            <span>
              {props.summary
                ? props.summary.matchedLines > 0
                  ? `${props.summary.matchedLines.toLocaleString()} matched`
                  : props.summary.emissionCount > 0
                    ? `${props.summary.emissionCount.toLocaleString()} events`
                    : '0 matched'
                : '--'}
            </span>
            <Show when={props.summary}>
              <button type="button" class={styles.chip} onClick={handleShowMatched}>
                Show matched lines
              </button>
              <button type="button" class={styles.chip} onClick={handleClearMatched}>
                Clear
              </button>
            </Show>
          </Show>

          <Show when={props.processor.processorType === 'state_tracker'}>
            <Show when={props.processor.trackerMode}>
              {(mode) => <span class={styles.badge}>{mode()}</span>}
            </Show>
            <Show when={props.processor.trackerSections.length > 0}>
              <span class={styles.badge}>{props.processor.trackerSections.join(', ')}</span>
            </Show>
            <Show when={props.processor.trackerTimeline}>
              <span class={styles.badge}>timeline</span>
            </Show>
            <span>{props.summary ? `${props.summary.matchedLines.toLocaleString()} transitions` : '--'}</span>
            <button type="button" class={styles.chip} onClick={() => props.onOpenDeviceState?.(props.processor.id)}>
              Open device state
            </button>
          </Show>

          <Show when={props.processor.processorType === 'correlator'}>
            <span>{(correlator()?.events.length ?? props.summary?.matchedLines ?? 0).toLocaleString()} events</span>
            <Show when={correlator() && correlator()!.events.length > 0}>
              {(() => {
                const events = correlator()!.events;
                const first = events[0];
                const last = events[events.length - 1];
                return (
                  <>
                    <button
                      type="button"
                      class={styles.chip}
                      onClick={() => props.controller.scrollToLine(props.sessionId, first.triggerLineNum, { source: 'user' })}
                    >
                      first: line {first.triggerLineNum + 1}
                    </button>
                    <Show when={last !== first}>
                      <button
                        type="button"
                        class={styles.chip}
                        onClick={() => props.controller.scrollToLine(props.sessionId, last.triggerLineNum, { source: 'user' })}
                      >
                        last: line {last.triggerLineNum + 1}
                      </button>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </Show>

          <Show
            when={
              props.processor.processorType !== 'reporter' &&
              props.processor.processorType !== 'state_tracker' &&
              props.processor.processorType !== 'correlator'
            }
          >
            <span>
              {props.summary
                ? props.summary.matchedLines > 0
                  ? props.summary.matchedLines.toLocaleString()
                  : props.summary.emissionCount > 0
                    ? `${props.summary.emissionCount.toLocaleString()} events`
                    : '0'
                : '--'}
            </span>
          </Show>
        </div>
      </Show>

      <Show when={props.summary && props.summary.scriptErrors > 0}>
        <div class={styles.errorRow} title={props.summary?.firstScriptError}>
          {props.summary?.scriptErrors} script error{props.summary!.scriptErrors !== 1 ? 's' : ''}
          <Show when={props.summary?.firstScriptError}> — {props.summary?.firstScriptError}</Show>
        </div>
      </Show>

      <Show when={props.summary && props.summary.scannedFrom > 0}>
        <div class={styles.hint}>Scanned from line {(props.summary!.scannedFrom + 1).toLocaleString()}</div>
      </Show>

      <Show when={props.running}>
        <div class={styles.progressBar}>
          <span style={{ '--bar-pct': `${props.progress?.percent ?? 0}%` } as JSX.CSSProperties} />
        </div>
      </Show>
    </div>
  );
}
