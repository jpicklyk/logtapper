/**
 * Shared processor type display labels.
 * Import this instead of defining local PROC_TYPE_LABEL / PROC_TYPE_LABELS maps.
 */
export const PROC_TYPE_LABELS: Record<string, string> = {
  reporter: 'Reporter',
  state_tracker: 'StateTracker',
  correlator: 'Correlator',
  transformer: 'Transformer',
  annotator: 'Annotator',
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
  annotator: 'typeAnnotator',
};
