/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { formatNumber, groupVars, snakeToTitle } from '@procdash/utils';
import { MATCHED_PREVIEW_CAP } from './analyzerStore';
import type { AnalyzerStore, MatchedLineDigest } from './analyzerStore';
import { createOverlayDialog } from './overlayDialog';
import styles from './analyzers.module.css';

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
  const [matched, setMatched] = createSignal<MatchedLineDigest | null>(null);
  const [loadingMatches, setLoadingMatches] = createSignal(false);
  const dialog = createOverlayDialog(() => props.onClose());

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
      setMatched(null);
      return;
    }
    const id = props.processorId;
    // The store caches matched lines per *run generation*, which is a plain
    // counter and deliberately non-reactive — so a re-run (ours or an agent's)
    // silently replaced the cache while this effect kept showing the previous
    // run's lines next to the new run's summary counts (D1-M7). `lastRunAt` is
    // store-backed and bumped by every landed run, so tracking it here is the
    // reactive edge the generation counter cannot be.
    props.store.lastRunAt(props.sessionId);
    let cancelled = false;
    setLoadingMatches(true);
    void props.store
      .matchedLines(props.sessionId, id)
      .then((digest) => { if (!cancelled) setMatched(digest); })
      .catch(() => { if (!cancelled) setMatched(null); })
      .finally(() => { if (!cancelled) setLoadingMatches(false); });
    onCleanup(() => { cancelled = true; });
  });

  const groups = createMemo(() => (vars() ? groupVars(vars()!) : null));

  const total = createMemo(() => matched()?.total ?? 0);
  const shown = createMemo(() => matched()?.preview ?? []);

  const handleShowInViewer = (): void => {
    void props.store.showMatched(props.sessionId, props.processorId);
    props.onClose();
  };

  return (
    <div class={styles.overlay} data-testid="analyzer-detail" {...dialog.props}>
      <div class={styles.overlayHeader}>
        <span id={dialog.labelId} class={styles.overlayTitle}>{processor()?.name ?? props.processorId}</span>
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
            <div class={styles.sectionLabel}>Matched lines ({total().toLocaleString()})</div>
            <Show when={total() > 0}>
              <button type="button" class={styles.btn} onClick={handleShowInViewer}>
                Show in viewer
              </button>
            </Show>
            <Show when={loadingMatches()}>
              <div class={styles.hint}>Loading…</div>
            </Show>
            <Show when={!loadingMatches() && total() === 0}>
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
            <Show when={total() > MATCHED_PREVIEW_CAP}>
              <div class={styles.hint}>
                Showing first {MATCHED_PREVIEW_CAP} of {total().toLocaleString()} — use "Show in
                viewer" to see the rest.
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
