/**
 * Public API of the analyses module (Principle 9 — import from here, never
 * from an internal file).
 */

export { createAnalysesStore } from './analysesStore';
export type {
  AnalysesStore,
  AnalysesStoreDeps,
  AnalysesCommands,
  PublishDraft,
  UpdateDraft,
} from './analysesStore';

export { AnalysesPanel } from './AnalysesPanel';
export type { AnalysesPanelProps } from './AnalysesPanel';

export { AnalysesIndex } from './AnalysesIndex';
export type { AnalysesIndexProps } from './AnalysesIndex';

export { AnalysisReader } from './AnalysisReader';
export type { AnalysisReaderProps } from './AnalysisReader';

export { AnalysisEditor } from './AnalysisEditor';
export type { AnalysisEditorProps, DraftSection } from './AnalysisEditor';
