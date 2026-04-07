import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { useSession, useIsStreaming } from '../../context';
import { useSessionWatchActions } from '../../context/SessionActionsContext';
import { useWatches } from '../../hooks';
import type { FilterCriteria } from '../../bridge/types';
import { IconButton } from '../../ui';
import { WatchRow } from './WatchRow';
import { CreateWatchForm } from './CreateWatchForm';
import styles from './WatchesPanel.module.css';

export const WatchesPanel = React.memo(function WatchesPanel() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const { watches, refreshWatches } = useWatches();
  const { addWatch, removeWatch } = useSessionWatchActions();
  const [showCreate, setShowCreate] = useState(false);

  // Refresh watch list on session change
  useEffect(() => {
    if (session?.sessionId) {
      refreshWatches(session.sessionId);
    }
  }, [session?.sessionId, refreshWatches]);

  const [activeWatches, cancelledWatches] = useMemo(() => {
    const active = watches.filter((w) => w.active);
    const cancelled = watches.filter((w) => !w.active);
    return [active, cancelled];
  }, [watches]);

  const handleCreate = useCallback(
    async (criteria: FilterCriteria) => {
      await addWatch(criteria);
      setShowCreate(false);
    },
    [addWatch],
  );

  const handleCancel = useCallback(
    (watchId: string) => {
      removeWatch(watchId);
    },
    [removeWatch],
  );

  const handleToggleCreate = useCallback(() => {
    setShowCreate((prev) => !prev);
  }, []);

  const handleCancelCreate = useCallback(() => {
    setShowCreate(false);
  }, []);

  // Empty states
  if (!session) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <span>Open a file or start a stream to use watches</span>
        </div>
      </div>
    );
  }

  const hasWatches = watches.length > 0;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.headerLabel}>Watches</span>
          {activeWatches.length > 0 && (
            <span className={styles.watchCount}>{activeWatches.length}</span>
          )}
        </div>
        <IconButton
          icon={Plus}
          size={14}
          className={styles.addBtn}
          onClick={handleToggleCreate}
          title={showCreate ? 'Cancel' : 'Create watch'}
          disabled={!isStreaming && !session}
        />
      </div>

      <div className={styles.content}>
        {showCreate && (
          <CreateWatchForm onSubmit={handleCreate} onCancel={handleCancelCreate} />
        )}

        {!hasWatches && !showCreate && (
          <div className={styles.empty}>
            {isStreaming ? (
              <>
                <span>No watches yet</span>
                <span className={styles.emptySub}>
                  Click + to monitor patterns in the live stream
                </span>
              </>
            ) : (
              <>
                <span>Watches monitor live ADB streams</span>
                <span className={styles.emptySub}>
                  Start a stream and create watches to track patterns in real time
                </span>
              </>
            )}
          </div>
        )}

        {activeWatches.map((w) => (
          <WatchRow key={w.watchId} watch={w} onCancel={handleCancel} />
        ))}

        {cancelledWatches.length > 0 && (
          <>
            <div className={styles.sectionLabel}>Cancelled</div>
            {cancelledWatches.map((w) => (
              <WatchRow key={w.watchId} watch={w} onCancel={handleCancel} />
            ))}
          </>
        )}
      </div>
    </div>
  );
});
