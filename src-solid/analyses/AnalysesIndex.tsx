/** @jsxImportSource solid-js */
import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AnalysisArtifact } from '@bridge/types';
import { attributeArtifact } from '@analysis';
import type { AnalysesStore } from './analysesStore';
import { relativeTime } from './AnalysesPanel';
import styles from './analyses.module.css';

export interface AnalysesIndexProps {
  store: AnalysesStore;
  /**
   * Called after a row is selected, with the artifact id. `App.tsx` uses it
   * to reveal the analyses surface where that surface is a drawer (compact);
   * where it is a column the selection alone brings the reader up.
   */
  onOpen?: (artifactId: string) => void;
}

/**
 * The workspace pane's analyses index: one row per artifact, newest first.
 * The title owns the row (up to two lines); the session it draws on and its
 * age sit on a muted line beneath so they never squeeze it. Titles only — the reader stays
 * on the `analyses` surface (a document wants a column, not a drawer), so a
 * click selects the artifact in the shared store and `AnalysesPanel` opens
 * its reader in response (its `selected` effect).
 */
export function AnalysesIndex(props: AnalysesIndexProps): JSX.Element {
  const sorted = createMemo(() => [...props.store.list()].sort((a, b) => b.createdAt - a.createdAt));

  const sessionLabel = (artifact: AnalysisArtifact): string | null => {
    const labels = props.store.labels();
    const first = attributeArtifact(artifact, labels).resolved[0];
    if (first !== undefined) return first.label;
    return artifact.sessionId !== undefined ? (labels.get(artifact.sessionId) ?? null) : null;
  };

  const open = (artifact: AnalysisArtifact): void => {
    props.store.select(artifact.id);
    props.onOpen?.(artifact.id);
  };

  return (
    <div class={styles.index} data-testid="analyses-index">
      <Show
        when={sorted().length > 0}
        fallback={<p class={styles.indexEmpty}>No analyses in this workspace yet.</p>}
      >
        <For each={sorted()}>
          {(artifact) => (
            <button
              type="button"
              class={styles.indexRow}
              data-testid="analyses-index-row"
              aria-current={props.store.selectedId() === artifact.id ? 'true' : undefined}
              title={artifact.title}
              onClick={() => open(artifact)}
            >
              <span class={styles.indexTitle}>{artifact.title}</span>
              <span class={styles.indexMetaRow}>
                <Show when={sessionLabel(artifact)}>
                  {(label) => (
                    <span class={`${styles.indexMeta} ${styles.indexSession}`} title={label()}>
                      {label()}
                    </span>
                  )}
                </Show>
                <span class={styles.indexMeta}>{relativeTime(artifact.createdAt)}</span>
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  );
}
