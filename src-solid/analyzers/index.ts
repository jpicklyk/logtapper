/**
 * Public API of the Solid analyzers module.
 *
 * Everything outside `src-solid/analyzers/` imports from this barrel only.
 */

export { createAnalyzerStore, MATCHED_PREVIEW_CAP, PII_ANONYMIZER_ID, PINNED_TAIL_IDS } from './analyzerStore';
export type {
  AnalyzerStore,
  MatchedLineDigest,
  AnalyzerStoreDeps,
  AnalyzerSessions,
  AnalyzerController,
  AnalyzerCommands,
  AnalyzerProgress,
  SessionChainSnapshot,
  PipelineChainSnapshot,
  RestoredChain,
} from './analyzerStore';

// Var-rendering helpers for W4b's `AnalyzerDetail` (`getProcessorVars` results),
// reused verbatim from the one framework-free file in `ProcessorDashboard/` —
// re-exported here so W4b needs no `@procdash` import of its own.
export {
  isNumeric,
  isRankedObject,
  groupVars,
  snakeToTitle,
  splitValueDesc,
  formatNumber,
} from '@processors';
export type { VarGroup } from '@processors';

// W4b — the analyzers surface: cards, detail drawer, add-analyzer catalog.
export { AnalyzersPanel } from './AnalyzersPanel';
export type { AnalyzersPanelProps } from './AnalyzersPanel';
export { AnalyzerCard } from './AnalyzerCard';
export type { AnalyzerCardProps, AnonymizerControlBinding } from './AnalyzerCard';
// The anonymizer mode's labels and one-line consequences live with the control
// that writes the mode; Settings → PII mirrors them read-only.
export {
  AGENTS_READ_RAW_WARNING,
  ANONYMIZER_MODE_OPTIONS,
  AnonymizerModeControl,
  anonymizerModeDescription,
  anonymizerModeLabel,
} from './AnonymizerModeControl';
export type { AnonymizerModeControlProps } from './AnonymizerModeControl';
export { AnalyzerDetail } from './AnalyzerDetail';
export type { AnalyzerDetailProps } from './AnalyzerDetail';
export { AddAnalyzer } from './AddAnalyzer';
export type { AddAnalyzerProps } from './AddAnalyzer';
