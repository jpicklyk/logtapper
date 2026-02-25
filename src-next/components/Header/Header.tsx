import React from 'react';
import clsx from 'clsx';
import { FolderOpen, Radio } from 'lucide-react';
import { useSession, useIsStreaming, useViewerActions } from '../../context';
import { SearchBar } from '../SearchBar';
import styles from './Header.module.css';

export const Header = React.memo(function Header() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const { openFileDialog, startStream } = useViewerActions();

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.title}>
          <span className={styles.titleAndroid}>Android</span>
          {' '}Log<span className={styles.titleAccent}>Tapper</span>
        </span>
      </div>

      <div className={styles.searchArea}>
        <SearchBar disabled={!session} />
      </div>

      <div className={styles.actions}>
        <button
          className={styles.actionBtn}
          onClick={openFileDialog}
          title="Open log file"
        >
          <FolderOpen size={14} />
          <span>Open</span>
        </button>
        <button
          className={clsx(styles.actionBtn, isStreaming && styles.actionBtnActive)}
          onClick={() => startStream()}
          title="Start ADB stream"
        >
          {isStreaming ? <span className={styles.streamDot} /> : <Radio size={14} />}
          <span>Stream</span>
        </button>
      </div>
    </header>
  );
});
