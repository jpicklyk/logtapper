/**
 * Public API of `src-solid/presence/`.
 *
 * Everything outside this directory imports from this barrel only. Internal
 * files (`orbGeometry.ts`, `agentState.ts`, `Orb.tsx`) import each other
 * directly.
 *
 * This package (A1) ships the orb component and the state-derivation logic
 * only. Wiring it to live bridge data — `getActivity`/`onActivity`,
 * `onNavigateRequest`, `getMcpStatus`/`onFocusChanged`, and the
 * `ActivityFeed`/`PresencePanel` UI around it — is A2's job.
 */

export { Orb } from './Orb';
export type { OrbProps } from './Orb';

export {
  createAgentState,
  DETACHED_IDLE_THRESHOLD_SEC,
  HOLD_MS,
  DECAY_MS,
} from './agentState';
export type { AgentOrbState, AgentBridgeStatus, AgentStateInputs, AgentStateController } from './agentState';

export { generateOrbGeometry, detailCounts, ringSpecs, orbColorToken } from './orbGeometry';
export type { OrbGeometry, OrbNode, OrbEdge, OrbRing, OrbExit, RingSpec, EdgeTier } from './orbGeometry';
