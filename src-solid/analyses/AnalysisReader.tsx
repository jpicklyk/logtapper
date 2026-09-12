/** @jsxImportSource solid-js */
import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import { AnalysisSectionView } from '../editor';
import type { LineRefTarget, ResolvedSection } from '../editor';
import type { AnalysesStore } from './analysesStore';
import styles from './analyses.module.css';

export interface AnalysisReaderProps {
  store: AnalysesStore;
  onBack: () => void;
  onEdit: () => void;
}

/**
 * Renders the selected artifact with E1's `AnalysisSectionView` per section.
 * References are resolved against the store's session labels once here (not
 * passed down as a resolver callback), same rationale as React's
 * `AnalysisReader.tsx`: it keeps `AnalysisSectionView`'s props stable data.
 */
export function AnalysisReader(props: AnalysisReaderProps): JSX.Element {
  const artifact = () => props.store.selected();

  const resolvedSections = createMemo<ResolvedSection[]>(() => {
    const a = artifact();
    if (!a) return [];
    const labels = props.store.labels();
    return a.sections.map((section) => ({
      ...section,
      references: section.references.map((ref) => ({
        ...ref,
        resolved: ref.sessionId !== null && labels.has(ref.sessionId),
        sourceLabel: ref.sessionId !== null ? labels.get(ref.sessionId) : undefined,
      })),
    }));
  });

  const handleJump = (target: LineRefTarget): void => props.store.jumpTo(target);

  return (
    <div class={styles.reader} data-testid="analysis-reader">
      <header class={styles.readerHeader}>
        <button type="button" class={styles.backButton} onClick={() => props.onBack()}>
          ← Back
        </button>
        <Show when={artifact()}>
          {(a) => (
            <>
              <h3 class={styles.readerTitle}>{a().title}</h3>
              <button type="button" class={styles.editButton} onClick={props.onEdit}>
                Edit
              </button>
            </>
          )}
        </Show>
      </header>
      <Show when={artifact()} fallback={<p class={styles.empty}>Select an analysis from the list.</p>}>
        <div class={styles.readerBody}>
          <For each={resolvedSections()}>{(section) => <AnalysisSectionView section={section} onJump={handleJump} />}</For>
        </div>
      </Show>
    </div>
  );
}
