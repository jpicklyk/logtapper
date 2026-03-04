import React from 'react';
import { ProcessorPanel } from '../ProcessorPanel';
import { MarketplacePanel } from '../MarketplacePanel';
import styles from './RightPane.module.css';

export type RightPaneTab = 'processors' | 'marketplace';

interface Props {
  activeTab: RightPaneTab;
}

const RightPane = React.memo(function RightPane({ activeTab }: Props) {
  return (
    <div className={styles.root}>
      {activeTab === 'processors' && <ProcessorPanel />}
      {activeTab === 'marketplace' && <MarketplacePanel />}
    </div>
  );
});

export default RightPane;
