import React, { useState, useCallback, useEffect, useRef } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import TextEditor from '../../viewport/TextEditor';
import { EditorToolbar } from './EditorToolbar';
import { MarkdownPreview } from './MarkdownPreview';
import { storageGet, storageSet } from '../../utils';
import { writeTextFile, readTextFile } from '../../bridge/commands';
import { bus } from '../../events';
import styles from './EditorTab.module.css';

const LS_CONTENT_PREFIX = 'logtapper_scratchpad_';
const LS_MODE_PREFIX = 'logtapper_editor_mode_';
const LS_WRAP_PREFIX = 'logtapper_editor_wrap_';
const LS_FILEPATH_PREFIX = 'logtapper_editor_filepath_';

export type EditorViewMode = 'editor' | 'split' | 'preview';

interface EditorTabProps {
  tabId: string;
  isFocused?: boolean;
  onDirtyChanged?: (tabId: string, isDirty: boolean) => void;
  onFilePathChanged?: (tabId: string, newLabel: string) => void;
}

const EditorTab = React.memo(function EditorTab({
  tabId,
  isFocused = false,
  onDirtyChanged,
  onFilePathChanged,
}: EditorTabProps) {
  const [value, setValue] = useState(() => storageGet(LS_CONTENT_PREFIX + tabId));
  const [viewMode, setViewMode] = useState<EditorViewMode>(
    () => (storageGet(LS_MODE_PREFIX + tabId) as EditorViewMode) || 'editor',
  );
  const [wordWrap, setWordWrap] = useState(
    () => storageGet(LS_WRAP_PREFIX + tabId) === 'true',
  );
  const [filePath, setFilePath] = useState<string | null>(
    () => storageGet(LS_FILEPATH_PREFIX + tabId) || null,
  );
  const [isDirty, setIsDirty] = useState(false);

  const valueRef = useRef(value);
  valueRef.current = value;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const savedContentRef = useRef(value);
  const prevTabIdRef = useRef(tabId);

  // On mount, load from disk if a file path was persisted (overrides stale localStorage).
  useEffect(() => {
    const fp = filePathRef.current;
    if (fp) {
      readTextFile(fp).then(content => {
        setValue(content);
        savedContentRef.current = content;
        setIsDirty(false);
      }).catch(() => {
        // File may have been moved or deleted — fall back to localStorage content.
      });
    }
  }, [tabId]);

  // When the active editor tab switches, flush the outgoing tab's content
  // synchronously and load the new tab's content.
  useEffect(() => {
    if (prevTabIdRef.current === tabId) return;
    storageSet(LS_CONTENT_PREFIX + prevTabIdRef.current, valueRef.current);
    prevTabIdRef.current = tabId;
    const newContent = storageGet(LS_CONTENT_PREFIX + tabId);
    const newFilePath = storageGet(LS_FILEPATH_PREFIX + tabId) || null;
    setValue(newContent);
    savedContentRef.current = newContent;
    setFilePath(newFilePath);
    filePathRef.current = newFilePath;
    setIsDirty(false);
    setViewMode((storageGet(LS_MODE_PREFIX + tabId) as EditorViewMode) || 'editor');
    setWordWrap(storageGet(LS_WRAP_PREFIX + tabId) === 'true');
  }, [tabId]);

  const handleChange = useCallback((next: string) => {
    setValue(next);
    const nowDirty = next !== savedContentRef.current;
    setIsDirty(prev => prev === nowDirty ? prev : nowDirty);
  }, []);

  const handleModeChange = useCallback((mode: EditorViewMode) => {
    setViewMode(mode);
    storageSet(LS_MODE_PREFIX + tabId, mode);
  }, [tabId]);

  const handleWordWrapToggle = useCallback(() => {
    setWordWrap((prev) => {
      const next = !prev;
      storageSet(LS_WRAP_PREFIX + tabId, String(next));
      return next;
    });
  }, [tabId]);

  // Persist content to localStorage on change (debounced).
  useEffect(() => {
    const timer = setTimeout(() => {
      storageSet(LS_CONTENT_PREFIX + tabId, value);
    }, 500);
    return () => clearTimeout(timer);
  }, [tabId, value]);

  // Report dirty state changes to parent.
  useEffect(() => {
    onDirtyChanged?.(tabId, isDirty);
  }, [tabId, isDirty, onDirtyChanged]);

  const handleSaveAs = useCallback(async () => {
    const path = await save({
      filters: [
        { name: 'Text Files', extensions: ['yaml', 'yml', 'md', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (path) {
      await writeTextFile(path, valueRef.current);
      savedContentRef.current = valueRef.current;
      setFilePath(path);
      filePathRef.current = path;
      storageSet(LS_FILEPATH_PREFIX + tabId, path);
      setIsDirty(false);
      const filename = path.split(/[\\/]/).pop() || path;
      onFilePathChanged?.(tabId, filename);
    }
  }, [tabId, onFilePathChanged]);

  const handleSave = useCallback(async () => {
    if (filePathRef.current) {
      await writeTextFile(filePathRef.current, valueRef.current);
      savedContentRef.current = valueRef.current;
      setIsDirty(false);
    } else {
      await handleSaveAs();
    }
  }, [handleSaveAs]);

  // Subscribe to bus save events only when this pane is focused.
  // Use refs so the effect only re-subscribes when isFocused flips (not on every keystroke).
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  const handleSaveAsRef = useRef(handleSaveAs);
  handleSaveAsRef.current = handleSaveAs;

  useEffect(() => {
    if (!isFocused) return;
    const onSave = () => { void handleSaveRef.current(); };
    const onSaveAs = () => { void handleSaveAsRef.current(); };
    bus.on('file:save-request', onSave);
    bus.on('file:save-as-request', onSaveAs);
    return () => {
      bus.off('file:save-request', onSave);
      bus.off('file:save-as-request', onSaveAs);
    };
  }, [isFocused]);

  return (
    <div className={styles.root}>
      <EditorToolbar viewMode={viewMode} onModeChange={handleModeChange} wordWrap={wordWrap} onWordWrapToggle={handleWordWrapToggle} />
      <div className={styles.content} data-mode={viewMode}>
        {/* Keep TextEditor mounted (hidden) in preview mode to preserve CodeMirror
            undo history and avoid expensive reinit on mode switch. */}
        <div className={styles.editorPane} hidden={viewMode === 'preview'}>
          <TextEditor
            value={value}
            onChange={handleChange}
            placeholder="Start typing..."
            className={styles.editor}
            lineWrapping={wordWrap}
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
