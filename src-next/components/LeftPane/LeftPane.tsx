import React from 'react';
import { StatePanel } from '../StatePanel';
import { FileInfoPane } from '../FileInfoPanel';
import styles from './LeftPane.module.css';

export type LeftPaneTab = 'info' | 'state' | 'bookmarks' | 'analysis';

interface Props {
  activeTab: LeftPaneTab;
}

const LeftPane = React.memo(function LeftPane({ activeTab }: Props) {
  return (
    <div className={styles.root}>
      {activeTab === 'info' && <FileInfoPane />}
      {activeTab === 'state' && <StatePanel />}
      {activeTab === 'bookmarks' && (
        <div className={styles.placeholder}>Bookmarks</div>
      )}
      {activeTab === 'analysis' && (
        <div className={styles.placeholder}>Analysis</div>
      )}
    </div>
  );
});

export default LeftPane;
