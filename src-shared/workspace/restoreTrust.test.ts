import { describe, it, expect } from 'vitest';
import {
  assessRestoreCandidate,
  TOLERANCE_MS,
  type RestoreEntryFields,
  type RestoreManifestHeader,
} from './restoreTrust';

// --- Factories --------------------------------------------------------------

const T = 1_700_000_000_000;

function entry(over: Partial<RestoreEntryFields> = {}): RestoreEntryFields {
  return {
    id: 'ws-1',
    ltwPath: null,
    dirty: false,
    autoSavePath: null,
    lastAutoSaveAt: null,
    ...over,
  };
}

function header(over: Partial<RestoreManifestHeader> = {}): RestoreManifestHeader {
  return {
    workspaceId: 'ws-1',
    savedAt: T,
    sessionPaths: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('assessRestoreCandidate', () => {
  // --- absent ---------------------------------------------------------------

  it('is absent when no Q1 field names a candidate and ltwPath is null (all signals missing)', () => {
    const result = assessRestoreCandidate(
      entry({ ltwPath: null, autoSavePath: null, lastAutoSaveAt: null }),
      {},
      [],
    );
    expect(result.verdict).toBe('absent');
    expect(result.candidatePath).toBeUndefined();
    expect(result.reasons).toContain('no-candidate');
  });

  // --- modern id-keyed auto-save (the common case) --------------------------

  it('trusts an id-matched auto-save whose timestamp lines up', () => {
    const result = assessRestoreCandidate(
      entry({ autoSavePath: '/data/workspaces/ws-1.ltw', lastAutoSaveAt: T }),
      { autoSave: header({ workspaceId: 'ws-1', savedAt: T }) },
      [],
    );
    expect(result.verdict).toBe('trusted');
    expect(result.candidatePath).toBe('/data/workspaces/ws-1.ltw');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['workspace-id-match', 'timestamp-within-tolerance']),
    );
  });

  // --- timestamp tolerance --------------------------------------------------

  it('trusts when savedAt is within TOLERANCE_MS of lastAutoSaveAt', () => {
    const result = assessRestoreCandidate(
      entry({ autoSavePath: '/w/ws-1.ltw', lastAutoSaveAt: T }),
      { autoSave: header({ workspaceId: 'ws-1', savedAt: T + (TOLERANCE_MS - 1) }) },
      [],
    );
    expect(result.verdict).toBe('trusted');
  });

  it('is untrusted when savedAt is outside TOLERANCE_MS of lastAutoSaveAt', () => {
    const result = assessRestoreCandidate(
      entry({ autoSavePath: '/w/ws-1.ltw', lastAutoSaveAt: T }),
      { autoSave: header({ workspaceId: 'ws-1', savedAt: T + (TOLERANCE_MS + 1) }) },
      [],
    );
    expect(result.verdict).toBe('untrusted');
    expect(result.reasons).toContain('timestamp-outside-tolerance');
    expect(result.candidatePath).toBe('/w/ws-1.ltw');
  });

  it('treats the tolerance symmetrically (candidate older than recorded)', () => {
    const result = assessRestoreCandidate(
      entry({ autoSavePath: '/w/ws-1.ltw', lastAutoSaveAt: T }),
      { autoSave: header({ workspaceId: 'ws-1', savedAt: T - (TOLERANCE_MS + 1) }) },
      [],
    );
    expect(result.verdict).toBe('untrusted');
    expect(result.reasons).toContain('timestamp-outside-tolerance');
  });

  // --- workspace id mismatch dominates -------------------------------------

  it('is untrusted on workspace-id mismatch regardless of a lined-up timestamp', () => {
    const result = assessRestoreCandidate(
      entry({ id: 'ws-1', autoSavePath: '/w/ws-1.ltw', lastAutoSaveAt: T }),
      // Perfectly matching timestamp, but the file belongs to another workspace.
      { autoSave: header({ workspaceId: 'ws-OTHER', savedAt: T }) },
      [],
    );
    expect(result.verdict).toBe('untrusted');
    expect(result.reasons).toEqual(['workspace-id-mismatch']);
  });

  // --- candidate selection: crash-latest wins by timestamp ------------------

  it('prefers the auto-save when it is newer than the explicit save', () => {
    const result = assessRestoreCandidate(
      entry({
        ltwPath: '/user/saved/explicit.ltw',
        autoSavePath: '/data/workspaces/ws-1.ltw',
        lastAutoSaveAt: T, // newer than the explicit header below
        dirty: true,
      }),
      {
        autoSave: header({ workspaceId: 'ws-1', savedAt: T }),
        explicit: header({ workspaceId: 'ws-1', savedAt: T - 100_000 }),
      },
      [],
    );
    expect(result.candidatePath).toBe('/data/workspaces/ws-1.ltw');
    expect(result.verdict).toBe('trusted');
  });

  it('picks the explicit save when the auto-save is OLDER (Save-As then crash) and trusts it clean', () => {
    // The regression the design's timestamp comparison exists for: an Untitled
    // workspace accumulated id-keyed auto-saves, the user did Save-As (writing a
    // newer explicit .ltw, dirty:false), and the app died before any flush
    // re-pointed the auto-save. The auto-save is now STALE pre-save state; the
    // gate must select the explicit file and trust it via the clean-save rule —
    // not silently restore the discarded pre-save workspace.
    const result = assessRestoreCandidate(
      entry({
        id: 'ws-1',
        ltwPath: '/user/saved/final.ltw',
        autoSavePath: '/data/workspaces/ws-1.ltw',
        lastAutoSaveAt: T - 100_000, // stale auto-save, older than the explicit save
        dirty: false, // just did Save-As → markClean
      }),
      {
        autoSave: header({ workspaceId: 'ws-1', savedAt: T - 100_000, sessionPaths: ['/old/pre-save.log'] }),
        explicit: header({ workspaceId: 'ws-1', savedAt: T }),
      },
      [],
    );
    expect(result.candidatePath).toBe('/user/saved/final.ltw');
    expect(result.verdict).toBe('trusted');
    expect(result.reasons).toContain('explicit-clean-save');
  });

  // --- readability: unreadable file must not block the fallback -------------

  it('falls back to a valid explicit save when the auto-save file is unreadable', () => {
    const result = assessRestoreCandidate(
      entry({
        ltwPath: '/user/saved/final.ltw',
        autoSavePath: '/data/workspaces/ws-1.ltw',
        lastAutoSaveAt: T,
        dirty: false,
      }),
      { autoSave: null, explicit: header({ workspaceId: 'ws-1', savedAt: T }) },
      [],
    );
    expect(result.candidatePath).toBe('/user/saved/final.ltw');
    expect(result.verdict).toBe('trusted');
    expect(result.reasons).toContain('explicit-clean-save');
  });

  it('falls back to a valid auto-save when the explicit file is unreadable', () => {
    const result = assessRestoreCandidate(
      entry({
        ltwPath: '/user/saved/final.ltw',
        autoSavePath: '/data/workspaces/ws-1.ltw',
        lastAutoSaveAt: T,
        dirty: true,
      }),
      { autoSave: header({ workspaceId: 'ws-1', savedAt: T }), explicit: null },
      [],
    );
    expect(result.candidatePath).toBe('/data/workspaces/ws-1.ltw');
    expect(result.verdict).toBe('trusted');
  });

  it('is untrusted (candidate-unreadable) when paths are named but none can be read', () => {
    const result = assessRestoreCandidate(
      entry({
        ltwPath: '/user/saved/final.ltw',
        autoSavePath: '/data/workspaces/ws-1.ltw',
        lastAutoSaveAt: T,
      }),
      { autoSave: null, explicit: null },
      [],
    );
    expect(result.verdict).toBe('untrusted');
    expect(result.reasons).toContain('candidate-unreadable');
    // A path is still surfaced so the notice can offer "Open it".
    expect(result.candidatePath).toBe('/data/workspaces/ws-1.ltw');
  });

  // --- explicit clean save (rule d) ----------------------------------------

  it('trusts a clean (dirty:false) explicit save without a timestamp check', () => {
    const result = assessRestoreCandidate(
      entry({ ltwPath: '/user/saved/debug.ltw', dirty: false }),
      { explicit: header({ workspaceId: 'ws-1', savedAt: T }) },
      [],
    );
    expect(result.verdict).toBe('trusted');
    expect(result.candidatePath).toBe('/user/saved/debug.ltw');
    expect(result.reasons).toContain('explicit-clean-save');
  });

  it('trusts a clean legacy explicit save even with no workspaceId or tab paths', () => {
    // The user saved it on purpose and nothing has diverged; rule (d) beats the
    // legacy path-intersection requirement.
    const result = assessRestoreCandidate(
      entry({ ltwPath: '/user/saved/legacy.ltw', dirty: false }),
      { explicit: header({ workspaceId: undefined, savedAt: T, sessionPaths: ['/some/old.log'] }) },
      [],
    );
    expect(result.verdict).toBe('trusted');
    expect(result.reasons).toContain('explicit-clean-save');
  });

  // --- null lastAutoSaveAt is NOT stale (the Q4 edge) -----------------------

  it('does not treat a null lastAutoSaveAt as stale for a dirty explicit workspace', () => {
    // Explicit .ltw saved only via the frontend: no backend flush yet, so
    // lastAutoSaveAt is null. dirty:true rules out (d), but the timestamp check
    // must NOT apply — the id match alone trusts it.
    const result = assessRestoreCandidate(
      entry({ ltwPath: '/user/saved/wip.ltw', dirty: true, autoSavePath: null, lastAutoSaveAt: null }),
      { explicit: header({ workspaceId: 'ws-1', savedAt: T - 999_999_999 }) },
      [],
    );
    expect(result.verdict).toBe('trusted');
    expect(result.reasons).toContain('workspace-id-match');
    expect(result.reasons).not.toContain('timestamp-outside-tolerance');
  });

  // --- legacy path-intersection --------------------------------------------

  it('trusts a legacy file when a session path still intersects the open tabs', () => {
    const result = assessRestoreCandidate(
      entry({ autoSavePath: '/data/workspaces/Untitled.ltw', lastAutoSaveAt: T }),
      { autoSave: header({ workspaceId: undefined, savedAt: T, sessionPaths: ['C:\\logs\\today.log'] }) },
      ['c:/logs/today.log'], // different case + separators — still the same file
    );
    expect(result.verdict).toBe('trusted');
    expect(result.reasons).toContain('legacy-path-intersection');
  });

  it('is untrusted for a legacy file when localStorage has no tab paths at all', () => {
    const result = assessRestoreCandidate(
      entry({ autoSavePath: '/data/workspaces/Untitled.ltw', lastAutoSaveAt: T }),
      { autoSave: header({ workspaceId: undefined, savedAt: T, sessionPaths: ['/logs/x.log'] }) },
      [],
    );
    expect(result.verdict).toBe('untrusted');
    expect(result.reasons).toContain('legacy-no-tab-paths');
  });

  // --- the stale-Untitled incident, as a literal fixture --------------------

  it('rejects the stale-Untitled incident (legacy RNDIS file, no path in today’s tabs)', () => {
    // The affected machine: active "Untitled" pointed at a 15-day-old
    // workspaces/Untitled.ltw holding a *different* (RNDIS) investigation. The
    // manifest predates the workspaceId field, and none of its session paths
    // appear among today's open tabs → the gate must refuse a silent restore.
    const rndisPath = 'C:\\Users\\dev\\logs\\rndis-investigation.log';
    const result = assessRestoreCandidate(
      entry({
        id: 'ws-today',
        ltwPath: null,
        dirty: true,
        autoSavePath: 'C:\\Users\\dev\\AppData\\workspaces\\Untitled.ltw',
        lastAutoSaveAt: T,
      }),
      { autoSave: header({ workspaceId: undefined, savedAt: T, sessionPaths: [rndisPath] }) },
      // Today's investigation — a completely different set of files.
      ['C:\\Users\\dev\\logs\\wifi-drop-today.log', 'C:\\Users\\dev\\logs\\bugreport-today.zip'],
    );
    expect(result.verdict).toBe('untrusted');
    expect(result.reasons).toContain('legacy-no-path-intersection');
    // The path is still surfaced so the notice can offer "Open it" as a *new*
    // workspace (never contaminating the current one).
    expect(result.candidatePath).toBe('C:\\Users\\dev\\AppData\\workspaces\\Untitled.ltw');
  });
});
