import { describe, it, expect } from 'vitest';
import { pairArtifactsWithSessions } from './artifactPairing';

type Data = { bookmarks: string[] };

const d = (name: string): Data => ({ bookmarks: [name] });

describe('pairArtifactsWithSessions', () => {
  it('pairs each entry with the session its own load produced', () => {
    const { pairs, warnings } = pairArtifactsWithSessions<Data>([
      { filePath: 'a.txt', producedSessionIds: ['s-a'], data: d('a') },
      { filePath: 'b.txt', producedSessionIds: ['s-b'], data: d('b') },
    ]);
    expect(pairs).toEqual([
      { sessionId: 's-a', data: d('a') },
      { sessionId: 's-b', data: d('b') },
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('does not shift later entries when one load fails', () => {
    // The core regression. Positionally, b's artifacts would land on c.
    const { pairs, warnings } = pairArtifactsWithSessions<Data>([
      { filePath: 'a.txt', producedSessionIds: ['s-a'], data: d('a') },
      { filePath: 'b.txt', producedSessionIds: [], data: d('b') },
      { filePath: 'c.txt', producedSessionIds: ['s-c'], data: d('c') },
    ]);
    expect(pairs).toEqual([
      { sessionId: 's-a', data: d('a') },
      { sessionId: 's-c', data: d('c') },
    ]);
    // c must keep its own artifacts, not inherit b's.
    expect(pairs.find(p => p.sessionId === 's-c')?.data).toEqual(d('c'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('b.txt');
  });

  it('warns naming the file whose artifacts were skipped', () => {
    const { warnings } = pairArtifactsWithSessions<Data>([
      { filePath: 'G:/moved/gone.txt', producedSessionIds: [], data: d('x') },
    ]);
    expect(warnings[0]).toContain('G:/moved/gone.txt');
    expect(warnings[0]).toContain('skipped');
  });

  it('survives the first entry failing', () => {
    const { pairs } = pairArtifactsWithSessions<Data>([
      { filePath: 'a.txt', producedSessionIds: [], data: d('a') },
      { filePath: 'b.txt', producedSessionIds: ['s-b'], data: d('b') },
    ]);
    expect(pairs).toEqual([{ sessionId: 's-b', data: d('b') }]);
  });

  it('survives every entry failing', () => {
    const { pairs, warnings } = pairArtifactsWithSessions<Data>([
      { filePath: 'a.txt', producedSessionIds: [], data: d('a') },
      { filePath: 'b.txt', producedSessionIds: [], data: d('b') },
    ]);
    expect(pairs).toHaveLength(0);
    expect(warnings).toHaveLength(2);
  });

  it('applies artifacts to the first session when a load produces several', () => {
    // A multi-session .lts emits several session:loaded events for one entry.
    const { pairs, warnings } = pairArtifactsWithSessions<Data>([
      { filePath: 'bundle.lts', producedSessionIds: ['s-1', 's-2', 's-3'], data: d('bundle') },
    ]);
    expect(pairs).toEqual([{ sessionId: 's-1', data: d('bundle') }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('3 sessions');
  });

  it('skips entries with no recorded artifacts without warning', () => {
    const { pairs, warnings } = pairArtifactsWithSessions<Data>([
      { filePath: 'a.txt', producedSessionIds: ['s-a'], data: undefined },
      { filePath: 'b.txt', producedSessionIds: ['s-b'], data: d('b') },
    ]);
    expect(pairs).toEqual([{ sessionId: 's-b', data: d('b') }]);
    expect(warnings).toHaveLength(0);
  });

  it('handles an empty manifest', () => {
    expect(pairArtifactsWithSessions<Data>([])).toEqual({ pairs: [], warnings: [] });
  });
});
