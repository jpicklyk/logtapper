import React from 'react';
import clsx from 'clsx';
import { FolderOpen, Radio } from 'lucide-react';
import { useSession, useIsStreaming } from '../../context/selectors';
import { SearchBar } from '../SearchBar';
import styles from './Header.module.css';

interface HeaderProps {
  onOpenFile?: () => void;
  onStartStream?: () => void;
  onTimeFilter?: (start: string, end: string) => void;
  timeStart?: string;
  timeEnd?: string;
  timeFilterCount?: number | null;
}

export const Header = React.memo<HeaderProps>(function Header({
  onOpenFile,
  onStartStream,
  onTimeFilter,
  timeStart,
  timeEnd,
  timeFilterCount,
}) {
  const session = useSession();
  const isStreaming = useIsStreaming();

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.title}>LogTapper</span>
      </div>

      <div className={styles.actions}>
        <button
          className={styles.actionBtn}
          onClick={onOpenFile}
          title="Open log file"
        >
          <FolderOpen size={14} />
          <span>Open</span>
        </button>
        <button
          className={clsx(styles.actionBtn, isStreaming && styles.actionBtnActive)}
          onClick={onStartStream}
          title="Start ADB stream"
        >
          <Radio size={14} />
          <span>Stream</span>
        </button>
      </div>

      <div className={styles.searchArea}>
        <SearchBar
          disabled={!session}
          onTimeFilter={onTimeFilter}
          timeStart={timeStart}
          timeEnd={timeEnd}
          timeFilterCount={timeFilterCount}
        />
      </div>
    </header>
  );
});
