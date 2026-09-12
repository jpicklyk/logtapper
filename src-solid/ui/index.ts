/**
 * Public API of the shared leaf widgets.
 *
 * Everything outside `src-solid/ui/` imports from this barrel only; files
 * inside it import each other directly.
 */
export { CallerBadge, normalizeCaller, callerClient } from './CallerBadge';
export type { CallerBadgeProps, CallerKind, CallerLike } from './CallerBadge';
