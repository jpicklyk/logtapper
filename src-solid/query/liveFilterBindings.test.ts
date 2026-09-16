import { describe, expect, it, vi } from 'vitest';
import type { FilterNode } from '@filter/index';
import { createLiveFilterBindings } from './liveFilterBindings';
import type { LiveFilterTarget } from './liveFilterBindings';

function fakeScan(ast: FilterNode | null, pids = new Map<string, number[]>()) {
  const appended: number[][] = [];
  const target: LiveFilterTarget = {
    currentFilter: () => ({ ast, packagePids: pids }),
    appendMatches: (lineNums) => { appended.push(lineNums); },
  };
  return { target, appended };
}

/** A minimal AST stand-in — nothing here inspects its shape. */
function ast(value: string): FilterNode {
  return { kind: 'field', field: 'tag', value } as FilterNode;
}

describe('createLiveFilterBindings', () => {
  it('resolves the capturing session\'s own scan, not whichever pane bound last (H4)', () => {
    let live: string | null = 'live';
    const bindings = createLiveFilterBindings(() => live);
    const liveScan = fakeScan(ast('ActivityManager'));
    const otherScan = fakeScan(ast('OtherPane'));

    // The live pane binds first, then a split opens on a second session —
    // the order that used to leave the capture unmatched.
    bindings.bind('live', liveScan.target);
    bindings.bind('other', otherScan.target);

    expect(bindings.hooks.filterSessionId()).toBe('live');
    expect(bindings.hooks.filterAst()).toBe(liveScan.target.currentFilter().ast);

    bindings.hooks.appendFilterMatches('live', [1, 2]);
    expect(liveScan.appended).toEqual([[1, 2]]);
    expect(otherScan.appended).toEqual([]);

    // And if the capture moves, resolution follows it with no rebinding.
    live = 'other';
    expect(bindings.hooks.filterSessionId()).toBe('other');
    expect(bindings.hooks.filterAst()).toBe(otherScan.target.currentFilter().ast);
  });

  it('reports no filter while the capturing session has no bar mounted', () => {
    const bindings = createLiveFilterBindings(() => 'live');
    const otherScan = fakeScan(ast('OtherPane'));
    bindings.bind('other', otherScan.target);

    // A bar exists, but not for the session producing batches: matching must
    // be skipped entirely rather than fall through to the other session's AST.
    expect(bindings.hooks.filterSessionId()).toBeNull();
    expect(bindings.hooks.filterAst()).toBeNull();
    expect(bindings.hooks.packagePids().size).toBe(0);
  });

  it('reports no filter when nothing is capturing', () => {
    const bindings = createLiveFilterBindings(() => null);
    bindings.bind('s1', fakeScan(ast('Anything')).target);

    expect(bindings.hooks.filterSessionId()).toBeNull();
    expect(bindings.hooks.filterAst()).toBeNull();
  });

  it('unbinding one pane leaves every other pane\'s binding intact', () => {
    const bindings = createLiveFilterBindings(() => 'live');
    const liveScan = fakeScan(ast('ActivityManager'));
    const otherScan = fakeScan(ast('OtherPane'));

    bindings.bind('live', liveScan.target);
    const unbindOther = bindings.bind('other', otherScan.target);

    // Closing the split must not disturb the capture's binding — the old
    // single-signal version cleared it to null instead.
    unbindOther();

    expect(bindings.boundSessions()).toEqual(['live']);
    expect(bindings.hooks.filterSessionId()).toBe('live');
    expect(bindings.hooks.filterAst()).toBe(liveScan.target.currentFilter().ast);
  });

  it('a superseded pane\'s late unbind cannot clobber the binding that replaced it', () => {
    const bindings = createLiveFilterBindings(() => 'live');
    const first = fakeScan(ast('First'));
    const second = fakeScan(ast('Second'));

    const unbindFirst = bindings.bind('live', first.target);
    bindings.bind('live', second.target); // a remount for the same session
    unbindFirst(); // the old instance's cleanup, running after

    expect(bindings.hooks.filterSessionId()).toBe('live');
    bindings.hooks.appendFilterMatches('live', [7]);
    expect(second.appended).toEqual([[7]]);
    expect(first.appended).toEqual([]);
  });

  it('routes appended matches by the batch\'s session id only', () => {
    const bindings = createLiveFilterBindings(() => 'live');
    const liveScan = fakeScan(ast('ActivityManager'));
    bindings.bind('live', liveScan.target);

    // An id nothing is bound for is silently dropped, never misrouted.
    expect(() => bindings.hooks.appendFilterMatches('ghost', [1])).not.toThrow();
    expect(liveScan.appended).toEqual([]);
  });

  it('exposes the live scan\'s resolved package pids', () => {
    const pids = new Map<string, number[]>([['com.example', [42]]]);
    const bindings = createLiveFilterBindings(() => 'live');
    bindings.bind('live', fakeScan(ast('x'), pids).target);

    expect(bindings.hooks.packagePids()).toBe(pids);
  });

  it('a bound scan with no committed expression reports a null ast', () => {
    const bindings = createLiveFilterBindings(() => 'live');
    const idle = fakeScan(null);
    bindings.bind('live', idle.target);

    // The session id still resolves (a bar IS mounted), but there is nothing
    // to match against — `createStreamSession` checks the ast first.
    expect(bindings.hooks.filterSessionId()).toBe('live');
    expect(bindings.hooks.filterAst()).toBeNull();
  });

  it('reads liveSessionId fresh on every call, never caching it', () => {
    const liveSessionId = vi.fn(() => 'live');
    const bindings = createLiveFilterBindings(liveSessionId);
    bindings.bind('live', fakeScan(ast('x')).target);

    bindings.hooks.filterAst();
    bindings.hooks.filterSessionId();
    bindings.hooks.packagePids();

    expect(liveSessionId).toHaveBeenCalledTimes(3);
  });
});
