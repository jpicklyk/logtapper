import React, { useState, useCallback, useEffect, useRef } from 'react';
import TextEditor from '../../viewport/TextEditor';
import { storageGet, storageSet } from '../../utils';
import styles from './ScratchPad.module.css';

const LS_KEY_PREFIX = 'logtapper_scratchpad_';

interface ScratchPadProps {
  tabId: string;
}

const ScratchPad = React.memo(function ScratchPad({ tabId }: ScratchPadProps) {
  const [value, setValue] = useState(() => storageGet(LS_KEY_PREFIX + tabId));
  const valueRef = useRef(value);
  valueRef.current = value;
  const prevTabIdRef = useRef(tabId);

  // When the active scratch tab switches, flush the outgoing tab's content
  // synchronously and load the new tab's content.
  useEffect(() => {
    if (prevTabIdRef.current === tabId) return;
    // Save outgoing tab before switching
    storageSet(LS_KEY_PREFIX + prevTabIdRef.current, valueRef.current);
    prevTabIdRef.current = tabId;
    setValue(storageGet(LS_KEY_PREFIX + tabId));
  }, [tabId]);

  const handleChange = useCallback((next: string) => {
    setValue(next);
  }, []);

  // Persist to localStorage on change (debounced).
  // The tabId-switch effect above handles flushing the outgoing tab, so this
  // effect only needs to save the current tab's content on edits.
  useEffect(() => {
    const timer = setTimeout(() => {
      storageSet(LS_KEY_PREFIX + tabId, value);
    }, 500);
    return () => clearTimeout(timer);
  }, [tabId, value]);

  return (
    <div className={styles.root}>
      <TextEditor
        value={value}
        onChange={handleChange}
        placeholder="Scratch notes..."
        className={styles.editor}
      />
    </div>
  );
});

export default ScratchPad;
