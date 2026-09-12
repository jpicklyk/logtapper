/**
 * Framework-free CodeMirror 6 text editor.
 *
 * Mirrors the extension set of the React `src-next/viewport/TextEditor.tsx`
 * (line numbers, active-line highlight, history, rectangular selection,
 * crosshair cursor, default + history + search keymaps, an optional placeholder,
 * a line-wrapping compartment and a read-only compartment) and adds what the
 * React component got from React state instead: modes, and dirty tracking.
 *
 * **`@codemirror/lang-markdown` is not in `package-lock.json`**, and this package
 * may not change the lockfile, so `markdown` mode cannot use the real Lezer
 * markdown parser. It instead turns on line wrapping and a small regex-driven
 * decoration plugin (headings, fences, inline code, emphasis, link text, list
 * bullets, blockquotes) built from `@codemirror/view` primitives only. Swapping
 * in `markdownLanguage()` later is a one-line change inside `modeExtensions`.
 */

import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  crosshairCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';

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
  /** Replace the document. Also marks it saved unless `markSaved: false`. */
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

// ── Markdown mode without a parser ───────────────────────────────────────────

/**
 * Per-line regexes, applied to the visible ranges only. Not a parser — it cannot
 * know that a `*` sits inside a fence — which is exactly why this is described as
 * "basic" highlighting and why the real language package is the upgrade path.
 */
const MARKDOWN_RULES: Array<{ pattern: RegExp; class: string }> = [
  { pattern: /^\s{0,3}#{1,6}\s.*$/, class: 'cm-md-heading' },
  { pattern: /^\s{0,3}(?:```|~~~).*$/, class: 'cm-md-code' },
  { pattern: /^\s{0,3}>\s?.*$/, class: 'cm-md-quote' },
  { pattern: /`[^`\n]+`/g, class: 'cm-md-code' },
  { pattern: /\*\*[^\n*]+\*\*/g, class: 'cm-md-strong' },
  { pattern: /(?<![*\w])\*[^\n*]+\*(?!\*)/g, class: 'cm-md-emphasis' },
  { pattern: /\[[^\]\n]*\]\([^)\n]*\)/g, class: 'cm-md-link' },
  { pattern: /^\s{0,3}(?:[-*+]|\d+\.)\s/, class: 'cm-md-marker' },
];

function markdownDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Ranges must be added in ascending `from`; collect then sort, because the
  // rules above are applied rule-first rather than position-first.
  const ranges: Array<{ from: number; to: number; class: string }> = [];

  for (const { from, to } of view.visibleRanges) {
    let position = from;
    while (position <= to) {
      const line = view.state.doc.lineAt(position);
      for (const rule of MARKDOWN_RULES) {
        if (rule.pattern.global) {
          rule.pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = rule.pattern.exec(line.text)) !== null) {
            ranges.push({
              from: line.from + match.index,
              to: line.from + match.index + match[0].length,
              class: rule.class,
            });
          }
        } else {
          const match = rule.pattern.exec(line.text);
          if (match) {
            ranges.push({
              from: line.from + match.index,
              to: line.from + match.index + match[0].length,
              class: rule.class,
            });
          }
        }
      }
      if (line.to >= view.state.doc.length) break;
      position = line.to + 1;
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  let lastFrom = -1;
  for (const range of ranges) {
    // RangeSetBuilder rejects out-of-order adds; overlapping rules (a `**bold**`
    // inside a heading) are resolved by keeping the first at each position.
    if (range.from < lastFrom || range.from >= range.to) continue;
    builder.add(range.from, range.to, Decoration.mark({ class: range.class }));
    lastFrom = range.to;
  }
  return builder.finish();
}

const markdownHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = markdownDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = markdownDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function modeExtensions(mode: EditorMode): Extension {
  // TODO: replace with `markdown({ base: markdownLanguage })` once
  // @codemirror/lang-markdown is a dependency (it is not in the lockfile today).
  return mode === 'markdown' ? [markdownHighlight] : [];
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
      if (next !== current) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
        });
        // The update listener has already run synchronously and set `current`,
        // but assign anyway so a no-op dispatch cannot leave it stale.
        current = next;
      }
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
