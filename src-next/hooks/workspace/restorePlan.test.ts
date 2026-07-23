import { describe, it, expect } from 'vitest';
import { planStartupRestore, planExplicitOpen, buildRestoreOutcomes, type StoredTab } from './restorePlan';
import { pairArtifactsWithSessions } from './artifactPairing';
import type { LtwManifestSession, LoadWorkspaceSessionData } from '../../bridge/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function session(filePath: string): LtwManifestSession {
  return { filePath, sourceName: filePath.split(/[\\/]/).pop() ?? filePath, sourceType: 'Logcat' };
}

function data(tag: string): LoadWorkspaceSessionData {
  // `tag` makes each data object identifiable in assertions.
  return {
    bookmarks: [{ id: tag } as unknown as LoadWorkspaceSessionData['bookmarks'][number]],
    analyses: [],
    activeProcessorIds: [tag],
    disabledProcessorIds: [],
  };
}

function tab(tabId: string, paneId: string, isActive = false): StoredTab {
  return { tabId, paneId, isActive };
}

// ---------------------------------------------------------------------------
// planStartupRestore — union / dedup / ordering
// ---------------------------------------------------------------------------

describe('planStartupRestore', () => {
  it('manifest ⊂ tabs — extra stored tabs are appended as dataIndex:null with a warning', () => {
    const plan = planStartupRestore({
      sessions: [session('/a.log')],
      storedTabs: [tab('t1', 'p1'), tab('t2', 'p1')],
      tabPaths: { t1: '/a.log', t2: '/b.log' },
      hasLocalLayout: true,
    });

    // /a.log matched to t1 (dataIndex 0, existingTabId t1); /b.log is an extra.
    const a = plan.loads.find((l) => l.path === '/a.log')!;
    const b = plan.loads.find((l) => l.path === '/b.log')!;
    expect(a).toMatchObject({ path: '/a.log', paneId: 'p1', existingTabId: 't1', dataIndex: 0 });
    expect(b).toMatchObject({ path: '/b.log', paneId: 'p1', existingTabId: 't2', dataIndex: null });
    expect(plan.warnings.some((w) => w.includes('/b.log'))).toBe(true);
  });

  it('tabs ⊂ manifest — matched entry uses existingTabId, unmatched entry loads fresh', () => {
    const plan = planStartupRestore({
      sessions: [session('/a.log'), session('/b.log')],
      storedTabs: [tab('t1', 'p1', true)],
      tabPaths: { t1: '/a.log' },
      hasLocalLayout: true,
    });

    const a = plan.loads.find((l) => l.path === '/a.log')!;
    const b = plan.loads.find((l) => l.path === '/b.log')!;
    // matched → its persisted tab; unmatched → fresh (no pane/tab), keeps its dataIndex
    expect(a).toMatchObject({ existingTabId: 't1', paneId: 'p1', dataIndex: 0 });
    expect(b.existingTabId).toBeUndefined();
    expect(b.paneId).toBeUndefined();
    expect(b.dataIndex).toBe(1);
    // no "extra tab" warning: every stored tab was claimed
    expect(plan.warnings).toHaveLength(0);
  });

  it('disjoint — all manifest entries fresh, all stored tabs extra', () => {
    const plan = planStartupRestore({
      sessions: [session('/a.log')],
      storedTabs: [tab('t1', 'p1')],
      tabPaths: { t1: '/z.log' },
      hasLocalLayout: true,
    });

    const a = plan.loads.find((l) => l.path === '/a.log')!;
    const z = plan.loads.find((l) => l.path === '/z.log')!;
    expect(a.existingTabId).toBeUndefined();
    expect(a.dataIndex).toBe(0);
    expect(z).toMatchObject({ existingTabId: 't1', dataIndex: null });
  });

  it('duplicate paths — a second manifest entry claims the second matching stored tab', () => {
    const plan = planStartupRestore({
      sessions: [session('/dup.log'), session('/dup.log')],
      storedTabs: [tab('t1', 'p1'), tab('t2', 'p2')],
      tabPaths: { t1: '/dup.log', t2: '/dup.log' },
      hasLocalLayout: true,
    });

    const dups = plan.loads.filter((l) => l.path === '/dup.log');
    expect(dups).toHaveLength(2);
    // Each entry claimed a distinct tab; both keep their own dataIndex.
    const tabIds = dups.map((l) => l.existingTabId).sort();
    expect(tabIds).toEqual(['t1', 't2']);
    expect(dups.map((l) => l.dataIndex).sort()).toEqual([0, 1]);
  });

  it('.lts dedup — one load even across manifest + stored tabs; later refs dropped', () => {
    const plan = planStartupRestore({
      sessions: [session('/cap.lts'), session('/cap.lts')],
      storedTabs: [tab('t1', 'p1'), tab('t2', 'p1')],
      tabPaths: { t1: '/cap.lts', t2: '/cap.lts' },
      hasLocalLayout: true,
    });

    const ltsLoads = plan.loads.filter((l) => l.path === '/cap.lts');
    expect(ltsLoads).toHaveLength(1);
    // The single kept load is the first manifest entry (dataIndex 0).
    expect(ltsLoads[0].dataIndex).toBe(0);
    expect(plan.warnings.some((w) => w.toLowerCase().includes('.lts'))).toBe(true);
  });

  it('applyLtwViewState follows !hasLocalLayout', () => {
    const base = { sessions: [session('/a.log')], storedTabs: [] as StoredTab[], tabPaths: {} };
    expect(planStartupRestore({ ...base, hasLocalLayout: true }).applyLtwViewState).toBe(false);
    expect(planStartupRestore({ ...base, hasLocalLayout: false }).applyLtwViewState).toBe(true);
  });

  it('active tabs sort first so they establish their pane session', () => {
    const plan = planStartupRestore({
      sessions: [],
      storedTabs: [tab('t1', 'p1', false), tab('t2', 'p1', true)],
      tabPaths: { t1: '/inactive.log', t2: '/active.log' },
      hasLocalLayout: true,
    });
    expect(plan.loads[0].path).toBe('/active.log');
    expect(plan.loads[1].path).toBe('/inactive.log');
  });

  it('unsaved stream tabs (no tab path) are skipped', () => {
    const plan = planStartupRestore({
      sessions: [],
      storedTabs: [tab('stream', 'p1', true)],
      tabPaths: {}, // no path for the stream tab
      hasLocalLayout: true,
    });
    expect(plan.loads).toHaveLength(0);
  });

  it('empty manifest (pure localStorage) emits no "not in manifest" warnings', () => {
    const plan = planStartupRestore({
      sessions: [],
      storedTabs: [tab('t1', 'p1', true)],
      tabPaths: { t1: '/a.log' },
      hasLocalLayout: true,
    });
    expect(plan.loads).toHaveLength(1);
    expect(plan.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// planExplicitOpen — no stored tabs, always applies view-state
// ---------------------------------------------------------------------------

describe('planExplicitOpen', () => {
  it('loads manifest entries in order with no tab/pane binding and applies view-state', () => {
    const plan = planExplicitOpen([session('/a.log'), session('/b.log')]);
    expect(plan.applyLtwViewState).toBe(true);
    expect(plan.loads.map((l) => l.path)).toEqual(['/a.log', '/b.log']);
    expect(plan.loads.every((l) => l.existingTabId === undefined && l.paneId === undefined)).toBe(true);
    expect(plan.loads.map((l) => l.dataIndex)).toEqual([0, 1]);
  });

  it('dedups a .lts referenced by multiple manifest entries', () => {
    const plan = planExplicitOpen([session('/c.lts'), session('/c.lts')]);
    expect(plan.loads.filter((l) => l.path === '/c.lts')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pairing through the planner — a failed/skipped load drops its own artifacts
// ---------------------------------------------------------------------------

describe('plan → outcomes → pairing', () => {
  it('a moved (failed) entry drops only its own artifacts; later entries keep theirs', () => {
    const plan = planExplicitOpen([session('/moved.log'), session('/present.log')]);
    // /moved.log produced no session (file moved); /present.log produced one.
    const produced = [[], ['sess-present']];
    const outcomes = buildRestoreOutcomes(plan.loads, produced, [data('moved'), data('present')]);
    const { pairs, warnings } = pairArtifactsWithSessions(outcomes);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].sessionId).toBe('sess-present');
    expect(pairs[0].data.activeProcessorIds).toEqual(['present']);
    expect(warnings.some((w) => w.includes('/moved.log'))).toBe(true);
  });

  it('an extra localStorage tab (dataIndex:null) contributes no artifacts', () => {
    const plan = planStartupRestore({
      sessions: [session('/a.log')],
      storedTabs: [tab('t2', 'p1')],
      tabPaths: { t2: '/extra.log' },
      hasLocalLayout: true,
    });
    const produced = plan.loads.map((l) => [`sess-${l.path}`]);
    const outcomes = buildRestoreOutcomes(plan.loads, produced, [data('a')]);
    const { pairs } = pairArtifactsWithSessions(outcomes);
    // Only /a.log (dataIndex 0) yields a pair; /extra.log (null) does not.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].data.activeProcessorIds).toEqual(['a']);
  });
});
