import { describe, it, expect } from 'vitest';
import { collectSessionsToClose } from './sessionEnumeration';

/**
 * Regression tests for `closeAllSessions` completeness (item
 * 6b9d644c-eff7-486c-982f-9034b3e7f84f — CLOSE HOLE / secondary gap).
 *
 * `paneSessionMap` holds only each pane's ACTIVE tab session; a pane with
 * multiple open tabs has additional sessions reachable only through the full
 * `sessions` map. Before the fix, `closeAllSessions` iterated
 * `paneSessionMap` keys alone, so inactive tabs' backend sessions were never
 * closed on a workspace teardown — leaked invisibly.
 */
describe('collectSessionsToClose', () => {
  it('returns pane ids for every pane with an active session', () => {
    const paneSessionMap = new Map([
      ['pane-1', 'session-A'],
      ['pane-2', 'session-B'],
    ]);
    const sessions = new Map([
      ['session-A', {}],
      ['session-B', {}],
    ]);
    const { paneIds } = collectSessionsToClose(paneSessionMap, sessions);
    expect(paneIds.sort()).toEqual(['pane-1', 'pane-2']);
  });

  it('finds no inactive sessions when every registered session is some pane\'s active tab', () => {
    const paneSessionMap = new Map([['pane-1', 'session-A']]);
    const sessions = new Map([['session-A', {}]]);
    const { inactiveSessionIds } = collectSessionsToClose(paneSessionMap, sessions);
    expect(inactiveSessionIds).toEqual([]);
  });

  it('finds a session with no owning pane (inactive tab) — the leak this fix closes', () => {
    // pane-1 has two open tabs: session-A (active) and session-B (a second,
    // inactive tab). Only session-A is reachable via paneSessionMap.
    const paneSessionMap = new Map([['pane-1', 'session-A']]);
    const sessions = new Map([
      ['session-A', {}],
      ['session-B', {}],
    ]);
    const { paneIds, inactiveSessionIds } = collectSessionsToClose(paneSessionMap, sessions);
    expect(paneIds).toEqual(['pane-1']);
    expect(inactiveSessionIds).toEqual(['session-B']);
  });

  it('finds multiple inactive sessions across multiple panes', () => {
    const paneSessionMap = new Map([
      ['pane-1', 'session-A'],
      ['pane-2', 'session-C'],
    ]);
    const sessions = new Map([
      ['session-A', {}], // pane-1 active
      ['session-B', {}], // pane-1 inactive tab
      ['session-C', {}], // pane-2 active
      ['session-D', {}], // pane-2 inactive tab
    ]);
    const { inactiveSessionIds } = collectSessionsToClose(paneSessionMap, sessions);
    expect(inactiveSessionIds.sort()).toEqual(['session-B', 'session-D']);
  });

  it('handles an empty workspace (no panes, no sessions)', () => {
    const result = collectSessionsToClose(new Map(), new Map());
    expect(result.paneIds).toEqual([]);
    expect(result.inactiveSessionIds).toEqual([]);
  });

  it('a session with no pane at all (e.g. never activated) still counts as inactive', () => {
    const paneSessionMap = new Map<string, string>();
    const sessions = new Map([['session-orphan', {}]]);
    const { inactiveSessionIds } = collectSessionsToClose(paneSessionMap, sessions);
    expect(inactiveSessionIds).toEqual(['session-orphan']);
  });
});
