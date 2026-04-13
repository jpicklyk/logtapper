import { useEffect, useMemo, useState } from 'react';
import { Eye, Clock, Zap, Cpu, Store } from 'lucide-react';
import { onWatchMatch } from '../../bridge/events';
import { usePendingUpdateCount } from '../../context';
import type { BottomTabType } from '../../hooks';

const LEFT_BOTTOM_ITEMS_STATIC = [
  { id: 'timeline', icon: Clock, label: 'Timeline' },
  { id: 'correlations', icon: Zap, label: 'Correlations' },
];

interface UseToolbarItemsParams {
  bottomPaneVisible: boolean;
  bottomPaneTab: BottomTabType;
}

export function useToolbarItems({ bottomPaneVisible, bottomPaneTab }: UseToolbarItemsParams) {
  const [watchBadge, setWatchBadge] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    onWatchMatch((event) => {
      if (cancelled) return;
      setWatchBadge((prev) => prev + event.newMatches);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Clear badge when watches tab is visible
  useEffect(() => {
    if (bottomPaneVisible && bottomPaneTab === 'watches') {
      setWatchBadge(0);
    }
  }, [bottomPaneVisible, bottomPaneTab]);

  const updateBadgeCount = usePendingUpdateCount();

  const leftBottomItems = useMemo(
    () => [
      ...LEFT_BOTTOM_ITEMS_STATIC,
      { id: 'watches', icon: Eye, label: 'Watches', badge: watchBadge > 0 ? watchBadge : undefined },
    ],
    [watchBadge],
  );

  const rightTopItems = useMemo(
    () => [
      { id: 'processors', icon: Cpu, label: 'Processors' },
      { id: 'marketplace', icon: Store, label: 'Marketplace', badge: updateBadgeCount > 0 ? updateBadgeCount : undefined },
    ],
    [updateBadgeCount],
  );

  return { leftBottomItems, rightTopItems };
}
