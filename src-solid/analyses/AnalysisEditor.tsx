/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { AnalysisSection, AnalysisSeverity, SourceReference } from '@bridge/types';
import { createTextEditor, Markdown } from '../editor';
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

function referenceText(ref: SourceReference): string {
  return ref.endLine != null ? `L${ref.lineNumber}–${ref.endLine}` : `L${ref.lineNumber}`;
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
 * Publish/Update/Cancel. Validation: a title and at least one section are
 * required. Cancel asks for confirmation once the draft has been touched.
 */
export function AnalysisEditor(props: AnalysisEditorProps): JSX.Element {
  const existing = untrack(() => (props.artifactId ? props.store.selected() : undefined));
  const seed = untrack(() => (props.artifactId ? null : props.store.takeDraftSeed()));

  const [title, setTitle] = createSignal(existing?.title ?? '');
  const [sections, setSections] = createStore<DraftSection[]>(
    existing ? existing.sections.map(cloneSection) : [emptySection(seed)],
  );
  const [error, setError] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);

  const touch = (): void => {
    setDirty(true);
  };

  const canSubmit = createMemo(() => title().trim().length > 0 && sections.length > 0 && !submitting());

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
      setError('A title and at least one section are required.');
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
      const artifact = props.artifactId
        ? await props.store.update({ artifactId: props.artifactId, title: title(), sections: payload })
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
        <h3 class={styles.editorHeading}>{props.artifactId ? 'Edit analysis' : 'New analysis'}</h3>
      </header>

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
                      <span class={styles.referenceLine}>{referenceText(ref)}</span>
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
          {props.artifactId ? 'Update' : 'Publish'}
        </button>
      </div>
    </div>
  );
}
