/**
 * Public API of `src-solid/presence/`.
 *
 * Everything outside this directory imports from this barrel only. Internal
 * files (`orbGeometry.ts`, `agentState.ts`, `Orb.tsx`) import each other
 * directly.
 *
 * A1 shipped the orb component and the state-derivation logic; A2 added the
 * live wiring (`presenceStore.ts`) and the two surfaces around it
 * (`ActivityFeed`, `PresencePanel`). `App.tsx` builds exactly one store and
 * hands the panel to the shell's `presence` slot.
 */

export { Orb } from './Orb';
export type { OrbProps } from './Orb';

export {
  createAgentState,
  DETACHED_IDLE_THRESHOLD_SEC,
  HOLD_MS,
  WORKING_DECAY_MS,
  WROTE_FLASH_MS,
  IN_FLIGHT_STALE_MS,
} from './agentState';
export type { AgentOrbState, AgentBridgeStatus, AgentStateInputs, AgentStateController } from './agentState';

export { generateOrbGeometry, detailCounts, ringSpecs, orbColorToken } from './orbGeometry';
export type { OrbGeometry, OrbNode, OrbEdge, OrbRing, OrbExit, RingSpec, EdgeTier } from './orbGeometry';

export {
  createPresenceStore,
  MAX_JOURNAL_ENTRIES,
  NAV_CONFIRM_STORAGE_KEY,
  STATUS_POLL_MS,
  STATUS_REFRESH_DEBOUNCE_MS,
} from './presenceStore';
export type {
  NavTarget,
  NavResolution,
  PresenceStore,
  PresenceStoreOptions,
} from './presenceStore';

export { ActivityFeed } from './ActivityFeed';
export type { ActivityFeedProps } from './ActivityFeed';

export { PresencePanel } from './PresencePanel';
export type { PresencePanelProps } from './PresencePanel';
