import React, { useState, useCallback, useEffect, useRef } from 'react';
import TextEditor from '../../viewport/TextEditor';
import { EditorToolbar } from './EditorToolbar';
import { MarkdownPreview } from './MarkdownPreview';
import { storageGet, storageSet } from '../../utils';
import styles from './EditorTab.module.css';

const LS_CONTENT_PREFIX = 'logtapper_scratchpad_';
const LS_MODE_PREFIX = 'logtapper_editor_mode_';

export type EditorViewMode = 'editor' | 'split' | 'preview';

interface EditorTabProps {
  tabId: string;
}

const EditorTab = React.memo(function EditorTab({ tabId }: EditorTabProps) {
  const [value, setValue] = useState(() => storageGet(LS_CONTENT_PREFIX + tabId));
  const [viewMode, setViewMode] = useState<EditorViewMode>(
    () => (storageGet(LS_MODE_PREFIX + tabId) as EditorViewMode) || 'editor',
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const prevTabIdRef = useRef(tabId);

  // When the active editor tab switches, flush the outgoing tab's content
  // synchronously and load the new tab's content.
  useEffect(() => {
    if (prevTabIdRef.current === tabId) return;
    storageSet(LS_CONTENT_PREFIX + prevTabIdRef.current, valueRef.current);
    prevTabIdRef.current = tabId;
    setValue(storageGet(LS_CONTENT_PREFIX + tabId));
    setViewMode((storageGet(LS_MODE_PREFIX + tabId) as EditorViewMode) || 'editor');
  }, [tabId]);

  const handleChange = useCallback((next: string) => {
    setValue(next);
  }, []);

  const handleModeChange = useCallback((mode: EditorViewMode) => {
    setViewMode(mode);
    storageSet(LS_MODE_PREFIX + tabId, mode);
  }, [tabId]);

  // Persist content to localStorage on change (debounced).
  useEffect(() => {
    const timer = setTimeout(() => {
      storageSet(LS_CONTENT_PREFIX + tabId, value);
    }, 500);
    return () => clearTimeout(timer);
  }, [tabId, value]);

  return (
    <div className={styles.root}>
      <EditorToolbar viewMode={viewMode} onModeChange={handleModeChange} />
      <div className={styles.content} data-mode={viewMode}>
        {/* Keep TextEditor mounted (hidden) in preview mode to preserve CodeMirror
            undo history and avoid expensive reinit on mode switch. */}
        <div className={styles.editorPane} hidden={viewMode === 'preview'}>
          <TextEditor
            value={value}
            onChange={handleChange}
            placeholder="Start typing..."
            className={styles.editor}
            lineWrapping
          />
        </div>
        {viewMode !== 'editor' && (
          <div className={styles.previewPane}>
            <MarkdownPreview content={value} />
          </div>
        )}
      </div>
    </div>
  );
});

export default EditorTab;
