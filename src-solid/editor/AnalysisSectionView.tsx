/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AnalysisSection, SourceReference } from '@bridge/types';
import { severityColor } from '@bridge/types';
import { Markdown } from './Markdown';
import { lineRefText, lineRefTitle } from './lineRefs';
import type { LineRefSource, LineRefTarget } from './lineRefs';
import styles from './editor.module.css';

/**
 * One `AnalysisSection`, for the reader-parity phase.
 *
 * Structure follows `src-next/components/AnalysisReader/MarkdownSection.tsx`:
 * a heading, an optional severity badge, the chip row of `SourceReference`s, then
 * the markdown body. The severity colour comes from the shared `severityColor()`
 * in `@bridge/types` (reused, not re-derived) and is handed to the stylesheet as
 * `--section-accent` rather than being set as a property directly.
 *
 * What this adds over React: the body's markdown also gets the references
 * threaded through `lineRefs`, so a mention of `L482` in the prose is clickable,
 * not just the chip above it.
 */

/** `ResolvedReference` from MarkdownSection.tsx — the reference plus its precomputed resolution. */
export interface ResolvedReference extends SourceReference {
  resolved: boolean;
  sourceLabel?: string;
}

export interface ResolvedSection extends Omit<AnalysisSection, 'references'> {
  references: ResolvedReference[];
}

export interface AnalysisSectionViewProps {
  section: ResolvedSection;
  onJump?: (target: LineRefTarget) => void;
}

function toLineRefSource(reference: ResolvedReference): LineRefSource {
  return {
    lineNumber: reference.lineNumber,
    endLine: reference.endLine,
    label: reference.label,
    highlightType: reference.highlightType,
    sessionId: reference.sessionId,
    resolved: reference.resolved,
  };
}

export function AnalysisSectionView(props: AnalysisSectionViewProps) {
  const accent = () =>
    props.section.severity ? severityColor(props.section.severity) : 'var(--border-subtle)';

  const references = () => props.section.references.map(toLineRefSource);

  const jump = (reference: ResolvedReference) => {
    if (!reference.resolved) return;
    props.onJump?.({
      sessionId: reference.sessionId,
      line: reference.lineNumber,
      endLine: reference.endLine,
    });
  };

  return (
    <article
      class={styles.section}
      data-testid="analysis-section"
      style={{ '--section-accent': accent() } as JSX.CSSProperties}
    >
      <header class={styles.sectionHeader}>
        <h3 class={styles.sectionHeading}>{props.section.heading}</h3>
        <Show when={props.section.severity}>
          {(severity) => <span class={styles.severityBadge}>{severity()}</span>}
        </Show>
      </header>

      <Show when={props.section.references.length > 0}>
        <div class={styles.references}>
          <For each={props.section.references}>
            {(reference) => (
              <button
                type="button"
                class={styles.chip}
                title={lineRefTitle(toLineRefSource(reference))}
                disabled={!reference.resolved}
                data-anchor={reference.highlightType === 'Anchor' ? 'true' : undefined}
                onClick={() => jump(reference)}
              >
                <span class={styles.chipLine}>{lineRefText(toLineRefSource(reference))}</span>
                <span class={styles.chipLabel}>{reference.label}</span>
                <Show when={reference.resolved && reference.sourceLabel}>
                  <span class={styles.chipSource}>{reference.sourceLabel}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Markdown
        content={props.section.body}
        references={references()}
        onLineRef={props.onJump}
      />
    </article>
  );
}
