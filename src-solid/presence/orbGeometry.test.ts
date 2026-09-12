import { describe, expect, it } from 'vitest';
import { detailCounts, generateOrbGeometry, orbColorToken, ringSpecs } from './orbGeometry';

const SIZES = [18, 26, 36, 44, 56, 96, 104, 140] as const;

/**
 * orb.py's edge count is itself RNG-sensitive (the k-nearest-neighbour graph
 * over jittered Fibonacci-sphere points varies with the exact jitter draw),
 * so an exact cross-language match isn't a meaningful assertion — instead
 * these are the empirically observed min/max edge counts across 500 orb.py
 * seeds per size (see the task's implementation notes), widened by a few
 * edges as a safety margin for this port's different PRNG.
 */
const EDGE_COUNT_RANGE: Record<(typeof SIZES)[number], [number, number]> = {
  18: [16, 24],
  26: [29, 39],
  36: [29, 39],
  44: [52, 64],
  56: [52, 64],
  96: [75, 92],
  104: [75, 92],
  140: [75, 92],
};

// orb.py's `_detail(size)` — pure function of size, no RNG involved.
const EXPECTED_NODE_COUNTS: Record<(typeof SIZES)[number], [shell: number, core: number]> = {
  18: [10, 4],
  26: [18, 6],
  36: [18, 6],
  44: [30, 10],
  56: [30, 10],
  96: [44, 14],
  104: [44, 14],
  140: [44, 14],
};

// orb.py's `_rings(size)` — pure function of size, no RNG involved.
const EXPECTED_RING_COUNTS: Record<(typeof SIZES)[number], number> = {
  18: 1,
  26: 2,
  36: 2,
  44: 3,
  56: 3,
  96: 4,
  104: 4,
  140: 4,
};

describe('detailCounts / ringSpecs', () => {
  it('match orb.py _detail(size) exactly for every reference size', () => {
    for (const size of SIZES) {
      expect(detailCounts(size)).toEqual(EXPECTED_NODE_COUNTS[size]);
    }
  });

  it('match orb.py _rings(size) ring counts exactly for every reference size', () => {
    for (const size of SIZES) {
      expect(ringSpecs(size)).toHaveLength(EXPECTED_RING_COUNTS[size]);
    }
  });

  it('rings all use tilt 0 (face the viewer) — no tilt field leaks a non-zero value', () => {
    // RingSpec intentionally has no `tilt` field (always 0 per orb.py), so this
    // just guards that nothing reintroduces one with a nonzero default.
    for (const size of SIZES) {
      for (const spec of ringSpecs(size)) {
        expect(spec).not.toHaveProperty('tilt');
      }
    }
  });
});

describe('generateOrbGeometry — determinism', () => {
  it('is deterministic for a given size (repeated calls produce identical geometry)', () => {
    for (const size of SIZES) {
      const a = generateOrbGeometry(size);
      const b = generateOrbGeometry(size);
      expect(b).toEqual(a);
    }
  });

  it('produces different geometry for different sizes', () => {
    const g18 = generateOrbGeometry(18);
    const g26 = generateOrbGeometry(26);
    expect(g18).not.toEqual(g26);
  });
});

describe('generateOrbGeometry — node/edge/ring counts', () => {
  for (const size of SIZES) {
    it(`size ${size}: node and ring counts match orb.py exactly; edge count falls in orb.py's observed range`, () => {
      const geo = generateOrbGeometry(size);
      const [shell, core] = EXPECTED_NODE_COUNTS[size];
      expect(geo.nodes.filter((n) => !n.core)).toHaveLength(shell);
      expect(geo.nodes.filter((n) => n.core)).toHaveLength(core);
      expect(geo.rings).toHaveLength(EXPECTED_RING_COUNTS[size]);

      const [min, max] = EDGE_COUNT_RANGE[size];
      expect(geo.edges.length).toBeGreaterThanOrEqual(min);
      expect(geo.edges.length).toBeLessThanOrEqual(max);
    });
  }
});

describe('generateOrbGeometry — edge validity', () => {
  it('every edge references two distinct, in-range node indices', () => {
    for (const size of SIZES) {
      const geo = generateOrbGeometry(size);
      for (const edge of geo.edges) {
        expect(edge.a).toBeGreaterThanOrEqual(0);
        expect(edge.a).toBeLessThan(geo.nodes.length);
        expect(edge.b).toBeGreaterThanOrEqual(0);
        expect(edge.b).toBeLessThan(geo.nodes.length);
        expect(edge.a).not.toBe(edge.b);
        expect(edge.a).toBeLessThan(edge.b); // canonical (min, max) form
      }
    }
  });

  it('has no duplicate edges', () => {
    for (const size of SIZES) {
      const geo = generateOrbGeometry(size);
      const keys = new Set(geo.edges.map((e) => `${e.a}-${e.b}`));
      expect(keys.size).toBe(geo.edges.length);
    }
  });

  it('every edge has a tier in 1-4 and a non-positive delay (negative animation-delay)', () => {
    for (const size of SIZES) {
      for (const edge of generateOrbGeometry(size).edges) {
        expect(edge.tier).toBeGreaterThanOrEqual(1);
        expect(edge.tier).toBeLessThanOrEqual(4);
        expect(edge.delaySec).toBeLessThanOrEqual(0);
        expect(edge.transform).toMatch(/^translate3d\(.+\) rotateY\(.+deg\) rotateZ\(.+deg\)$/);
      }
    }
  });
});

describe('generateOrbGeometry — ring stop coverage', () => {
  it('every ring background covers exactly 0-360deg with contiguous, non-overlapping stops', () => {
    for (const size of SIZES) {
      for (const ring of generateOrbGeometry(size).rings) {
        // The background is a conic-gradient string; extract the "<colour> <from>deg <to>deg" stops.
        const stops = Array.from(ring.background.matchAll(/([\w().,%\- ]+?) (\d+)deg (\d+)deg/g)).map((m) => ({
          from: Number(m[2]),
          to: Number(m[3]),
        }));
        expect(stops.length).toBeGreaterThan(0);
        expect(stops[0].from).toBe(0);
        expect(stops[stops.length - 1].to).toBe(360);
        for (let i = 1; i < stops.length; i++) {
          expect(stops[i].from).toBe(stops[i - 1].to); // contiguous, no gap or overlap
        }
        for (const stop of stops) {
          // Degrees are rounded to whole numbers for display (matching orb.py's
          // own `:.0f` formatting) — a segment can round to zero width right at
          // the 360deg seam from floating-point summation drift, exactly as it
          // can in orb.py. That's a harmless sliver, not an overlap or a gap.
          expect(stop.to).toBeGreaterThanOrEqual(stop.from);
        }
      }
    }
  });
});

describe('generateOrbGeometry — exits', () => {
  it('always generates exactly 3 exit dots with calc() offsets and a non-positive delay', () => {
    for (const size of SIZES) {
      const geo = generateOrbGeometry(size);
      expect(geo.exits).toHaveLength(3);
      for (const exit of geo.exits) {
        expect(exit.dx).toMatch(/^calc\(var\(--orb-size\) \* -?\d+\.\d+\)$/);
        expect(exit.dy).toMatch(/^calc\(var\(--orb-size\) \* -?\d+\.\d+\)$/);
        expect(exit.delaySec).toBeLessThanOrEqual(0);
      }
    }
  });
});

describe('orbColorToken', () => {
  it('maps every state to its var(--agent-*) token, with detached reusing the idle token', () => {
    expect(orbColorToken('detached')).toBe('var(--agent-idle)');
    expect(orbColorToken('idle')).toBe('var(--agent-idle)');
    expect(orbColorToken('reading')).toBe('var(--agent-reading)');
    expect(orbColorToken('running')).toBe('var(--agent-running)');
    expect(orbColorToken('wrote')).toBe('var(--agent-wrote)');
    expect(orbColorToken('needs')).toBe('var(--agent-needs)');
    expect(orbColorToken('raw')).toBe('var(--agent-raw)');
  });
});
