/**
 * Public API of the fileinfo module (principle 9).
 *
 * Bugreport section-tree shaping (filter, prefix grouping), the human-readable
 * description for a known section name, the reopen-as source-type options, and
 * the timestamp/duration formatters the file-info surfaces render.
 */
export * from './sectionTree';
export * from './formatters';
export * from './sectionDescriptions';
export * from './reopenOptions';
