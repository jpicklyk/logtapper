import React, { useRef, useEffect, useMemo } from 'react';
import { EditorState, Compartment, Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, rectangularSelection, crosshairCursor, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { useTheme } from '../context/ThemeContext';
import styles from './TextEditor.module.css';

interface TextEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  className?: string;
  placeholder?: string;
  /** Enable line wrapping. Defaults to false (horizontal scroll). */
  lineWrapping?: boolean;
}

function createEditorTheme(isDark: boolean): Extension {
  return EditorView.theme({
    '&': { backgroundColor: 'var(--editor-bg)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: '12px' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--editor-selection-bg)' },
    '.cm-gutters': { backgroundColor: 'var(--editor-gutter-bg)', color: 'var(--editor-gutter-text)', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-overlay)' },
    '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  }, { dark: isDark });
}

const TextEditor = React.memo(function TextEditor({
  value,
  onChange,
  readOnly = false,
  className,
  placeholder,
  lineWrapping: enableLineWrapping = false,
}: TextEditorProps) {
  const { resolvedTheme } = useTheme();
  const editorTheme = useMemo(() => createEditorTheme(resolvedTheme === 'dark'), [resolvedTheme]);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  // Tracks the last value emitted by the editor via onChange. When the parent
  // feeds this value back as the `value` prop, the sync effect can skip the
  // expensive doc.toString() comparison — the editor already has this content.
  const lastEmittedRef = useRef(value);

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      rectangularSelection(),
      crosshairCursor(),
      ...(enableLineWrapping ? [EditorView.lineWrapping] : []),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      themeCompartment.current.of(editorTheme),
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          lastEmittedRef.current = text;
          onChange(text);
        }
      }),
    ];

    if (placeholder) {
      extensions.push(cmPlaceholder(placeholder));
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only run on mount/unmount - value sync handled by separate effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes into the editor. Skip when the value is just
  // the editor's own output echoed back (avoids O(n) doc.toString() per keystroke).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Fast path: if value matches what we last emitted, the editor already has it.
    if (value === lastEmittedRef.current) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentDoc.length,
          insert: value,
        },
      });
    }
    lastEmittedRef.current = value;
  }, [value]);

  // Sync theme when resolvedTheme changes (skip initial mount — compartment already seeded)
  const themeInitRef = useRef(true);
  useEffect(() => {
    if (themeInitRef.current) { themeInitRef.current = false; return; }
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: themeCompartment.current.reconfigure(editorTheme),
    });
  }, [editorTheme]);

  // Sync readOnly prop
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(readOnly)
      ),
    });
  }, [readOnly]);

  return (
    <div
      ref={containerRef}
      className={className ? `${styles.editor} ${className}` : styles.editor}
    />
  );
});

export default TextEditor;
