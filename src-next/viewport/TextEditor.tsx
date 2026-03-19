import React, { useRef, useEffect } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, rectangularSelection, crosshairCursor, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
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

const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(88, 166, 255, 0.2)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-raised)',
    color: 'var(--text-dimmed)',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--bg-overlay)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
}, { dark: true });

const TextEditor = React.memo(function TextEditor({
  value,
  onChange,
  readOnly = false,
  className,
  placeholder,
  lineWrapping: enableLineWrapping = false,
}: TextEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
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
      darkTheme,
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
