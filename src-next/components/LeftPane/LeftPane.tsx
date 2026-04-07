import React from 'react';
import { StatePanel } from '../StatePanel';
import { FileInfoPane } from '../FileInfoPanel';
import { AnalysisList } from '../AnalysisPanel';
import { BookmarkPanel } from '../BookmarkPanel';
import { useFocusedSession } from '../../context';
import { SessionDataProvider } from '../../context/SessionDataContext';
import styles from './LeftPane.module.css';

export type LeftPaneTab = 'info' | 'state' | 'bookmarks' | 'analysis';

interface Props {
  activeTab: LeftPaneTab;
  displayPaneId: string | null;
}

const LeftPane = React.memo(function LeftPane({ activeTab, displayPaneId }: Props) {
  const session = useFocusedSession();
  return (
    <SessionDataProvider sessionId={session?.sessionId ?? null}>
    <div className={styles.root}>
      {activeTab === 'info' && <FileInfoPane paneId={displayPaneId} />}
      {activeTab === 'state' && <StatePanel />}
      {activeTab === 'bookmarks' && <BookmarkPanel />}
      {activeTab === 'analysis' && <AnalysisList />}
    </div>
    </SessionDataProvider>
  );
});

export default LeftPane;
