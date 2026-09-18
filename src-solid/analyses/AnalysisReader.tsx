/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AnonymizerMode } from '@bridge/types';
import { AnalysisSectionView } from '../editor';
import type { LineRefTarget, ResolvedSection } from '../editor';
import type { AnalysesStore } from './analysesStore';
import styles from './analyses.module.css';

export interface AnalysisReaderProps {
  store: AnalysesStore;
  onBack: () => void;
  onEdit: () => void;
  /** Mount with the export options row already open — the list row's Export
   *  button lands here so both entry points share one code path. */
  exportOpen?: boolean;
}

/** How long "Copied!" stays on the Copy button (same as the bookmarks panel). */
const COPIED_MS = 2_000;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
/** The backend's per-reference line cap, named in the row so an over-broad
 *  reference's "… N more lines not shown" trailer is not a surprise. */
const MAX_LINES_PER_REFERENCE = 500;

/** The row's one-line account of what the backend will do to the log lines.
 *  Display only: the decision itself is `services::policy` (rule 9). */
function modeStatus(mode: AnonymizerMode | null | undefined): string {
  switch (mode) {
    case 'all':
      return 'All — log lines will be anonymized';
    case 'external':
      return 'External — log lines will be anonymized';
    case 'none':
      return 'None — exported raw';
    case null:
      return 'Anonymizer mode unavailable';
    default:
      return 'Checking anonymizer mode…';
  }
}

/**
 * Renders the selected artifact with E1's `AnalysisSectionView` per section.
 * References are resolved against the store's session labels once here (not
 * passed down as a resolver callback), same rationale as React's
 * `AnalysisReader.tsx`: it keeps `AnalysisSectionView`'s props stable data.
 *
 * The header's **Export** opens an inline options row (context lines, the
 * anonymizer-mode status line, Save as… / Copy) rather than a modal — the
 * document is derived from the live session at export time, so there is
 * nothing to preview and one row is enough.
 */
export function AnalysisReader(props: AnalysisReaderProps): JSX.Element {
  const artifact = () => props.store.selected();

  const [exportOpen, setExportOpen] = createSignal(false);
  // The panel raises `exportOpen` when a list row's Export button opened this
  // reader; the row can still be closed and reopened from the header.
  createEffect(
    on(
      () => props.exportOpen,
      (open) => {
        if (open) setExportOpen(true);
      },
    ),
  );
  const [contextLines, setContextLines] = createSignal(DEFAULT_CONTEXT_LINES);
  // `undefined` = not fetched yet, `null` = the fetch failed.
  const [mode, setMode] = createSignal<AnonymizerMode | null | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
  });

  // Fetched when the row opens, not on mount: most reads never export.
  createEffect(
    on(exportOpen, (open) => {
      if (!open) return;
      props.store.anonymizerMode().then(
        (m) => setMode(m),
        () => setMode(null),
      );
    }),
  );

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

  const options = () => ({ contextLines: contextLines() });

  const handleSaveAs = (): void => {
    const a = untrack(artifact);
    if (!a || busy()) return;
    setBusy(true);
    void props.store.exportMarkdown(a.id, options()).finally(() => setBusy(false));
  };

  const handleCopy = (): void => {
    const a = untrack(artifact);
    if (!a || busy()) return;
    setBusy(true);
    void props.store.copyMarkdown(a.id, options()).finally(() => {
      setBusy(false);
      // The store settles a failure into `error()` rather than rejecting, so
      // "Copied!" is gated on that, not on the promise.
      if (untrack(() => props.store.error()) !== null) return;
      setCopied(true);
      if (copiedTimer !== undefined) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), COPIED_MS);
    });
  };

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
              <button
                type="button"
                class={styles.exportButton}
                aria-expanded={exportOpen()}
                onClick={() => setExportOpen((v) => !v)}
              >
                Export
              </button>
              <button type="button" class={styles.editButton} onClick={props.onEdit}>
                Edit
              </button>
            </>
          )}
        </Show>
      </header>
      <Show when={artifact() && exportOpen()}>
        <div class={styles.exportRow} data-testid="analysis-export-options">
          <label class={styles.exportField}>
            Context lines
            <input
              class={styles.contextInput}
              type="number"
              min={0}
              max={MAX_CONTEXT_LINES}
              value={contextLines()}
              aria-label="Context lines around each reference"
              onInput={(e) => {
                const n = Number.parseInt(e.currentTarget.value, 10);
                if (Number.isFinite(n)) setContextLines(Math.min(MAX_CONTEXT_LINES, Math.max(0, n)));
              }}
            />
          </label>
          <span class={styles.exportStatus} data-testid="analysis-export-mode">
            {modeStatus(mode())}
          </span>
          <span class={styles.exportStatus}>Up to {MAX_LINES_PER_REFERENCE} lines per reference.</span>
          <div class={styles.exportActions}>
            <button type="button" class={styles.button} disabled={busy()} onClick={handleSaveAs}>
              Save as…
            </button>
            <button type="button" class={styles.button} disabled={busy()} onClick={handleCopy}>
              {copied() ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <Show when={props.store.error()}>
            {(message) => (
              <div class={styles.errorBanner} role="alert" data-testid="analysis-export-error">
                <span class={styles.errorBannerText}>{message()}</span>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={artifact()} fallback={<p class={styles.empty}>Select an analysis from the list.</p>}>
        <div class={styles.readerBody}>
          <For each={resolvedSections()}>{(section) => <AnalysisSectionView section={section} onJump={handleJump} />}</For>
        </div>
      </Show>
    </div>
  );
}
