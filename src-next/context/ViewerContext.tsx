import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { SearchQuery, SearchSummary } from '../bridge/types';

// ---------------------------------------------------------------------------
// Sub-context value types
// ---------------------------------------------------------------------------

interface SearchContextValue {
  search: SearchQuery | null;
  searchSummary: SearchSummary | null;
  currentMatchIndex: number;
  setSearch: React.Dispatch<React.SetStateAction<SearchQuery | null>>;
  setSearchSummary: React.Dispatch<React.SetStateAction<SearchSummary | null>>;
  setCurrentMatchIndex: React.Dispatch<React.SetStateAction<number>>;
}

interface ScrollContextValue {
  scrollToLine: number | null;
  jumpSeq: number;
  /** Pane ID this jump targets, or null to target the focused/all panes. */
  jumpPaneId: string | null;
  setScrollToLine: React.Dispatch<React.SetStateAction<number | null>>;
  setJumpSeq: React.Dispatch<React.SetStateAction<number>>;
  setJumpPaneId: React.Dispatch<React.SetStateAction<string | null>>;
}

interface ProcessorViewContextValue {
  processorId: string | null;
  setProcessorId: React.Dispatch<React.SetStateAction<string | null>>;
}

// Combined type for the facade hook (used by writer hooks — internal only)
interface ViewerContextValue extends SearchContextValue, ScrollContextValue, ProcessorViewContextValue {}

// ---------------------------------------------------------------------------
// Three internal sub-contexts (not exported from barrel)
// ---------------------------------------------------------------------------

const SearchCtx = createContext<SearchContextValue | null>(null);
const ScrollCtx = createContext<ScrollContextValue | null>(null);
const ProcessorViewCtx = createContext<ProcessorViewContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider — nests all 3 sub-contexts, owns all state
// ---------------------------------------------------------------------------

export function ViewerProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState<SearchQuery | null>(null);
  const [searchSummary, setSearchSummary] = useState<SearchSummary | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [jumpPaneId, setJumpPaneId] = useState<string | null>(null);
  const [processorId, setProcessorId] = useState<string | null>(null);

  const searchValue = useMemo<SearchContextValue>(() => ({
    search, searchSummary, currentMatchIndex,
    setSearch, setSearchSummary, setCurrentMatchIndex,
  }), [search, searchSummary, currentMatchIndex]);

  const scrollValue = useMemo<ScrollContextValue>(() => ({
    scrollToLine, jumpSeq, jumpPaneId,
    setScrollToLine, setJumpSeq, setJumpPaneId,
  }), [scrollToLine, jumpSeq, jumpPaneId]);

  const processorViewValue = useMemo<ProcessorViewContextValue>(() => ({
    processorId, setProcessorId,
  }), [processorId]);

  return (
    <SearchCtx.Provider value={searchValue}>
      <ScrollCtx.Provider value={scrollValue}>
        <ProcessorViewCtx.Provider value={processorViewValue}>
          {children}
        </ProcessorViewCtx.Provider>
      </ScrollCtx.Provider>
    </SearchCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Narrow hooks — used by selectors.ts for frequency-isolated reads
// ---------------------------------------------------------------------------

export function useSearchCtx(): SearchContextValue {
  const ctx = useContext(SearchCtx);
  if (!ctx) throw new Error('useSearchCtx must be used within a ViewerProvider');
  return ctx;
}

export function useScrollCtx(): ScrollContextValue {
  const ctx = useContext(ScrollCtx);
  if (!ctx) throw new Error('useScrollCtx must be used within a ViewerProvider');
  return ctx;
}

export function useProcessorViewCtx(): ProcessorViewContextValue {
  const ctx = useContext(ProcessorViewCtx);
  if (!ctx) throw new Error('useProcessorViewCtx must be used within a ViewerProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Facade — reads all 3 sub-contexts, returns combined interface.
// Used by writer hooks (useLogViewer, useSearchNavigation, useSessionTabManager)
// that need setter access across all viewer state.
// ---------------------------------------------------------------------------

export function useViewerContext(): ViewerContextValue {
  const searchCtx = useSearchCtx();
  const scrollCtx = useScrollCtx();
  const processorViewCtx = useProcessorViewCtx();
  return { ...searchCtx, ...scrollCtx, ...processorViewCtx };
}
