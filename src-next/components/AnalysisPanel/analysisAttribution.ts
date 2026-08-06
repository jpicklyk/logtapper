import type { AnalysisArtifact } from '../../bridge/types';

/**
 * Attribution summary for one analysis artifact: which sessions its line
 * references resolve against, and how many references landed on each.
 */
export interface ArtifactAttribution {
  /** Sessions referenced by this artifact, in first-seen order, deduped. */
  resolved: Array<{ sessionId: string; label: string; refCount: number }>;
  /** References with no resolvable session — `sessionId: null`, or a
   *  sessionId not present in `labels` (e.g. a closed/unknown session). */
  unresolvedCount: number;
}

/**
 * Groups an artifact's section references by session. Pure — no React,
 * no I/O. `labels` maps sessionId → display label (typically `sourceName`).
 */
export function attributeArtifact(
  artifact: AnalysisArtifact,
  labels: ReadonlyMap<string, string>,
): ArtifactAttribution {
  const order: string[] = [];
  const counts = new Map<string, number>();
  let unresolvedCount = 0;

  for (const section of artifact.sections) {
    for (const ref of section.references) {
      const sessionId = ref.sessionId;
      const label = sessionId !== null ? labels.get(sessionId) : undefined;
      if (sessionId === null || label === undefined) {
        unresolvedCount += 1;
        continue;
      }
      if (!counts.has(sessionId)) {
        order.push(sessionId);
        counts.set(sessionId, 0);
      }
      counts.set(sessionId, counts.get(sessionId)! + 1);
    }
  }

  const resolved = order.map((sessionId) => ({
    sessionId,
    label: labels.get(sessionId)!,
    refCount: counts.get(sessionId)!,
  }));

  return { resolved, unresolvedCount };
}

/**
 * Whether an artifact is relevant to `sessionId` for filtered views.
 *
 * Mirrors the backend rule in `artifact_references_session`
 * (src-tauri/src/core/analysis.rs): a zero-reference (narrative-only)
 * analysis has no file anchor and is treated as relevant to every session.
 * An artifact WITH references matches only sessions its references resolve
 * against — unresolved references never match.
 */
export function artifactAppliesToSession(
  attribution: ArtifactAttribution,
  sessionId: string,
): boolean {
  const totalRefs =
    attribution.resolved.reduce((n, r) => n + r.refCount, 0) + attribution.unresolvedCount;
  if (totalRefs === 0) return true;
  return attribution.resolved.some((r) => r.sessionId === sessionId);
}
