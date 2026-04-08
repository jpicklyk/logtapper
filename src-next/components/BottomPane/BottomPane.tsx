import React from 'react';
import { StateTimeline } from '../StateTimeline';
import { CorrelationsView } from '../CorrelationsView';
import { WatchesPanel } from '../WatchesPanel';
import { useFocusedSession, SessionProviders } from '../../context';
import styles from './BottomPane.module.css';

export type BottomTabType = 'timeline' | 'correlations' | 'search-results' | 'watches' | 'filter-results';

interface Props {
  activeTab: BottomTabType;
}

const BottomPane = React.memo(function BottomPane({ activeTab }: Props) {
  const session = useFocusedSession();
  return (
    <SessionProviders sessionId={session?.sessionId ?? null}>
    <div className={styles.root}>
      {activeTab === 'timeline' && <StateTimeline />}
      {activeTab === 'correlations' && <CorrelationsView />}
      {activeTab === 'search-results' && (
        <div className={styles.placeholder}>Search results</div>
      )}
      {activeTab === 'watches' && <WatchesPanel />}
      {activeTab === 'filter-results' && (
        <div className={styles.placeholder}>Filter results</div>
      )}
    </div>
    </SessionProviders>
  );
});

export default BottomPane;
