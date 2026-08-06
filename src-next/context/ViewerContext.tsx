import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Sub-context value types
// ---------------------------------------------------------------------------

interface ScrollContextValue {
  scrollToLine: number | null;
  jumpSeq: number;
  /** Pane ID this jump targets, or null to target the focused/all panes. */
  jumpPaneId: string | null;
  /** Session ID this jump targets. When set it takes precedence over
   *  `jumpPaneId` — only the viewer hosting that session honours the jump.
   *  Session-scoped panels (dashboard, bookmarks, timeline, correlations,
   *  analyses) target by session so a jump never moves the other pane. */
  jumpSessionId: string | null;
  setScrollToLine: React.Dispatch<React.SetStateAction<number | null>>;
  setJumpSeq: React.Dispatch<React.SetStateAction<number>>;
  setJumpPaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setJumpSessionId: React.Dispatch<React.SetStateAction<string | null>>;
}

interface ProcessorViewContextValue {
  processorId: string | null;
  setProcessorId: React.Dispatch<React.SetStateAction<string | null>>;
}

// Combined type for the facade hook (used by writer hooks — internal only)
interface ViewerContextValue extends ScrollContextValue, ProcessorViewContextValue {}

// ---------------------------------------------------------------------------
// Two internal sub-contexts (not exported from barrel)
//
// Search state is NOT here — it is per-pane and lives in PaneSearchContext.
// A global SearchCtx existed until the per-pane migration; it survived as a
// write-only store (every setter had callers, no reader did) and was removed.
// ---------------------------------------------------------------------------

const ScrollCtx = createContext<ScrollContextValue | null>(null);
const ProcessorViewCtx = createContext<ProcessorViewContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider — nests both sub-contexts, owns all state
// ---------------------------------------------------------------------------

export function ViewerProvider({ children }: { children: ReactNode }) {
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [jumpPaneId, setJumpPaneId] = useState<string | null>(null);
  const [jumpSessionId, setJumpSessionId] = useState<string | null>(null);
  const [processorId, setProcessorId] = useState<string | null>(null);

  const scrollValue = useMemo<ScrollContextValue>(() => ({
    scrollToLine, jumpSeq, jumpPaneId, jumpSessionId,
    setScrollToLine, setJumpSeq, setJumpPaneId, setJumpSessionId,
  }), [scrollToLine, jumpSeq, jumpPaneId, jumpSessionId]);

  const processorViewValue = useMemo<ProcessorViewContextValue>(() => ({
    processorId, setProcessorId,
  }), [processorId]);

  return (
    <ScrollCtx.Provider value={scrollValue}>
      <ProcessorViewCtx.Provider value={processorViewValue}>
        {children}
      </ProcessorViewCtx.Provider>
    </ScrollCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Narrow hooks — used by selectors.ts for frequency-isolated reads
// ---------------------------------------------------------------------------

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
// Facade — reads both sub-contexts, returns combined interface.
// Used by writer hooks (useLogViewer, useSearchNavigation, useSessionTabManager)
// that need setter access across all viewer state.
// ---------------------------------------------------------------------------

export function useViewerContext(): ViewerContextValue {
  const scrollCtx = useScrollCtx();
  const processorViewCtx = useProcessorViewCtx();
  return { ...scrollCtx, ...processorViewCtx };
}
