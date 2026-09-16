import { describe, it, expect, beforeEach } from 'vitest';
import { planExtraSessionImport, type ImportedSession, type ImportAction } from './multiSessionImport';

const PANE = 'pane-1';
const PRIMARY = 'session-primary';

let tabCounter = 0;
function resetTabCounter() { tabCounter = 0; }
function makeTabId() { return `tab-${++tabCounter}`; }

function makeSession(id: string, name: string, type = 'Logcat'): ImportedSession {
  return { sessionId: id, sourceName: name, sourceType: type };
}

describe('planExtraSessionImport', () => {
  beforeEach(resetTabCounter);

  it('returns empty actions for no extra sessions', () => {
    const actions = planExtraSessionImport(PANE, PRIMARY, [], makeTabId);
    expect(actions).toEqual([]);
  });

  it('produces correct action sequence for one extra session', () => {
    const extra = makeSession('session-B', 'logcat-device2.log');
    const actions = planExtraSessionImport(PANE, PRIMARY, [extra], makeTabId);

    expect(actions).toEqual([
      { type: 'loading', paneId: PANE, tabId: 'tab-1', label: 'logcat-device2.log' },
      { type: 'register', paneId: PANE, session: extra },
      { type: 'activate', paneId: PANE, sessionId: 'session-B' },
      { type: 'loaded', paneId: PANE, tabId: 'tab-1', session: extra, previousSessionId: PRIMARY, readOnly: false },
      { type: 'persistTabPath', tabId: 'tab-1' },
      // Re-activate primary
      { type: 'activate', paneId: PANE, sessionId: PRIMARY },
    ]);
  });

  it('produces correct sequence for two extra sessions', () => {
    const extraB = makeSession('session-B', 'file-B.log');
    const extraC = makeSession('session-C', 'file-C.log');
    const actions = planExtraSessionImport(PANE, PRIMARY, [extraB, extraC], makeTabId);

    // Each extra session gets 5 actions, plus 1 final re-activate
    expect(actions).toHaveLength(11);

    // First extra
    expect(actions[0]).toEqual({ type: 'loading', paneId: PANE, tabId: 'tab-1', label: 'file-B.log' });
    expect(actions[1]).toEqual({ type: 'register', paneId: PANE, session: extraB });
    expect(actions[2]).toEqual({ type: 'activate', paneId: PANE, sessionId: 'session-B' });
    expect(actions[3]).toEqual({ type: 'loaded', paneId: PANE, tabId: 'tab-1', session: extraB, previousSessionId: PRIMARY, readOnly: false });
    expect(actions[4]).toEqual({ type: 'persistTabPath', tabId: 'tab-1' });

    // Second extra
    expect(actions[5]).toEqual({ type: 'loading', paneId: PANE, tabId: 'tab-2', label: 'file-C.log' });
    expect(actions[6]).toEqual({ type: 'register', paneId: PANE, session: extraC });
    expect(actions[7]).toEqual({ type: 'activate', paneId: PANE, sessionId: 'session-C' });
    expect(actions[8]).toEqual({ type: 'loaded', paneId: PANE, tabId: 'tab-2', session: extraC, previousSessionId: PRIMARY, readOnly: false });
    expect(actions[9]).toEqual({ type: 'persistTabPath', tabId: 'tab-2' });

    // Final re-activate primary
    expect(actions[10]).toEqual({ type: 'activate', paneId: PANE, sessionId: PRIMARY });
  });

  it('each extra session gets a unique tab ID', () => {
    const extras = [
      makeSession('s1', 'a.log'),
      makeSession('s2', 'b.log'),
      makeSession('s3', 'c.log'),
    ];
    const actions = planExtraSessionImport(PANE, PRIMARY, extras, makeTabId);

    const tabIds = actions
      .filter((a): a is Extract<ImportAction, { type: 'loading' }> => a.type === 'loading')
      .map(a => a.tabId);

    expect(tabIds).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(new Set(tabIds).size).toBe(3);
  });

  it('bugreport sessions are marked readOnly', () => {
    const extra = makeSession('session-br', 'bugreport.txt', 'Bugreport');
    const actions = planExtraSessionImport(PANE, PRIMARY, [extra], makeTabId);

    const loaded = actions.find((a): a is Extract<ImportAction, { type: 'loaded' }> => a.type === 'loaded');
    expect(loaded?.readOnly).toBe(true);
  });

  it('dumpstate sessions are marked readOnly', () => {
    const extra = makeSession('session-ds', 'dumpstate.txt', 'Dumpstate');
    const actions = planExtraSessionImport(PANE, PRIMARY, [extra], makeTabId);

    const loaded = actions.find((a): a is Extract<ImportAction, { type: 'loaded' }> => a.type === 'loaded');
    expect(loaded?.readOnly).toBe(true);
  });

  it('logcat sessions are not readOnly', () => {
    const extra = makeSession('session-lc', 'logcat.log', 'Logcat');
    const actions = planExtraSessionImport(PANE, PRIMARY, [extra], makeTabId);

    const loaded = actions.find((a): a is Extract<ImportAction, { type: 'loaded' }> => a.type === 'loaded');
    expect(loaded?.readOnly).toBe(false);
  });

  it('final action is always re-activate primary', () => {
    const extras = [makeSession('s1', 'a.log'), makeSession('s2', 'b.log')];
    const actions = planExtraSessionImport(PANE, PRIMARY, extras, makeTabId);

    const last = actions[actions.length - 1];
    expect(last).toEqual({ type: 'activate', paneId: PANE, sessionId: PRIMARY });
  });

  it('uses fallback label when sourceName is empty', () => {
    const extra = makeSession('session-empty', '', 'Logcat');
    const actions = planExtraSessionImport(PANE, PRIMARY, [extra], makeTabId);

    const loading = actions.find((a): a is Extract<ImportAction, { type: 'loading' }> => a.type === 'loading');
    expect(loading?.label).toBe('Untitled');
  });

  it('all register actions reference the correct pane', () => {
    const extras = [makeSession('s1', 'a.log'), makeSession('s2', 'b.log')];
    const actions = planExtraSessionImport(PANE, PRIMARY, extras, makeTabId);

    const registers = actions.filter(a => a.type === 'register');
    expect(registers.every(a => 'paneId' in a && a.paneId === PANE)).toBe(true);
  });
});
