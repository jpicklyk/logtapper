/**
 * Public API of the devicestate module (Principle 9 — import from here, never
 * from an internal file).
 */

export { createDeviceStateStore, diffSnapshotFields, SNAPSHOT_DEBOUNCE_MS } from './deviceStateStore';
export type {
  DeviceStateStore,
  DeviceStateStoreDeps,
  DeviceStateSessions,
  DeviceStateController,
  DeviceStateAnalyzers,
  DeviceStateCommands,
  TransitionPosition,
  TrackerTimelineTrack,
} from './deviceStateStore';

export { DeviceStatePanel } from './DeviceStatePanel';
export type { DeviceStatePanelProps } from './DeviceStatePanel';

export { TimelineStrip } from './TimelineStrip';
export type { TimelineStripProps } from './TimelineStrip';
