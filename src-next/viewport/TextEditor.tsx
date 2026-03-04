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
}: TextEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  // Track whether the current change originated from the editor itself
  const internalChange = useRef(false);

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
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      darkTheme,
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          internalChange.current = true;
          onChange(update.state.doc.toString());
          internalChange.current = false;
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

  // Sync external value changes into the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view || internalChange.current) return;

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
