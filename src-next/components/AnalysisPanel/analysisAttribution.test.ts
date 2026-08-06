import { describe, it, expect } from 'vitest';
import { attributeArtifact, artifactAppliesToSession } from './analysisAttribution';
import type { AnalysisArtifact, SourceReference } from '../../bridge/types';

function makeRef(overrides: Partial<SourceReference> = {}): SourceReference {
  return {
    lineNumber: 1,
    endLine: null,
    label: 'ref',
    highlightType: 'Annotation',
    sessionId: null,
    ...overrides,
  };
}

function makeArtifact(sections: AnalysisArtifact['sections']): AnalysisArtifact {
  return { id: 'art-1', title: 'Test', createdAt: 0, sections };
}

describe('attributeArtifact', () => {
  it('returns empty resolved and 0 unresolved for a zero-reference artifact', () => {
    const artifact = makeArtifact([{ heading: 'h', body: 'b', references: [], severity: null }]);
    const result = attributeArtifact(artifact, new Map());
    expect(result.resolved).toEqual([]);
    expect(result.unresolvedCount).toBe(0);
  });

  it('groups references by session, deduping with per-session refCount', () => {
    const artifact = makeArtifact([
      {
        heading: 'h1', body: 'b', severity: null,
        references: [makeRef({ sessionId: 'sess-a' }), makeRef({ sessionId: 'sess-b' })],
      },
      {
        heading: 'h2', body: 'b', severity: null,
        references: [makeRef({ sessionId: 'sess-a' })],
      },
    ]);
    const labels = new Map([['sess-a', 'device-a.log'], ['sess-b', 'device-b.log']]);

    const result = attributeArtifact(artifact, labels);

    expect(result.resolved).toEqual([
      { sessionId: 'sess-a', label: 'device-a.log', refCount: 2 },
      { sessionId: 'sess-b', label: 'device-b.log', refCount: 1 },
    ]);
    expect(result.unresolvedCount).toBe(0);
  });

  it('preserves first-seen order of sessions', () => {
    const artifact = makeArtifact([
      {
        heading: 'h', body: 'b', severity: null,
        references: [
          makeRef({ sessionId: 'sess-b' }),
          makeRef({ sessionId: 'sess-a' }),
          makeRef({ sessionId: 'sess-b' }),
        ],
      },
    ]);
    const labels = new Map([['sess-a', 'A'], ['sess-b', 'B']]);

    const result = attributeArtifact(artifact, labels);

    expect(result.resolved.map((r) => r.sessionId)).toEqual(['sess-b', 'sess-a']);
  });

  it('counts null-sessionId references as unresolved', () => {
    const artifact = makeArtifact([
      {
        heading: 'h', body: 'b', severity: null,
        references: [makeRef({ sessionId: null }), makeRef({ sessionId: 'sess-a' })],
      },
    ]);
    const labels = new Map([['sess-a', 'A']]);

    const result = attributeArtifact(artifact, labels);

    expect(result.unresolvedCount).toBe(1);
    expect(result.resolved).toEqual([{ sessionId: 'sess-a', label: 'A', refCount: 1 }]);
  });

  it('counts references for a session absent from labels as unresolved', () => {
    const artifact = makeArtifact([
      {
        heading: 'h', body: 'b', severity: null,
        references: [makeRef({ sessionId: 'sess-unknown' }), makeRef({ sessionId: 'sess-a' })],
      },
    ]);
    const labels = new Map([['sess-a', 'A']]);

    const result = attributeArtifact(artifact, labels);

    expect(result.unresolvedCount).toBe(1);
    expect(result.resolved).toEqual([{ sessionId: 'sess-a', label: 'A', refCount: 1 }]);
  });
});

describe('artifactAppliesToSession', () => {
  const labels = new Map([['sess-a', 'A'], ['sess-b', 'B']]);

  it('treats a zero-reference (narrative-only) artifact as relevant to every session', () => {
    const artifact = makeArtifact([{ heading: 'h', body: 'b', references: [], severity: null }]);
    const attribution = attributeArtifact(artifact, labels);
    expect(artifactAppliesToSession(attribution, 'sess-a')).toBe(true);
    expect(artifactAppliesToSession(attribution, 'sess-never-seen')).toBe(true);
  });

  it('matches a referenced artifact only against sessions its references resolve to', () => {
    const artifact = makeArtifact([
      { heading: 'h', body: 'b', severity: null, references: [makeRef({ sessionId: 'sess-a' })] },
    ]);
    const attribution = attributeArtifact(artifact, labels);
    expect(artifactAppliesToSession(attribution, 'sess-a')).toBe(true);
    expect(artifactAppliesToSession(attribution, 'sess-b')).toBe(false);
  });

  it('never matches via unresolved references (null or closed-session)', () => {
    const artifact = makeArtifact([
      {
        heading: 'h', body: 'b', severity: null,
        references: [makeRef({ sessionId: null }), makeRef({ sessionId: 'sess-closed' })],
      },
    ]);
    const attribution = attributeArtifact(artifact, labels);
    expect(artifactAppliesToSession(attribution, 'sess-a')).toBe(false);
    expect(artifactAppliesToSession(attribution, 'sess-closed')).toBe(false);
  });
});
