/**
 * Framework-free CodeMirror 6 text editor.
 *
 * Mirrors the extension set of the React `src-next/viewport/TextEditor.tsx`
 * (line numbers, active-line highlight, history, rectangular selection,
 * crosshair cursor, default + history + search keymaps, an optional placeholder,
 * a line-wrapping compartment and a read-only compartment) and adds what the
 * React component got from React state instead: modes, and dirty tracking.
 *
 * `markdown` mode uses the real Lezer markdown parser
 * (`@codemirror/lang-markdown`'s `markdownLanguage`, CommonMark + GFM), paired
 * with a `HighlightStyle` that maps its highlight tags onto the same
 * `cm-md-*` classes `EDITOR_THEME` already themes with T1 tokens.
 */

import { Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';

export type EditorMode = 'plain' | 'markdown';

export interface CreateTextEditorOptions {
  /** Element the `EditorView` is mounted into (a Solid `ref`). */
  parent: HTMLElement;
  doc?: string;
  mode?: EditorMode;
  placeholder?: string;
  readOnly?: boolean;
  /** Defaults to `true` in markdown mode, `false` in plain mode. */
  lineWrapping?: boolean;
  onChange?: (value: string) => void;
}

export interface TextEditorHandle {
  readonly view: EditorView;
  getValue(): string;
  /** Replace the document. Also marks it saved unless `markSaved: false`.
   *  A `next` equal to the current document is a no-op in *both* respects —
   *  it neither dispatches nor touches the saved baseline — so a controlled
   *  caller echoing its own content back cannot silently clear `isDirty()`
   *  (review B-M8). Use {@link markSaved} to re-baseline deliberately. */
  setValue(next: string, options?: { markSaved?: boolean }): void;
  isDirty(): boolean;
  /** Treat the current document as the on-disk content — call after a write. */
  markSaved(): void;
  /** Subscribe to document changes; returns the unsubscribe. */
  onChange(listener: (value: string) => void): () => void;
  getMode(): EditorMode;
  setMode(mode: EditorMode): void;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  dispose(): void;
}

// ── Theme ────────────────────────────────────────────────────────────────────
// Every colour is a `var()` into the T1 token layer, so the editor follows the
// theme selector (and the two high-contrast themes) with no JS involvement —
// unlike the React component, which rebuilt the theme whenever `resolvedTheme`
// changed. Nothing here is a literal except structural padding.

const EDITOR_THEME: Extension = EditorView.theme({
  '&': {
    backgroundColor: 'var(--surface-input)',
    color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--viewer-font-size)',
    height: '100%',
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--viewer-selection-bg)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--text-dimmed)',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-overlay)' },
  '.cm-activeLine': { backgroundColor: 'var(--surface-overlay)' },
  '.cm-md-heading': { color: 'var(--accent)', fontWeight: '600' },
  '.cm-md-code': { color: 'var(--success)' },
  '.cm-md-emphasis': { color: 'var(--text-subtle)', fontStyle: 'italic' },
  '.cm-md-strong': { color: 'var(--text)', fontWeight: '600' },
  '.cm-md-link': { color: 'var(--accent)' },
  '.cm-md-marker': { color: 'var(--text-dimmed)' },
  '.cm-md-quote': { color: 'var(--text-muted)' },
});

// ── Markdown mode ────────────────────────────────────────────────────────────

/**
 * Maps `@lezer/markdown`'s highlight tags onto the `cm-md-*` classes
 * `EDITOR_THEME` themes with T1 tokens. Tag matching follows the lezer tag
 * hierarchy, so a rule for `tags.heading` also matches the `heading1`…`heading6`
 * tags the parser actually emits (one class for every heading level, same as
 * the previous regex-based highlighting).
 */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-md-heading' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: tags.emphasis, class: 'cm-md-emphasis' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.quote, class: 'cm-md-quote' },
  // Formatting characters themselves: `#`, `*`/`_`, `` ` ``, `-`/`+`/digit-dot,
  // `>`, link brackets — the marker style the old regex called `cm-md-marker`.
  { tag: tags.processingInstruction, class: 'cm-md-marker' },
]);

function modeExtensions(mode: EditorMode): Extension {
  return mode === 'markdown'
    ? [markdown({ base: markdownLanguage }), syntaxHighlighting(markdownHighlightStyle)]
    : [];
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTextEditor(options: CreateTextEditorOptions): TextEditorHandle {
  const modeCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  let mode: EditorMode = options.mode ?? 'plain';
  let current = options.doc ?? '';
  let saved = current;
  const listeners = new Set<(value: string) => void>();
  if (options.onChange) listeners.add(options.onChange);

  const wrapExtension = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);
  const wraps = options.lineWrapping ?? mode === 'markdown';

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    rectangularSelection(),
    crosshairCursor(),
    EDITOR_THEME,
    modeCompartment.of(modeExtensions(mode)),
    wrapCompartment.of(wrapExtension(wraps)),
    readOnlyCompartment.of(EditorState.readOnly.of(options.readOnly ?? false)),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      current = update.state.doc.toString();
      for (const listener of listeners) listener(current);
    }),
  ];
  if (options.placeholder) extensions.push(cmPlaceholder(options.placeholder));

  const view = new EditorView({
    state: EditorState.create({ doc: current, extensions }),
    parent: options.parent,
  });

  return {
    view,
    getValue: () => current,
    setValue(next, setOptions) {
      if (next === current) {
        // The document did not change, so nothing about its saved-state did
        // either (review B-M8). This is the *echo* case: a controlled caller
        // routes every keystroke out through `onChange` and back in as a new
        // `content` prop, and re-baselining `saved` here made `isDirty()`
        // permanently false for every such caller — the handle reported a
        // dirty buffer as clean. `markSaved()` is the explicit way to
        // re-baseline without a doc change.
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
      // The update listener has already run synchronously and set `current`,
      // but assign anyway so a no-op dispatch cannot leave it stale.
      current = next;
      if (setOptions?.markSaved !== false) saved = next;
    },
    isDirty: () => current !== saved,
    markSaved() {
      saved = current;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMode: () => mode,
    setMode(next) {
      if (next === mode) return;
      mode = next;
      view.dispatch({
        effects: [
          modeCompartment.reconfigure(modeExtensions(next)),
          // Wrapping follows the mode unless the caller pinned it explicitly.
          ...(options.lineWrapping === undefined
            ? [wrapCompartment.reconfigure(wrapExtension(next === 'markdown'))]
            : []),
        ],
      });
    },
    setReadOnly(readOnly) {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
      });
    },
    focus: () => view.focus(),
    dispose() {
      listeners.clear();
      view.destroy();
    },
  };
}
