/**
 * Module-level singleton that tracks the last-known virtualBase scroll
 * position for each session.
 *
 * Storing this outside React means any LogViewer in any pane — including
 * fresh mounts after a drag-to-new-pane — can restore a session's position
 * without needing a shared context or prop-drilling.
 *
 * Not React state: reads/writes never cause re-renders.
 */
const positions = new Map<string, number>();

export const sessionScrollPositions = {
  get: (sessionId: string): number => positions.get(sessionId) ?? 0,
  set: (sessionId: string, base: number): void => { positions.set(sessionId, base); },
  delete: (sessionId: string): void => { positions.delete(sessionId); },
};
