import { useCallback, useState } from 'react';
import { useTogglePane } from '../useTogglePane';
import type { TogglePaneState } from '../useTogglePane';
import {
  clamp,
  MIN_LEFT_WIDTH, MAX_LEFT_WIDTH, DEFAULT_LEFT_WIDTH,
  MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH, DEFAULT_RIGHT_WIDTH,
  MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT, DEFAULT_BOTTOM_HEIGHT,
} from './index';
import type { LeftPaneTab, RightPaneTab, BottomTabType } from './workspaceTypes';
import type { PersistedState } from './workspacePersistence';

export interface PanelDimensionsHandle {
  leftPaneWidth: number;
  leftPaneTab: LeftPaneTab;
  setLeftPaneTab: (tab: LeftPaneTab) => void;
  setLeftPaneTabRaw: React.Dispatch<React.SetStateAction<LeftPaneTab>>;
  setLeftPaneWidth: React.Dispatch<React.SetStateAction<number>>;
  resizeLeftPane: (delta: number) => void;
  rightPane: TogglePaneState<RightPaneTab>;
  rightPaneWidth: number;
  setRightPaneWidth: React.Dispatch<React.SetStateAction<number>>;
  resizeRightPane: (delta: number) => void;
  bottomPane: TogglePaneState<BottomTabType>;
  bottomPaneHeight: number;
  setBottomPaneHeight: React.Dispatch<React.SetStateAction<number>>;
  resizeBottomPane: (delta: number) => void;
}

export function usePanelDimensions(saved: Partial<PersistedState>): PanelDimensionsHandle {
  // Left pane
  const [leftPaneWidth, setLeftPaneWidth] = useState(saved.leftPaneWidth ?? DEFAULT_LEFT_WIDTH);
  const [leftPaneTab, setLeftPaneTabRaw] = useState<LeftPaneTab>(saved.leftPaneTab ?? 'info');

  // Right pane
  const rightPane = useTogglePane<RightPaneTab>(
    saved.rightPaneVisible ?? false,
    saved.rightPaneTab ?? 'processors',
  );
  const [rightPaneWidth, setRightPaneWidth] = useState(saved.rightPaneWidth ?? DEFAULT_RIGHT_WIDTH);

  // Bottom pane
  const bottomPane = useTogglePane<BottomTabType>(
    saved.bottomPaneVisible ?? false,
    saved.bottomPaneTab ?? 'timeline',
  );
  const [bottomPaneHeight, setBottomPaneHeight] = useState(saved.bottomPaneHeight ?? DEFAULT_BOTTOM_HEIGHT);

  const resizeLeftPane = useCallback((delta: number) => {
    setLeftPaneWidth((prev) => clamp(prev + delta, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
  }, []);

  const resizeRightPane = useCallback((delta: number) => {
    setRightPaneWidth((prev) => clamp(prev + delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
  }, []);

  const resizeBottomPane = useCallback((delta: number) => {
    setBottomPaneHeight((prev) => clamp(prev + delta, MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT));
  }, []);

  return {
    leftPaneWidth,
    leftPaneTab,
    setLeftPaneTab: setLeftPaneTabRaw,
    setLeftPaneTabRaw,
    setLeftPaneWidth,
    resizeLeftPane,
    rightPane,
    rightPaneWidth,
    setRightPaneWidth,
    resizeRightPane,
    bottomPane,
    bottomPaneHeight,
    setBottomPaneHeight,
    resizeBottomPane,
  };
}
