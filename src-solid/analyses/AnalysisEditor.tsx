/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type { AnalysisArtifact, AnalysisSection, AnalysisSeverity, SourceReference } from '@bridge/types';
import { createTextEditor, lineRefText, Markdown } from '../editor';
import type { TextEditorHandle } from '../editor';
import type { AnalysesStore } from './analysesStore';
import styles from './analyses.module.css';

export interface AnalysisEditorProps {
  store: AnalysesStore;
  /** The artifact being edited, or `null` for a fresh "New analysis" draft. */
  artifactId: string | null;
  onDone: (artifactId: string) => void;
  onCancel: () => void;
}

/** `AnalysisSection`, editable — a `solid-js/store` array item. */
export interface DraftSection {
  heading: string;
  body: string;
  severity: AnalysisSeverity | null;
  references: SourceReference[];
}

const SEVERITIES: readonly AnalysisSeverity[] = ['Info', 'Warning', 'Error', 'Critical'];

function emptySection(seed?: SourceReference | null): DraftSection {
  return { heading: '', body: '', severity: null, references: seed ? [seed] : [] };
}

function cloneSection(section: AnalysisSection): DraftSection {
  return {
    heading: section.heading,
    body: section.body,
    severity: section.severity,
    references: section.references.map((r) => ({ ...r })),
  };
}

/** One section's markdown body: a CodeMirror instance in markdown mode plus a
 *  live `Markdown` preview, the E1 pattern `EditorTab.tsx` uses for one document. */
function SectionBodyEditor(props: { value: string; onChange: (next: string) => void }): JSX.Element {
  let host!: HTMLDivElement;
  let editor: TextEditorHandle | undefined;
  const [content, setContent] = createSignal(untrack(() => props.value));

  onMount(() => {
    editor = createTextEditor({
      parent: host,
      doc: content(),
      mode: 'markdown',
      placeholder: 'Write the finding…',
      onChange: (next) => {
        setContent(next);
        props.onChange(next);
      },
    });
  });
  onCleanup(() => editor?.dispose());

  return (
    <div class={styles.bodySplit}>
      <div class={styles.bodyEditorHost} ref={host} data-testid="section-body-host" />
      <div class={styles.bodyPreview}>
        <Markdown content={content()} />
      </div>
    </div>
  );
}

/**
 * Title, sections (heading + severity + markdown body + references),
 * Publish/Update/Cancel. Validation: a title, and at least one section that
 * actually has a heading or a body — a draft whose only section is blank is
 * refused. Cancel asks for confirmation once the draft has been touched.
 */
export function AnalysisEditor(props: AnalysisEditorProps): JSX.Element {
  // Snapshot `artifactId` once. `existing`/`seed` were already read untracked
  // from it while the header text and `handleSubmit`'s update-vs-publish
  // branch read it reactively, so a caller that changed `artifactId` without
  // changing `mode` would have submitted the old draft as an update to the
  // new artifact.
  const artifactId = untrack(() => props.artifactId);
  const existing = untrack(() => (artifactId ? props.store.selected() : undefined));
  const seed = untrack(() => (artifactId ? null : props.store.takeDraftSeed()));

  const [title, setTitle] = createSignal(existing?.title ?? '');
  const [sections, setSections] = createStore<DraftSection[]>(
    existing ? existing.sections.map(cloneSection) : [emptySection(seed)],
  );
  const [error, setError] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  /** The artifact as it now stands on the backend, when it changed under us. */
  const [conflict, setConflict] = createSignal<AnalysisArtifact | null>(null);
  /** Bumped when the draft is replaced wholesale, to force the section rows
   *  (and with them the CodeMirror instances, which read their document once
   *  on mount) to be rebuilt rather than merged in place. */
  const [draftGeneration, setDraftGeneration] = createSignal(0);

  // An `analysis-update` for the artifact this editor has open — an agent
  // revising it, say — used to be invisible here, and Update then sent the
  // stale `sections` array and silently dropped that revision.
  createEffect(
    on(
      () => props.store.selected(),
      (current) => {
        if (!artifactId || !current || current.id !== artifactId) return;
        if (current === existing) return;
        setConflict(current);
      },
      { defer: true },
    ),
  );

  const loadConflict = (): void => {
    const current = conflict();
    if (!current) return;
    setTitle(current.title);
    setSections(reconcile(current.sections.map(cloneSection)));
    setDraftGeneration((n) => n + 1);
    setConflict(null);
    setDirty(false);
  };

  const touch = (): void => {
    setDirty(true);
  };

  /** A draft whose only section is blank publishes an empty card that
   *  attribution files under "Unattributed" forever — refuse it. */
  const hasContent = createMemo(() =>
    sections.some((s) => s.heading.trim().length > 0 || s.body.trim().length > 0),
  );

  const canSubmit = createMemo(
    () => title().trim().length > 0 && hasContent() && !submitting() && conflict() === null,
  );

  const addSection = (): void => {
    setSections(produce((list) => list.push(emptySection())));
    touch();
  };

  const removeSection = (index: number): void => {
    setSections(produce((list) => list.splice(index, 1)));
    touch();
  };

  const addReferenceFromCursor = (index: number): void => {
    const ref = props.store.cursorReference();
    if (!ref) return;
    setSections(index, 'references', (refs) => [...refs, ref]);
    touch();
  };

  const removeReference = (sectionIndex: number, refIndex: number): void => {
    setSections(sectionIndex, 'references', produce((refs) => refs.splice(refIndex, 1)));
    touch();
  };

  const handleCancel = (): void => {
    if (dirty() && !globalThis.confirm('Discard unsaved changes?')) return;
    props.onCancel();
  };

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit()) {
      setError(
        conflict() !== null
          ? 'This analysis changed elsewhere — reload it or choose to overwrite.'
          : 'A title and at least one section with a heading or body are required.',
      );
      return;
    }
    setError(null);
    setSubmitting(true);
    const payload: AnalysisSection[] = sections.map((s) => ({
      heading: s.heading,
      body: s.body,
      references: s.references,
      severity: s.severity,
    }));
    try {
      const artifact = artifactId
        ? await props.store.update({ artifactId, title: title(), sections: payload })
        : await props.store.publish({ title: title(), sections: payload });
      props.onDone(artifact.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class={styles.editor} data-testid="analysis-editor">
      <header class={styles.editorHeader}>
        <h3 class={styles.editorHeading}>{artifactId ? 'Edit analysis' : 'New analysis'}</h3>
      </header>

      <Show when={conflict()}>
        <div class={styles.conflictBanner} role="alert" data-testid="analysis-conflict">
          <span>This analysis changed elsewhere while you were editing it.</span>
          <button type="button" class={styles.smallButton} onClick={loadConflict}>
            Reload it
          </button>
          <button type="button" class={styles.smallButton} onClick={() => setConflict(null)}>
            Overwrite anyway
          </button>
        </div>
      </Show>

      <label class={styles.field}>
        Title
        <input
          class={styles.titleInput}
          type="text"
          value={title()}
          onInput={(e) => {
            setTitle(e.currentTarget.value);
            touch();
          }}
          placeholder="What did you find?"
        />
      </label>

      <div class={styles.sectionList}>
        {/* `keyed` on a value that only changes when the whole draft is
            replaced: a plain `reconcile` merges in place and the mounted
            CodeMirror instances would keep the old text. */}
        <Show keyed when={`draft-${draftGeneration()}`}>
          <For each={sections}>
          {(section, index) => (
            <fieldset class={styles.sectionCard}>
              <div class={styles.sectionCardHeader}>
                <input
                  class={styles.headingInput}
                  type="text"
                  value={section.heading}
                  onInput={(e) => {
                    setSections(index(), 'heading', e.currentTarget.value);
                    touch();
                  }}
                  placeholder="Section heading"
                />
                <select
                  class={styles.severitySelect}
                  value={section.severity ?? ''}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setSections(index(), 'severity', value === '' ? null : (value as AnalysisSeverity));
                    touch();
                  }}
                >
                  <option value="">No severity</option>
                  <For each={SEVERITIES}>{(sev) => <option value={sev}>{sev}</option>}</For>
                </select>
                <button
                  type="button"
                  class={styles.iconButton}
                  title="Remove section"
                  onClick={() => removeSection(index())}
                >
                  ×
                </button>
              </div>

              <SectionBodyEditor
                value={section.body}
                onChange={(next) => {
                  setSections(index(), 'body', next);
                  touch();
                }}
              />

              <div class={styles.referencesRow}>
                <For each={section.references}>
                  {(ref, refIndex) => (
                    <span class={styles.referenceChip}>
                      <span class={styles.referenceLine}>{lineRefText(ref)}</span>
                      <input
                        class={styles.referenceLabelInput}
                        type="text"
                        value={ref.label}
                        onInput={(e) => {
                          setSections(index(), 'references', refIndex(), 'label', e.currentTarget.value);
                          touch();
                        }}
                      />
                      <button
                        type="button"
                        class={styles.iconButton}
                        title="Remove reference"
                        onClick={() => removeReference(index(), refIndex())}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </For>
                <button type="button" class={styles.smallButton} onClick={() => addReferenceFromCursor(index())}>
                  + Reference from cursor
                </button>
              </div>
            </fieldset>
          )}
          </For>
        </Show>
      </div>

      <button type="button" class={styles.smallButton} onClick={addSection}>
        + Add section
      </button>

      <Show when={error()}>
        <p class={styles.errorText}>{error()}</p>
      </Show>

      <div class={styles.actionsRow}>
        <button type="button" class={styles.button} onClick={handleCancel}>
          Cancel
        </button>
        <button type="button" class={styles.primaryButton} disabled={!canSubmit()} onClick={() => void handleSubmit()}>
          {artifactId ? 'Update' : 'Publish'}
        </button>
      </div>
    </div>
  );
}
