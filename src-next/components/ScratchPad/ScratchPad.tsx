import React, { useState, useCallback, useEffect } from 'react';
import TextEditor from '../../viewport/TextEditor';
import styles from './ScratchPad.module.css';

const LS_KEY = 'logtapper_scratchpad';

function loadSavedText(): string {
  try {
    return localStorage.getItem(LS_KEY) ?? '';
  } catch {
    return '';
  }
}

const ScratchPad = React.memo(function ScratchPad() {
  const [value, setValue] = useState(loadSavedText);

  const handleChange = useCallback((next: string) => {
    setValue(next);
  }, []);

  // Persist to localStorage on change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, value);
      } catch {
        // storage full
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [value]);

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
