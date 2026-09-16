/**
 * Pairing restored artifacts with the sessions they belong to.
 *
 * A `.ltw` manifest lists file references and a parallel `sessionData` array of
 * per-session artifacts (bookmarks, analyses, pipeline meta). Restore used to
 * zip the two by array position: `loadedSessionIds[i]` with `sessionData[i]`.
 *
 * That is only correct if every entry loads. The manifest stores absolute
 * paths, so a moved or deleted file is enough to make one entry produce no
 * session — after which every later entry shifts by one, and a file silently
 * receives another file's bookmarks and analyses, complete with that file's
 * line numbers. Nothing surfaces; the references simply point at the wrong
 * lines.
 *
 * The fix is to pair each manifest entry with the sessions its *own* load
 * produced, so a failure drops that entry alone.
 */

export interface SessionLoadOutcome<T> {
  /** Manifest path, used for diagnostics. */
  filePath: string;
  /** Session ids that this entry's load produced. Empty means it failed or was
   *  skipped (e.g. an already-open `.lts`). */
  producedSessionIds: string[];
  /** Artifacts recorded for this manifest entry, if any. */
  data: T | undefined;
}

export interface ArtifactPairing<T> {
  pairs: Array<{ sessionId: string; data: T }>;
  /** Human-readable notes about entries that were skipped or ambiguous. */
  warnings: string[];
}

export function pairArtifactsWithSessions<T>(
  outcomes: ReadonlyArray<SessionLoadOutcome<T>>,
): ArtifactPairing<T> {
  const pairs: Array<{ sessionId: string; data: T }> = [];
  const warnings: string[] = [];

  for (const { filePath, producedSessionIds, data } of outcomes) {
    if (data === undefined) continue;

    if (producedSessionIds.length === 0) {
      warnings.push(
        `No session loaded for ${filePath} — its artifacts were skipped rather than attached to another file.`,
      );
      continue;
    }
    if (producedSessionIds.length > 1) {
      warnings.push(
        `${filePath} produced ${producedSessionIds.length} sessions; artifacts applied to the first.`,
      );
    }
    pairs.push({ sessionId: producedSessionIds[0]!, data });
  }

  return { pairs, warnings };
}
