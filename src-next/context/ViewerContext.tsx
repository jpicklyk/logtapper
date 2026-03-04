import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { SearchQuery, SearchSummary } from '../bridge/types';

interface ViewerState {
  search: SearchQuery | null;
  searchSummary: SearchSummary | null;
  currentMatchIndex: number;
  scrollToLine: number | null;
  jumpSeq: number;
  /** Pane ID this jump targets, or null to target the focused/all panes. */
  jumpPaneId: string | null;
  processorId: string | null;
}

interface ViewerContextValue extends ViewerState {
  setSearch: React.Dispatch<React.SetStateAction<SearchQuery | null>>;
  setSearchSummary: React.Dispatch<React.SetStateAction<SearchSummary | null>>;
  setCurrentMatchIndex: React.Dispatch<React.SetStateAction<number>>;
  setScrollToLine: React.Dispatch<React.SetStateAction<number | null>>;
  setJumpSeq: React.Dispatch<React.SetStateAction<number>>;
  setJumpPaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setProcessorId: React.Dispatch<React.SetStateAction<string | null>>;
}

const ViewerContext = createContext<ViewerContextValue | null>(null);

export function ViewerProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState<SearchQuery | null>(null);
  const [searchSummary, setSearchSummary] = useState<SearchSummary | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [jumpPaneId, setJumpPaneId] = useState<string | null>(null);
  const [processorId, setProcessorId] = useState<string | null>(null);

  const value = useMemo<ViewerContextValue>(() => ({
    search,
    searchSummary,
    currentMatchIndex,
    scrollToLine,
    jumpSeq,
    jumpPaneId,
    processorId,
    setSearch,
    setSearchSummary,
    setCurrentMatchIndex,
    setScrollToLine,
    setJumpSeq,
    setJumpPaneId,
    setProcessorId,
  }), [search, searchSummary, currentMatchIndex, scrollToLine, jumpSeq, jumpPaneId, processorId]);

  return (
    <ViewerContext.Provider value={value}>
      {children}
    </ViewerContext.Provider>
  );
}

export function useViewerContext(): ViewerContextValue {
  const ctx = useContext(ViewerContext);
  if (!ctx) {
    throw new Error('useViewerContext must be used within a ViewerProvider');
  }
  return ctx;
}
