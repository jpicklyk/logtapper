import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { SearchQuery, SearchSummary } from '../bridge/types';

interface ViewerState {
  search: SearchQuery | null;
  searchSummary: SearchSummary | null;
  currentMatchIndex: number;
  scrollToLine: number | null;
  jumpSeq: number;
  processorId: string | null;
  streamFilter: string;
  timeFilterStart: string;
  timeFilterEnd: string;
}

interface ViewerContextValue extends ViewerState {
  setSearch: React.Dispatch<React.SetStateAction<SearchQuery | null>>;
  setSearchSummary: React.Dispatch<React.SetStateAction<SearchSummary | null>>;
  setCurrentMatchIndex: React.Dispatch<React.SetStateAction<number>>;
  setScrollToLine: React.Dispatch<React.SetStateAction<number | null>>;
  setJumpSeq: React.Dispatch<React.SetStateAction<number>>;
  setProcessorId: React.Dispatch<React.SetStateAction<string | null>>;
  setStreamFilter: React.Dispatch<React.SetStateAction<string>>;
  setTimeFilterStart: React.Dispatch<React.SetStateAction<string>>;
  setTimeFilterEnd: React.Dispatch<React.SetStateAction<string>>;
}

const ViewerContext = createContext<ViewerContextValue | null>(null);

export function ViewerProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState<SearchQuery | null>(null);
  const [searchSummary, setSearchSummary] = useState<SearchSummary | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [processorId, setProcessorId] = useState<string | null>(null);
  const [streamFilter, setStreamFilter] = useState('');
  const [timeFilterStart, setTimeFilterStart] = useState('');
  const [timeFilterEnd, setTimeFilterEnd] = useState('');

  const value = useMemo<ViewerContextValue>(() => ({
    search,
    searchSummary,
    currentMatchIndex,
    scrollToLine,
    jumpSeq,
    processorId,
    streamFilter,
    timeFilterStart,
    timeFilterEnd,
    setSearch,
    setSearchSummary,
    setCurrentMatchIndex,
    setScrollToLine,
    setJumpSeq,
    setProcessorId,
    setStreamFilter,
    setTimeFilterStart,
    setTimeFilterEnd,
  }), [search, searchSummary, currentMatchIndex, scrollToLine, jumpSeq,
       processorId, streamFilter, timeFilterStart, timeFilterEnd]);

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
