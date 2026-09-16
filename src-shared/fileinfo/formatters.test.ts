import { describe, it, expect } from 'vitest';
import { formatTimestamp, formatDuration } from './formatters';

// ── formatTimestamp ───────────────────────────────────────────────────────────

describe('formatTimestamp', () => {
  it('null returns em-dash', () => {
    expect(formatTimestamp(null)).toBe('\u2014');
  });

  it('undefined returns em-dash', () => {
    expect(formatTimestamp(undefined)).toBe('\u2014');
  });

  it('0 returns em-dash', () => {
    expect(formatTimestamp(0)).toBe('\u2014');
  });

  it('known nanosecond value produces a date string', () => {
    // 1700000000000000000 ns = 1700000000000 ms = 2023-11-14T22:13:20 UTC
    const result = formatTimestamp(1700000000000000000);
    // Should be a non-empty string that is not the em-dash
    expect(result).not.toBe('\u2014');
    expect(result.length).toBeGreaterThan(0);
    // The time component should appear in the output (22:13:20 in UTC)
    expect(result).toMatch(/22:13:20/);
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('(null, anything) returns null', () => {
    expect(formatDuration(null, 1000000000)).toBeNull();
  });

  it('(anything, null) returns null', () => {
    expect(formatDuration(1000000000, null)).toBeNull();
  });

  it('sub-second diff returns "Nms" format', () => {
    // 500ms = 500_000_000 ns
    const start = 1_000_000_000_000;
    const end = start + 500_000_000;
    expect(formatDuration(start, end)).toBe('500ms');
  });

  it('second-range diff returns "N.Ns" format', () => {
    // 2.5s = 2_500_000_000 ns
    const start = 1_000_000_000_000;
    const end = start + 2_500_000_000;
    expect(formatDuration(start, end)).toBe('2.5s');
  });

  it('minute-range returns "Nm Ns"', () => {
    // 2m 30s = 150_000 ms = 150_000_000_000 ns
    const start = 1_000_000_000_000;
    const end = start + 150_000_000_000;
    expect(formatDuration(start, end)).toBe('2m 30s');
  });

  it('hour-range returns "Nh Nm"', () => {
    // 1h 30m = 5400s = 5_400_000_000_000 ns
    const start = 1_000_000_000_000;
    const end = start + 5_400_000_000_000;
    expect(formatDuration(start, end)).toBe('1h 30m');
  });

  it('day-range returns "Nd Nh"', () => {
    // 2d 6h = 54h = 194_400s = 194_400_000_000_000 ns
    const start = 1_000_000_000_000;
    const end = start + 194_400_000_000_000;
    expect(formatDuration(start, end)).toBe('2d 6h');
  });

  it('negative diff returns null', () => {
    const start = 2_000_000_000_000;
    const end = 1_000_000_000_000;
    expect(formatDuration(start, end)).toBeNull();
  });
});
