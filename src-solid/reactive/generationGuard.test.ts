import { describe, expect, it } from 'vitest';
import { createGenerationGuard } from './generationGuard';

describe('createGenerationGuard', () => {
  it('starts at generation 0, with token 0 current', () => {
    const guard = createGenerationGuard();
    expect(guard.current()).toBe(0);
    expect(guard.isCurrent(0)).toBe(true);
  });

  it('bump() advances the generation and returns the new token', () => {
    const guard = createGenerationGuard();
    expect(guard.bump()).toBe(1);
    expect(guard.bump()).toBe(2);
    expect(guard.current()).toBe(2);
  });

  it('a token captured via bump() stops being current once a later bump() fires', () => {
    const guard = createGenerationGuard();
    const first = guard.bump();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.bump();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('a token captured via current() (no bump) stays current until the next bump()', () => {
    const guard = createGenerationGuard();
    const token = guard.current();
    expect(guard.isCurrent(token)).toBe(true);
    guard.bump();
    expect(guard.isCurrent(token)).toBe(false);
  });

  it('out-of-order completion: a slower call started first must not win over a faster call started later', () => {
    const guard = createGenerationGuard();

    // Simulates two async operations: "slow" starts first, "fast" starts
    // second and supersedes it, then "fast" resolves before "slow" does.
    const slowToken = guard.bump();
    const fastToken = guard.bump();

    let applied: string | null = null;
    const applyIfCurrent = (label: string, token: number): void => {
      if (!guard.isCurrent(token)) return;
      applied = label;
    };

    // Fast resolves first — it is current, so it wins.
    applyIfCurrent('fast', fastToken);
    expect(applied).toBe('fast');

    // Slow resolves after, but its token is stale — it must be discarded,
    // not clobber the newer "fast" result.
    applyIfCurrent('slow', slowToken);
    expect(applied).toBe('fast');
  });

  it('each guard instance owns an independent counter', () => {
    const a = createGenerationGuard();
    const b = createGenerationGuard();
    a.bump();
    a.bump();
    expect(a.current()).toBe(2);
    expect(b.current()).toBe(0);
  });
});
