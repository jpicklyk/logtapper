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

/**
 * Accent color for the most common processor type in a group (e.g. a pack).
 * Ties break toward the first processor's type. Takes a structural type
 * (not the full `ProcessorSummary`) so this module stays free of `bridge/`
 * imports per the ui/ isolation rule.
 */
export function dominantTypeAccent(processors: Array<{ processorType: string }>): string {
  if (processors.length === 0) return PROC_TYPE_ACCENT.reporter;
  const counts = new Map<string, number>();
  for (const p of processors) {
    counts.set(p.processorType, (counts.get(p.processorType) ?? 0) + 1);
  }
  let dominant = processors[0].processorType;
  let max = 0;
  for (const [type, count] of counts) {
    if (count > max) { max = count; dominant = type; }
  }
  return PROC_TYPE_ACCENT[dominant] ?? PROC_TYPE_ACCENT.reporter;
}
