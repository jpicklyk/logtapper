import { describe, it, expect } from 'vitest';
import { formatTs, fmtDuration, linePct, niceLineStep, doZoom, doPan } from './timelineUtils';

// ── formatTs ──────────────────────────────────────────────────────────────────

describe('formatTs', () => {
  // 2024-03-15 14:25:36.789 UTC in nanoseconds
  // Compute ms precisely: new Date('2024-03-15T14:25:36.789Z').getTime()
  const msForKnown = new Date('2024-03-15T14:25:36.789Z').getTime();
  const nsForKnown = msForKnown * 1_000_000;

  it('returns HH:MM:SS.mmm without date by default', () => {
    expect(formatTs(nsForKnown)).toBe('14:25:36.789');
  });

  it('returns MM-DD HH:MM:SS.mmm with includeDate=true', () => {
    expect(formatTs(nsForKnown, true)).toBe('03-15 14:25:36.789');
  });

  it('pads hours, minutes, seconds with leading zeros', () => {
    // 2024-01-02 03:04:05.006 UTC
    const d = new Date('2024-01-02T03:04:05.006Z').getTime() * 1_000_000;
    expect(formatTs(d)).toBe('03:04:05.006');
  });

  it('includes date with zero-padded month and day', () => {
    const d = new Date('2024-01-02T03:04:05.006Z').getTime() * 1_000_000;
    expect(formatTs(d, true)).toBe('01-02 03:04:05.006');
  });
});

// ── fmtDuration ───────────────────────────────────────────────────────────────

describe('fmtDuration', () => {
  it('sub-ms: returns microseconds', () => {
    expect(fmtDuration(500_000)).toBe('500.0us');
  });

  it('sub-ms boundary exactly 1_000 ns', () => {
    expect(fmtDuration(1_000)).toBe('1.0us');
  });

  it('milliseconds: 5_000_000 ns = 5ms', () => {
    expect(fmtDuration(5_000_000)).toBe('5ms');
  });

  it('seconds: 2.5e9 ns = 2.50s', () => {
    expect(fmtDuration(2_500_000_000)).toBe('2.50s');
  });

  it('minutes: 90e9 ns = 1.5m', () => {
    expect(fmtDuration(90_000_000_000)).toBe('1.5m');
  });

  it('hours: 7200e9 ns = 2.00h', () => {
    expect(fmtDuration(7_200_000_000_000)).toBe('2.00h');
  });
});

// ── linePct ───────────────────────────────────────────────────────────────────

describe('linePct', () => {
  it('middle of viewport → near 50%', () => {
    // vpS=0, vpSpan=1, lineNum=500, maxLine=1000 → 50%
    expect(linePct(500, 1000, 0, 1)).toBe('50.0000%');
  });

  it('start of viewport → 0%', () => {
    expect(linePct(0, 1000, 0, 1)).toBe('0.0000%');
  });

  it('end of viewport → 100%', () => {
    expect(linePct(1000, 1000, 0, 1)).toBe('100.0000%');
  });

  it('zoomed viewport: lineNum at vpS edge → 0%', () => {
    // vpS=0.5, vpSpan=0.5, lineNum=500, maxLine=1000 → norm=0.5 → (0.5-0.5)/0.5*100=0%
    expect(linePct(500, 1000, 0.5, 0.5)).toBe('0.0000%');
  });

  it('zoomed viewport: lineNum at vpE edge → 100%', () => {
    // vpS=0.5, vpSpan=0.5, lineNum=1000, maxLine=1000 → (1-0.5)/0.5*100=100%
    expect(linePct(1000, 1000, 0.5, 0.5)).toBe('100.0000%');
  });
});

// ── niceLineStep ──────────────────────────────────────────────────────────────

describe('niceLineStep', () => {
  it('rounds up to 1 for raw <= 1', () => {
    expect(niceLineStep(0.5)).toBe(1);
    expect(niceLineStep(1)).toBe(1);
  });

  it('rounds up to 2 for raw in (1, 2]', () => {
    expect(niceLineStep(1.5)).toBe(2);
    expect(niceLineStep(2)).toBe(2);
  });

  it('snaps to 5 for raw=3', () => {
    expect(niceLineStep(3)).toBe(5);
  });

  it('snaps to 100 for raw=80', () => {
    expect(niceLineStep(80)).toBe(100);
  });

  it('snaps to 1000 for raw=999', () => {
    expect(niceLineStep(999)).toBe(1000);
  });

  it('returns max step for raw > 100000', () => {
    expect(niceLineStep(200000)).toBe(100000);
  });
});

// ── doZoom ────────────────────────────────────────────────────────────────────

describe('doZoom', () => {
  it('zoom in at center narrows span', () => {
    const [ns, ne] = doZoom([0, 1], 0.5, true);
    expect(ne - ns).toBeLessThan(1);
    expect(ne - ns).toBeGreaterThan(0);
  });

  it('zoom out at center widens span toward 1', () => {
    const [ns, ne] = doZoom([0.2, 0.8], 0.5, false);
    expect(ne - ns).toBeGreaterThan(0.6);
  });

  it('clamped: zoomed out past full range stays [0,1]', () => {
    const [ns, ne] = doZoom([0, 1], 0.5, false);
    expect(ns).toBe(0);
    expect(ne).toBe(1);
  });

  it('clamped: ns cannot go below 0', () => {
    const [ns] = doZoom([0, 0.2], 0, true);
    expect(ns).toBeGreaterThanOrEqual(0);
  });

  it('clamped: ne cannot exceed 1', () => {
    const [, ne] = doZoom([0.8, 1], 1, true);
    expect(ne).toBeLessThanOrEqual(1);
  });

  it('minimum span is approximately 0.0005', () => {
    // Start at exactly the minimum span, zoom in further — clamp keeps it at ~0.0005
    const [ns, ne] = doZoom([0.4, 0.9], 0.5, true);
    // After many zoom-ins the span should not go below the 0.0005 clamp
    let vp: readonly [number, number] = [ns, ne];
    for (let i = 0; i < 50; i++) {
      vp = doZoom(vp, 0.5, true);
    }
    expect(vp[1] - vp[0]).toBeGreaterThanOrEqual(0.0005 - 1e-10);
  });
});

// ── doPan ─────────────────────────────────────────────────────────────────────

describe('doPan', () => {
  it('pans forward by deltaNorm', () => {
    const [ns, ne] = doPan([0, 0.5], 0.1);
    expect(ns).toBeCloseTo(0.1);
    expect(ne).toBeCloseTo(0.6);
  });

  it('clamped: cannot pan before 0', () => {
    const [ns] = doPan([0.1, 0.5], -0.5);
    expect(ns).toBeGreaterThanOrEqual(0);
  });

  it('clamped: cannot pan past end', () => {
    const [, ne] = doPan([0.6, 1], 0.5);
    expect(ne).toBeLessThanOrEqual(1);
  });

  it('preserves span after pan', () => {
    const vp: readonly [number, number] = [0.2, 0.7];
    const span = vp[1] - vp[0];
    const [ns, ne] = doPan(vp, 0.1);
    expect(ne - ns).toBeCloseTo(span);
  });
});
