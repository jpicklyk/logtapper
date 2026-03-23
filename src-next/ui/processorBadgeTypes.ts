/**
 * Shared processor type display labels.
 * Import this instead of defining local PROC_TYPE_LABEL / PROC_TYPE_LABELS maps.
 */
export const PROC_TYPE_LABELS: Record<string, string> = {
  reporter: 'Reporter',
  state_tracker: 'StateTracker',
  correlator: 'Correlator',
  transformer: 'Transformer',
};

/**
 * CSS class key suffix for each processor type.
 * Maps type → class name (key in processorBadge.module.css).
 * Usage: badgeCss[PROC_TYPE_CLASS_KEY[type]] ?? ''
 */
export const PROC_TYPE_CLASS_KEY: Record<string, string> = {
  reporter: 'typeReporter',
  state_tracker: 'typeTracker',
  correlator: 'typeCorrelator',
  transformer: 'typeTransformer',
};

/** Human-readable descriptions for each processor type. */
export const PROC_TYPE_DESCRIPTIONS: Record<string, string> = {
  reporter: 'Searches and extracts data from log lines',
  state_tracker: 'Tracks state transitions over time',
  correlator: 'Correlates events across log sources',
  transformer: 'Filters or transforms log lines before analysis',
};

/** CSS variable accent color for each processor type. */
export const PROC_TYPE_ACCENT: Record<string, string> = {
  reporter: 'var(--proc-reporter)',
  state_tracker: 'var(--proc-tracker)',
  correlator: 'var(--proc-correlator)',
  transformer: 'var(--proc-transformer)',
};

/** Returns [displayLabel, cssClassKey] for a given processor type. */
export function getProcTypeMeta(type: string): [string, string] {
  return [
    PROC_TYPE_LABELS[type] ?? type,
    PROC_TYPE_CLASS_KEY[type] ?? '',
  ];
}
