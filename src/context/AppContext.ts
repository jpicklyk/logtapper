import { createContext, useContext } from 'react';
import type { useLogViewer } from '../hooks/useLogViewer';
import type { usePipeline } from '../hooks/usePipeline';
import type { useStateTracker } from '../hooks/useStateTracker';
import type { DumpstateMetadata } from '../bridge/types';
import type { SectionEntry } from '../components/FileInfoPanel';

export interface AppContextValue {
  viewer: ReturnType<typeof useLogViewer>;
  pipeline: ReturnType<typeof usePipeline>;
  stateTracker: ReturnType<typeof useStateTracker>;
  metadata: DumpstateMetadata | null;
  processorViewId: string | null;
  sections: SectionEntry[];
  activeSectionIndex: number;
  onViewProcessor: (id: string) => void;
  onClearProcessorView: () => void;
  onOpenLibrary: () => void;
  selectedLineNum: number | null;
  setSelectedLineNum: (n: number | null) => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used inside AppContext.Provider');
  return ctx;
}
