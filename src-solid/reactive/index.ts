/**
 * Public API of `src-solid/reactive/`: shared reactive primitives factored
 * out of the store-level "supersede stale async work" and "coalesce a burst
 * of events" patterns so a new store never has to roll its own.
 *
 * Everything outside this directory imports from this barrel only. Inside
 * the module, files import each other directly.
 *
 * Neither primitive owns a `createRoot` or reads/writes Solid signals — both
 * are plain, owner-free factories safe to construct anywhere (a store's
 * top-level scope, inside a `createRoot`, or a per-item runtime object
 * created on demand).
 */

export { createGenerationGuard } from './generationGuard';
export type { GenerationGuard } from './generationGuard';

export { coalesceMicrotask } from './coalesceMicrotask';
