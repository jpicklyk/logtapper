import React from 'react';
import { ProcessorPanel } from '../ProcessorPanel';
import { MarketplacePanel } from '../MarketplacePanel';
import { useFocusedSession } from '../../context';
import { SessionDataProvider } from '../../context/SessionDataContext';
import styles from './RightPane.module.css';

export type RightPaneTab = 'processors' | 'marketplace';

interface Props {
  activeTab: RightPaneTab;
}

const RightPane = React.memo(function RightPane({ activeTab }: Props) {
  const session = useFocusedSession();
  return (
    <SessionDataProvider sessionId={session?.sessionId ?? null}>
    <div className={styles.root}>
      {activeTab === 'processors' && <ProcessorPanel />}
      {activeTab === 'marketplace' && <MarketplacePanel />}
    </div>
    </SessionDataProvider>
  );
});

export default RightPane;
