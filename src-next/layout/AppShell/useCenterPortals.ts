import { useCallback, useMemo, useReducer, useRef } from 'react';
import { findTabAcrossTree, allPanes } from '../../hooks/workspace/splitTreeHelpers';
import type { SplitNode, CenterPane, WorkspaceLayoutState } from '../../hooks';

interface UseCenterPortalsParams {
  centerTree: SplitNode;
  setActiveTab: WorkspaceLayoutState['setActiveTab'];
  focusLogviewerTab: WorkspaceLayoutState['focusLogviewerTab'];
  addCenterTab: WorkspaceLayoutState['addCenterTab'];
}

export function useCenterPortals({
  centerTree,
  setActiveTab,
  focusLogviewerTab,
  addCenterTab,
}: UseCenterPortalsParams) {
  const contentRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [, forcePortals] = useReducer((x: number) => x + 1, 0);

  const centerTreeRef = useRef(centerTree);
  centerTreeRef.current = centerTree;

  const handleContentRef = useCallback((paneId: string, el: HTMLDivElement | null) => {
    if (el) {
      contentRefsRef.current.set(paneId, el);
      // Only trigger re-render when a mount div becomes available (el !== null).
      // Skipping forcePortals on null prevents PaneContent from unmounting during
      // React StrictMode's cleanup→remount cycle, which caused an apparent
      // performance regression (file reload on every initial mount).
      // The portal stays pointed at the now-detached div until the next natural
      // re-render (triggered by the subsequent el !== null callback) updates it.
      forcePortals();
    } else {
      contentRefsRef.current.delete(paneId);
    }
  }, []);

  const currentPanes: CenterPane[] = useMemo(
    () => allPanes(centerTree),
    [centerTree],
  );

  const handleTabActivate = useCallback(
    (tabId: string, paneId: string) => {
      setActiveTab(tabId, paneId);
      // Only move focus when activating a logviewer tab — utility tabs
      // (dashboard, editor) display data for the already-focused session
      // and should not steal the focus marker from the logviewer tab.
      const found = findTabAcrossTree(centerTreeRef.current, tabId);
      if (found?.tab.type === 'logviewer') {
        focusLogviewerTab(tabId, paneId);
      }
    },
    [setActiveTab, focusLogviewerTab],
  );

  const handleTabAdd = useCallback(
    (paneId: string) => {
      addCenterTab(paneId, 'editor');
    },
    [addCenterTab],
  );

  return {
    contentRefsRef,
    handleContentRef,
    currentPanes,
    handleTabActivate,
    handleTabAdd,
  };
}
