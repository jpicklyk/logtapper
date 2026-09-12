/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { MatchedLine } from '@bridge/types';
import { formatNumber, groupVars, snakeToTitle } from '@procdash/utils';
import type { AnalyzerStore } from './analyzerStore';
import styles from './analyzers.module.css';

const MATCHED_LINES_CAP = 500;
const RANKED_CAP = 15;

export interface AnalyzerDetailProps {
  store: AnalyzerStore;
  sessionId: string;
  processorId: string;
  onClose: () => void;
}

/** The drawer for one analyzer: description/group/source types, its vars,
 *  the full run summary, and — for reporters — a capped matched-line list
 *  with a "show in viewer" action. */
export function AnalyzerDetail(props: AnalyzerDetailProps): JSX.Element {
  const [vars, setVars] = createSignal<Record<string, unknown> | null>(null);
  const [matchedLines, setMatchedLines] = createSignal<MatchedLine[]>([]);
  const [loadingMatches, setLoadingMatches] = createSignal(false);

  const processor = createMemo(() => props.store.byId(props.processorId));
  const summary = createMemo(() => props.store.summaryFor(props.sessionId, props.processorId));
  const isReporter = createMemo(() => processor()?.processorType === 'reporter');

  // `vars()` is deliberately uncached on the store — refetch every time the
  // drawer opens on a (possibly new) processor.
  createEffect(() => {
    const id = props.processorId;
    let cancelled = false;
    void props.store
      .vars(props.sessionId, id)
      .then((v) => { if (!cancelled) setVars(v); })
      .catch(() => { if (!cancelled) setVars(null); });
    onCleanup(() => { cancelled = true; });
  });

  createEffect(() => {
    if (!isReporter()) {
      setMatchedLines([]);
      return;
    }
    const id = props.processorId;
    let cancelled = false;
    setLoadingMatches(true);
    void props.store
      .matchedLines(props.sessionId, id)
      .then((lines) => { if (!cancelled) setMatchedLines(lines); })
      .catch(() => { if (!cancelled) setMatchedLines([]); })
      .finally(() => { if (!cancelled) setLoadingMatches(false); });
    onCleanup(() => { cancelled = true; });
  });

  const groups = createMemo(() => (vars() ? groupVars(vars()!) : null));

  const shown = createMemo(() => matchedLines().slice(0, MATCHED_LINES_CAP));

  const handleShowInViewer = (): void => {
    void props.store.showMatched(props.sessionId, props.processorId);
    props.onClose();
  };

  return (
    <div class={styles.overlay} data-testid="analyzer-detail">
      <div class={styles.overlayHeader}>
        <span class={styles.overlayTitle}>{processor()?.name ?? props.processorId}</span>
        <button type="button" class={styles.btn} onClick={() => props.onClose()}>
          Close
        </button>
      </div>
      <div class={styles.overlayBody}>
        <Show when={processor()}>
          {(p) => (
            <div class={styles.section}>
              <Show when={p().description}>
                <div class={styles.hint}>{p().description}</div>
              </Show>
              <div class={styles.kvRow}>
                <span class={styles.kvKey}>Group</span>
                <span class={styles.kvVal}>{p().group ?? '—'}</span>
              </div>
              <div class={styles.kvRow}>
                <span class={styles.kvKey}>Source types</span>
                <span class={styles.kvVal}>{p().sourceTypes.length > 0 ? p().sourceTypes.join(', ') : 'any'}</span>
              </div>
            </div>
          )}
        </Show>

        <Show when={summary()}>
          {(s) => (
            <div class={styles.section}>
              <div class={styles.sectionLabel}>Last run</div>
              <div class={styles.kvRow}>
                <span class={styles.kvKey}>Matched lines</span>
                <span class={styles.kvVal}>{s().matchedLines.toLocaleString()}</span>
              </div>
              <div class={styles.kvRow}>
                <span class={styles.kvKey}>Emissions</span>
                <span class={styles.kvVal}>{s().emissionCount.toLocaleString()}</span>
              </div>
              <Show when={s().skipped}>
                {(skip) => (
                  <div class={styles.skipRow}>
                    Not applicable — declares {skip().declared.join(', ')}, source is {skip().actual}
                  </div>
                )}
              </Show>
              <Show when={s().scriptErrors > 0}>
                <div class={styles.errorRow}>
                  {s().scriptErrors} script error{s().scriptErrors !== 1 ? 's' : ''}
                  <Show when={s().firstScriptError}> — {s().firstScriptError}</Show>
                </div>
              </Show>
            </div>
          )}
        </Show>

        <Show when={groups()}>
          {(g) => (
            <Show when={g().scalars.length > 0 || g().strings.length > 0 || g().ranked.length > 0}>
              <div class={styles.section}>
                <div class={styles.sectionLabel}>Values</div>
                <For each={g().scalars}>
                  {(v) => (
                    <div class={styles.kvRow}>
                      <span class={styles.kvKey}>{snakeToTitle(v.name)}</span>
                      <span class={styles.kvVal}>{formatNumber(v.value)}</span>
                    </div>
                  )}
                </For>
                <For each={g().strings}>
                  {(v) => (
                    <div class={styles.kvRow}>
                      <span class={styles.kvKey}>{snakeToTitle(v.name)}</span>
                      <span class={styles.kvVal}>{v.value || '—'}</span>
                    </div>
                  )}
                </For>
                <For each={g().ranked}>
                  {(v) => (
                    <>
                      <div class={styles.kvKey}>{snakeToTitle(v.name)}</div>
                      <For each={Object.entries(v.value).sort((a, b) => b[1] - a[1]).slice(0, RANKED_CAP)}>
                        {([key, count]) => (
                          <div class={styles.kvRow}>
                            <span class={styles.kvKey}>{key}</span>
                            <span class={styles.kvVal}>{formatNumber(count)}</span>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>

        <Show when={isReporter()}>
          <div class={styles.section}>
            <div class={styles.sectionLabel}>Matched lines ({matchedLines().length.toLocaleString()})</div>
            <Show when={matchedLines().length > 0}>
              <button type="button" class={styles.btn} onClick={handleShowInViewer}>
                Show in viewer
              </button>
            </Show>
            <Show when={loadingMatches()}>
              <div class={styles.hint}>Loading…</div>
            </Show>
            <Show when={!loadingMatches() && matchedLines().length === 0}>
              <div class={styles.hint}>No matched lines.</div>
            </Show>
            <For each={shown()}>
              {(line) => (
                <div class={styles.matchRow}>
                  <span class={styles.matchNum}>{line.lineNum + 1}</span>
                  <span class={styles.matchRaw}>{line.raw}</span>
                </div>
              )}
            </For>
            <Show when={matchedLines().length > MATCHED_LINES_CAP}>
              <div class={styles.hint}>
                Showing first {MATCHED_LINES_CAP} of {matchedLines().length.toLocaleString()} — use "Show in
                viewer" to see the rest.
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
