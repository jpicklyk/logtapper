/** @jsxImportSource solid-js */
import { For, Show, createMemo } from 'solid-js';
import type { DeviceStateStore } from './deviceStateStore';
import styles from './devicestate.module.css';

export interface DeviceStatePanelProps {
  store: DeviceStateStore;
  sessionId: string;
}

/** Renders one field's value the way React's `StatePanel.tsx` `FieldValue`
 *  does: booleans/numbers/empty get their own token classes, everything else
 *  is a string with a title tooltip for overflow. */
function FieldValue(props: { value: unknown; initialized: boolean }) {
  return (
    <Show
      when={props.initialized}
      fallback={<span class={styles.unknownVal}>--</span>}
    >
      <Show
        when={props.value !== null && props.value !== undefined && props.value !== ''}
        fallback={<span class={styles.emptyVal}>(empty)</span>}
      >
        <Show
          when={typeof props.value !== 'boolean'}
          fallback={
            <span class={props.value ? styles.boolTrue : styles.boolFalse}>
              {props.value ? 'TRUE' : 'FALSE'}
            </span>
          }
        >
          <Show
            when={typeof props.value === 'number'}
            fallback={
              <span class={styles.strVal} title={String(props.value)}>
                {String(props.value)}
              </span>
            }
          >
            <span class={styles.numVal}>{String(props.value)}</span>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

/**
 * Device state panel (W5): tracker selector, cursor-tied snapshot as a field
 * table (initialized fields first, then a divider, then never-touched ones),
 * briefly-flashed changed fields, and prev/next transition navigation.
 *
 * `sourceSections` has no per-field attribution on the wire (`StateSnapshot`
 * carries one section list for the whole snapshot, not per key) — rendered
 * here as a chip bar above the field table, matching React's `StatePanel.tsx`
 * exactly, rather than literally grouping field rows by section.
 */
export function DeviceStatePanel(props: DeviceStatePanelProps) {
  const trackers = createMemo(() => props.store.trackers(props.sessionId));
  const selectedId = createMemo(() => props.store.selectedTracker(props.sessionId));
  const hasCursor = createMemo(() => props.store.hasCursor(props.sessionId));
  const snapshot = createMemo(() => props.store.snapshot(props.sessionId));
  const loading = createMemo(() => props.store.snapshotLoading(props.sessionId));
  const changes = createMemo(() => props.store.changes(props.sessionId));
  const position = createMemo(() => props.store.transitionPosition(props.sessionId));

  const initializedSet = createMemo(() => new Set(snapshot()?.initializedFields ?? []));
  const sortedFields = createMemo(() =>
    Object.entries(snapshot()?.fields ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  const knownFields = createMemo(() => sortedFields().filter(([k]) => initializedSet().has(k)));
  const unknownFields = createMemo(() => sortedFields().filter(([k]) => !initializedSet().has(k)));

  return (
    <div class={styles.panel}>
      <Show
        when={trackers().length > 0}
        fallback={
          <div class={styles.empty}>
            <span>No active state trackers</span>
            <span class={styles.emptyHint}>Enable a state tracker and run the pipeline</span>
          </div>
        }
      >
        <div class={styles.header}>
          <select
            class={styles.trackerSelect}
            value={selectedId() ?? ''}
            onChange={(e) => props.store.setSelectedTracker(props.sessionId, e.currentTarget.value || null)}
          >
            <For each={trackers()}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          </select>
          <Show when={position()}>
            {(pos) => (
              <div class={styles.transitionNav}>
                <button
                  type="button"
                  class={styles.navButton}
                  disabled={pos().total === 0}
                  onClick={() => props.store.prevTransition(props.sessionId)}
                >
                  ◀
                </button>
                <span class={styles.transitionCount}>
                  {pos().index} / {pos().total}
                </span>
                <button
                  type="button"
                  class={styles.navButton}
                  disabled={pos().total === 0}
                  onClick={() => props.store.nextTransition(props.sessionId)}
                >
                  ▶
                </button>
              </div>
            )}
          </Show>
        </div>

        <Show
          when={hasCursor()}
          fallback={
            <div class={styles.empty}>
              <span>Select a line in the viewer to see state here</span>
            </div>
          }
        >
        <Show
          when={snapshot()}
          fallback={
            <div class={styles.empty}>
              <span>{loading() ? 'Loading…' : 'Run the pipeline to see state'}</span>
            </div>
          }
        >
          {(snap) => (
            <>
              <div class={styles.lineInfo}>
                at line {snap().lineNum.toLocaleString()}
                <Show when={snap().timestamp > 0}> · {new Date(snap().timestamp / 1_000_000).toLocaleString()}</Show>
              </div>
              <Show when={snap().sourceSections.length > 0}>
                <div class={styles.sourceBar}>
                  <For each={snap().sourceSections}>{(s) => <span class={styles.sourceChip}>{s}</span>}</For>
                </div>
              </Show>
              <div class={styles.fieldsGrid}>
                <For each={knownFields()}>
                  {([key, value]) => (
                    <div class={styles.fieldRow} classList={{ [styles.fieldChanged]: key in changes() }}>
                      <span class={styles.fieldKey}>{key}</span>
                      <span class={styles.fieldVal}>
                        <FieldValue value={value} initialized />
                      </span>
                    </div>
                  )}
                </For>
                <Show when={knownFields().length > 0 && unknownFields().length > 0}>
                  <hr class={styles.unknownDivider} />
                </Show>
                <For each={unknownFields()}>
                  {([key, value]) => (
                    <div class={styles.fieldRowUnknown}>
                      <span class={styles.fieldKey}>{key}</span>
                      <span class={styles.fieldVal}>
                        <FieldValue value={value} initialized={false} />
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
        </Show>
      </Show>
    </div>
  );
}
