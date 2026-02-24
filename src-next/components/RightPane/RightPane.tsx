import React from 'react';
import { ProcessorPanel } from '../ProcessorPanel';
import styles from './RightPane.module.css';

export type RightPaneTab = 'processors' | 'marketplace';

interface Props {
  activeTab: RightPaneTab;
}

const RightPane = React.memo(function RightPane({ activeTab }: Props) {
  return (
    <div className={styles.root}>
      {activeTab === 'processors' && <ProcessorPanel />}
      {activeTab === 'marketplace' && (
        <div className={styles.placeholder}>Processor marketplace</div>
      )}
    </div>
  );
});

export default RightPane;
