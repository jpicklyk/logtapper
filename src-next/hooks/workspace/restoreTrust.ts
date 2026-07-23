/**
 * Deciding whether an auto-save `.ltw` is trustworthy enough to restore at
 * startup (design: `plans/workspace-restore-design.md` §Q3).
 *
 * The incident this guards against: the active workspace was "Untitled"
 * (`ltwPath: null`, `dirty: true`) while `workspaces/Untitled.ltw` on disk was
 * 15 days old and held a *different* investigation. Q1 fixed the structural
 * causes (auto-save files are keyed by workspace id, and app-state.json records
 * `autoSavePath` / `lastAutoSaveAt`). This module is the residual gate for the
 * files those fixes can't retroactively vouch for: legacy name-keyed files,
 * partial writes, and clock/ordering surprises.
 *
 * Pure and React-free by design — same pattern as `artifactPairing.ts` /
 * `reconcileWorkspaceList.ts`. The caller (Q2's `useStartupRestore`) does all
 * IPC (reads app-state.json and the candidate `.ltw` manifest headers) and hands
 * this function plain data. It **never** globs the workspaces dir by name — that
 * is exactly the Untitled trap.
 */

/** Skew allowed between the selected auto-save `.ltw`'s manifest `savedAt` and
 *  the app-state entry's `lastAutoSaveAt`. A backend flush writes both from one
 *  `now_ms()` (equal); a frontend id-keyed auto-save records `Date.now()` just
 *  after the write resolves (within one IPC round-trip). 10 s absorbs write
 *  ordering, not cross-machine clock drift — both numbers are local. */
export const TOLERANCE_MS = 10_000;

/** The workspace-entry fields (from app-state.json / the in-memory list) this
 *  assessment consumes. Passed as plain data — no `WorkspaceIdentity` /
 *  `WorkspaceEntry` coupling so the module stays trivially unit-testable. */
export interface RestoreEntryFields {
  /** Stable workspace id — matched against the manifest's `workspaceId`. */
  id: string;
  /** Explicit user-save path, or null if the workspace was never saved. */
  ltwPath: string | null;
  /** In-memory dirty flag. A clean (`false`) explicit save is trusted outright. */
  dirty: boolean;
  /** Path to the id-keyed auto-save `.ltw`, or null if never auto-saved. */
  autoSavePath: string | null;
  /** Epoch-ms of the last completed auto-save, or null. Null is NOT "stale" —
   *  an explicit-`.ltw` workspace saved only via the frontend has no flush yet. */
  lastAutoSaveAt: number | null;
}

/** The subset of a candidate `.ltw` manifest the caller reads and passes in.
 *  Deliberately not the full `LtwManifest` — the gate only needs identity,
 *  timing, and the session paths. */
export interface RestoreManifestHeader {
  /** `workspaceId` from the manifest. Absent (undefined/null) for files written
   *  before Q3 added the field — those are the *legacy* files. */
  workspaceId?: string | null;
  /** `savedAt` epoch-ms stamped into the manifest at write time. */
  savedAt: number;
  /** Absolute file paths of the manifest's sessions (for the legacy
   *  path-intersection check). */
  sessionPaths: string[];
}

/** The manifest headers the caller read for the two candidate files. Each slot
 *  corresponds to a path on the entry; `null`/absent means "no such path, or the
 *  file was missing/unreadable" (the caller could not read a valid header). */
export interface RestoreCandidateHeaders {
  /** Header read from `entry.autoSavePath`. */
  autoSave?: RestoreManifestHeader | null;
  /** Header read from `entry.ltwPath`. */
  explicit?: RestoreManifestHeader | null;
}

export type RestoreVerdict = 'trusted' | 'untrusted' | 'absent';

export interface RestoreAssessment {
  verdict: RestoreVerdict;
  /** The `.ltw` selected for the verdict. Set for `trusted` (Q2 loads it) and
   *  `untrusted` (the notice's "Open it" targets it); omitted for `absent`. */
  candidatePath?: string;
  /** Machine-readable codes explaining the verdict. */
  reasons: string[];
}

type Selection =
  | { kind: 'absent' }
  /** A path was named but no valid header could be read for any named path. */
  | { kind: 'unreadable'; candidatePath: string }
  | {
      kind: 'candidate';
      path: string;
      header: RestoreManifestHeader;
      /** The selected file is the id-keyed auto-save. Gates the timestamp check. */
      isAutoSave: boolean;
      /** The selected file is the explicit user-save. Gates the explicit-clean
       *  shortcut. Both flags are true for a post-flush explicit workspace whose
       *  `autoSavePath === ltwPath`. */
      isExplicit: boolean;
    };

/**
 * Pick the `.ltw` to consider, implementing design §Q3 rule 2: prefer the
 * auto-save when it is at least as fresh as the explicit save (crash-latest
 * wins), else the explicit `ltwPath`. This needs BOTH files' manifest headers —
 * comparing only `entry.lastAutoSaveAt`'s presence (as an earlier revision did)
 * silently restores stale pre-save state after a Save-As followed by a crash
 * that flushed nothing.
 *
 * Freshness of the auto-save is `entry.lastAutoSaveAt` (app-state's recorded
 * time — the design's literal signal); when the frontend has not recorded it
 * yet (`null`) we fall back to the auto-save file's own manifest `savedAt`, so
 * the comparison against the explicit header's `savedAt` stays on one clock
 * (both are `now_ms()` stamped at write time).
 *
 * Readability rules: an unreadable file on one side must not block falling back
 * to a valid file on the other. If nothing was named at all → `absent`; if paths
 * were named but none yielded a header → `unreadable`.
 */
function selectCandidate(entry: RestoreEntryFields, headers: RestoreCandidateHeaders): Selection {
  const autoPath = entry.autoSavePath;
  const explicitPath = entry.ltwPath;
  const autoHeader = headers.autoSave ?? null;
  const explicitHeader = headers.explicit ?? null;

  const autoNamed = autoPath != null;
  const explicitNamed = explicitPath != null;

  // Nothing on the entry names a file — the true `absent` case. (We never fall
  // back to globbing the dir by name; that is the Untitled trap.)
  if (!autoNamed && !explicitNamed) return { kind: 'absent' };

  // Post-flush explicit workspace: the flush wrote the id-keyed file and the
  // explicit path to the same location. One candidate, both roles.
  if (autoNamed && explicitNamed && autoPath === explicitPath) {
    const header = autoHeader ?? explicitHeader;
    if (header == null) return { kind: 'unreadable', candidatePath: autoPath };
    return { kind: 'candidate', path: autoPath, header, isAutoSave: true, isExplicit: true };
  }

  const autoAvailable = autoNamed && autoHeader != null;
  const explicitAvailable = explicitNamed && explicitHeader != null;

  // Both readable and distinct → crash-latest wins by the timestamp comparison.
  if (autoAvailable && explicitAvailable) {
    const autoTs = entry.lastAutoSaveAt ?? autoHeader!.savedAt;
    if (autoTs >= explicitHeader!.savedAt) {
      return { kind: 'candidate', path: autoPath!, header: autoHeader!, isAutoSave: true, isExplicit: false };
    }
    return { kind: 'candidate', path: explicitPath!, header: explicitHeader!, isAutoSave: false, isExplicit: true };
  }

  // Exactly one readable → it is the candidate (the other is unnamed or
  // unreadable and must not block the fallback).
  if (autoAvailable) {
    return { kind: 'candidate', path: autoPath!, header: autoHeader!, isAutoSave: true, isExplicit: false };
  }
  if (explicitAvailable) {
    return { kind: 'candidate', path: explicitPath!, header: explicitHeader!, isAutoSave: false, isExplicit: true };
  }

  // Paths were named but none produced a readable header. Surface the file so
  // Q2 falls back to localStorage and the notice can point "Open it" at it.
  return { kind: 'unreadable', candidatePath: autoPath ?? explicitPath! };
}

/** Normalise an absolute path for comparison: separators unified and lowercased.
 *  Lowercasing suits the Windows/NTFS target (case-insensitive filesystem); it
 *  never introduces a *false* match between two genuinely different paths, only
 *  bridges case/separator variants of the same one. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function pathsIntersect(sessionPaths: string[], tabPaths: string[]): boolean {
  if (sessionPaths.length === 0 || tabPaths.length === 0) return false;
  const tabSet = new Set(tabPaths.map(normalizePath));
  return sessionPaths.some((p) => tabSet.has(normalizePath(p)));
}

/**
 * Assess whether a workspace entry's candidate `.ltw` may be silently restored.
 * See the module doc and design §Q3 for the rationale behind each rule.
 *
 * - **absent** — no candidate file is named (Q1 fields empty AND `ltwPath` null).
 *   Q2 falls back to the plain-localStorage plan; no notice.
 * - **untrusted** — a candidate exists but fails a gate (or no named file was
 *   readable). Q2 falls back to localStorage AND surfaces the non-blocking
 *   notice (`reasons` explain why).
 * - **trusted** — safe to restore silently.
 */
export function assessRestoreCandidate(
  entry: RestoreEntryFields,
  headers: RestoreCandidateHeaders,
  localTabPaths: string[],
): RestoreAssessment {
  const sel = selectCandidate(entry, headers);
  if (sel.kind === 'absent') {
    return { verdict: 'absent', reasons: ['no-candidate'] };
  }
  if (sel.kind === 'unreadable') {
    return { verdict: 'untrusted', candidatePath: sel.candidatePath, reasons: ['candidate-unreadable'] };
  }

  const { path: candidatePath, header, isAutoSave, isExplicit } = sel;
  const manifestId = header.workspaceId;
  const hasWorkspaceId = manifestId != null && manifestId !== '';

  // (a) Identity is the strongest signal: a present-but-mismatched workspace id
  //     is immediately untrusted, regardless of every other signal.
  if (hasWorkspaceId && manifestId !== entry.id) {
    return { verdict: 'untrusted', candidatePath, reasons: ['workspace-id-mismatch'] };
  }

  // (d) An explicitly user-saved `.ltw` with no unsaved changes is trusted
  //     outright — the user wrote it on purpose and nothing has diverged from it
  //     since. Skips the timestamp check. (A post-flush explicit workspace is
  //     `isAutoSave` too and takes the timestamp path below instead.)
  if (isExplicit && !isAutoSave && !entry.dirty) {
    return { verdict: 'trusted', candidatePath, reasons: ['explicit-clean-save'] };
  }

  // (c) Legacy file (manifest predates the `workspaceId` field): trust it only
  //     if at least one of its sessions is still open. With no live tab paths at
  //     all we cannot corroborate it — better to start empty than to silently
  //     load a possibly-different investigation (the stale-Untitled failure).
  if (!hasWorkspaceId) {
    if (localTabPaths.length === 0) {
      return { verdict: 'untrusted', candidatePath, reasons: ['legacy-no-tab-paths'] };
    }
    if (!pathsIntersect(header.sessionPaths, localTabPaths)) {
      return { verdict: 'untrusted', candidatePath, reasons: ['legacy-no-path-intersection'] };
    }
  }

  // (b) When the candidate is the auto-save and we recorded when it was written,
  //     the manifest's `savedAt` must line up with `lastAutoSaveAt` (they are
  //     written together per flush). A gap flags a partial write or an ordering
  //     surprise. Null `lastAutoSaveAt` is NOT stale — the check simply does not
  //     apply, so an explicit workspace with no flush yet is unaffected.
  if (isAutoSave && entry.lastAutoSaveAt != null) {
    if (Math.abs(header.savedAt - entry.lastAutoSaveAt) > TOLERANCE_MS) {
      return { verdict: 'untrusted', candidatePath, reasons: ['timestamp-outside-tolerance'] };
    }
  }

  // Survived every applicable gate.
  const reasons: string[] = [hasWorkspaceId ? 'workspace-id-match' : 'legacy-path-intersection'];
  if (isAutoSave && entry.lastAutoSaveAt != null) reasons.push('timestamp-within-tolerance');
  return { verdict: 'trusted', candidatePath, reasons };
}
