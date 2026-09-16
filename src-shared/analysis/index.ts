/**
 * Public API of the analysis module (principle 9).
 *
 * Which session an analysis artifact belongs to (`attributeArtifact`,
 * `artifactAppliesToSession`) and the one-shot handoff that tells a freshly
 * opened reader which artifact to select.
 */
export * from './analysisAttribution';
export * from './pendingSelection';
