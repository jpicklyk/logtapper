/**
 * One-shot handoff of the viewer cursor to a not-yet-mounted `AnalysisEditor`.
 *
 * "New analysis" lives in `AnalysesPanel` and reads the current cursor at click
 * time, but `AnalysisEditor` (in the shell's `details` region) only mounts
 * afterwards, so the value has to wait somewhere between the two.
 *
 * This used to be stashed in `@analysisReader/pendingSelection`, whose
 * documented contract is "pane id → **artifact id**", under a fabricated pane
 * id holding a JSON blob. It worked — both writers use explicit keys — but it
 * overloaded a shared React-owned module with a second value shape. This
 * module is the honest version: module-level, transient, consumed exactly
 * once, and owned by the package that uses it. Internal to `analyses/`; not on
 * the barrel.
 */
import type { SourceReference } from '@bridge/types';

let pending: SourceReference | null = null;

/** Stash the seed for the next editor to mount. Overwrites any unconsumed one. */
export function setDraftSeed(reference: SourceReference | null): void {
  pending = reference;
}

/** Read and clear the stashed seed. `null` when none was captured. */
export function takeDraftSeed(): SourceReference | null {
  const seed = pending;
  pending = null;
  return seed;
}
