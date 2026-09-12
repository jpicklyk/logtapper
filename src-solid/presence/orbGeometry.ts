/**
 * TypeScript port of `design_docs/canvas/orb.py`'s geometry generator — the
 * "network nucleus" agent orb: a sparse Fibonacci shell of nodes plus a
 * denser core, nearest-neighbour edges tiered for pulse speed, and two to
 * four concentric broken rings.
 *
 * Every function here is pure and framework-free: given a `size` (px
 * diameter) it returns plain data (positions in px, CSS transform strings,
 * background strings for the ring conic-gradients). `Orb.tsx` renders this
 * data; nothing here touches the DOM.
 *
 * Determinism: seeded with `size * 7 + 3` (the same seed orb.py uses) via a
 * small mulberry32 PRNG. This does NOT reproduce orb.py's exact node/edge
 * positions bit-for-bit — that would require porting Python's Mersenne
 * Twister — but it reproduces the same *algorithm* (same call sequence,
 * same distributions), so it is deterministic for a given size and its
 * node/ring counts match orb.py exactly (they are a pure function of
 * `size`, uninvolved with the RNG). Edge counts are close to but not
 * identical to any single orb.py run, because the k-nearest-neighbour graph
 * over jittered points is itself seed-sensitive in both implementations —
 * see `orbGeometry.test.ts` for the empirically-derived acceptable range.
 */

import type { AgentOrbState } from './agentState';

export type EdgeTier = 1 | 2 | 3 | 4;

export interface OrbNode {
  /** px, relative to the orb's own centre. */
  x: number;
  y: number;
  z: number;
  /** Core nodes render larger and brighter (`.orb__n--c`). */
  core: boolean;
  /** Negative animation-delay in seconds, so the pulse phase is desynchronized per node. */
  delaySec: number;
}

export interface OrbEdge {
  /** Index into the `nodes` array this edge connects (`a < b`, deduped). */
  a: number;
  b: number;
  tier: EdgeTier;
  /** Edge length in px — becomes the `--l` custom property (element width). */
  lengthPx: number;
  /** Negative animation-delay in seconds. */
  delaySec: number;
  /** `translate3d(...) rotateY(...) rotateZ(...)` — ready to drop into `style.transform`. */
  transform: string;
}

export interface OrbRing {
  /** 1-based, matches the `.orb__ring--N` modifier class. */
  index: number;
  /** Ring diameter as a percentage of the orb's own size (the `--rw` custom property). */
  widthPercent: number;
  /** Band thickness in px (the `--rt` custom property). */
  thicknessPx: number;
  /** Full-rotation period in seconds (the `--t` custom property). */
  periodSec: number;
  /** True → `--dir: reverse`. */
  reverse: boolean;
  /** Negative animation-delay in seconds (the `--dl` custom property). */
  delaySec: number;
  /** `conic-gradient(from 0deg, ...)` covering the full circle with no gaps or overlaps. */
  background: string;
}

export interface OrbExit {
  /** `calc(var(--orb-size) * <cos>)` — the `--ex` custom property. */
  dx: string;
  /** `calc(var(--orb-size) * <sin>)` — the `--ey` custom property. */
  dy: string;
  delaySec: number;
}

export interface OrbGeometry {
  size: number;
  /** Node diameter in px (the `--orb-dot` custom property). */
  dot: number;
  /** Edge thickness in px (the `--orb-line` custom property). */
  line: number;
  nodes: OrbNode[];
  edges: OrbEdge[];
  rings: OrbRing[];
  exits: OrbExit[];
}

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  random(): number {
    return this.next();
  }

  uniform(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  /** Positive weighted choice among `values`, mirroring Python's `random.choices`. */
  choiceWeighted<T>(values: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((sum, w) => sum + w, 0);
    let r = this.random() * total;
    for (let i = 0; i < values.length; i++) {
      r -= weights[i];
      if (r <= 0) return values[i];
    }
    return values[values.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Point generation — `_fib` / `_detail` in orb.py
// ---------------------------------------------------------------------------

type Point3 = readonly [number, number, number];

/** Fibonacci-sphere lattice of `n` unit points, optionally jittered and renormalized. */
function fibonacciSphere(n: number, rng: Rng, jitter: number): Point3[] {
  const pts: Point3[] = [];
  for (let i = 0; i < n; i++) {
    const y0 = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(Math.max(0, 1 - y0 * y0));
    const a = i * Math.PI * (3 - Math.sqrt(5));
    let x = Math.cos(a) * rad;
    let y = y0;
    let z = Math.sin(a) * rad;
    if (jitter) {
      x += rng.uniform(-jitter, jitter);
      y += rng.uniform(-jitter, jitter);
      z += rng.uniform(-jitter, jitter);
      const m = Math.sqrt(x * x + y * y + z * z) || 1;
      x /= m;
      y /= m;
      z /= m;
    }
    pts.push([x, y, z]);
  }
  return pts;
}

/** (shell node count, core node count) by orb diameter — a pure function of `size`, no RNG. */
export function detailCounts(size: number): [shell: number, core: number] {
  if (size < 24) return [10, 4];
  if (size < 40) return [18, 6];
  if (size < 80) return [30, 10];
  return [44, 14];
}

// ---------------------------------------------------------------------------
// Edges — `_edge` in orb.py
// ---------------------------------------------------------------------------

function distSq(p: Point3, q: Point3): number {
  const dx = p[0] - q[0];
  const dy = p[1] - q[1];
  const dz = p[2] - q[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Indices in `pool` nearest to `points[idx]`, excluding `idx` itself. */
function nearestIndices(points: readonly Point3[], idx: number, pool: readonly number[], k: number): number[] {
  const p = points[idx];
  return pool
    .filter((j) => j !== idx)
    .sort((j1, j2) => distSq(p, points[j1]) - distSq(p, points[j2]))
    .slice(0, k);
}

const EDGE_TIERS: readonly EdgeTier[] = [1, 2, 3, 4];
const EDGE_TIER_WEIGHTS: readonly number[] = [18, 27, 30, 25];

function edgeGeometry(p: Point3, q: Point3, rng: Rng, tier: EdgeTier, delayMaxSec: number, a: number, b: number): OrbEdge {
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  const mz = (p[2] + q[2]) / 2;
  let dx = q[0] - p[0];
  let dy = q[1] - p[1];
  let dz = q[2] - p[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= length;
  dy /= length;
  dz /= length;
  const theta = radToDeg(Math.asin(clamp(dy, -1, 1)));
  const phi = radToDeg(Math.atan2(-dz, dx));
  const delaySec = -rng.uniform(0, delayMaxSec);
  return {
    a,
    b,
    tier,
    lengthPx: length,
    delaySec,
    transform: `translate3d(${mx.toFixed(1)}px,${my.toFixed(1)}px,${mz.toFixed(1)}px) rotateY(${phi.toFixed(1)}deg) rotateZ(${theta.toFixed(1)}deg)`,
  };
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Rings — `_rings` / the conic-gradient ring band in orb.py
// ---------------------------------------------------------------------------

export interface RingSpec {
  /** Fraction of the orb's own size (0-1). */
  widthFraction: number;
  thicknessPx: number;
  periodSec: number;
  reverse: boolean;
  /** Fine "tick" ring: many short bright arcs instead of a few long ones. */
  ticks: boolean;
}

/** (diameter fraction, thickness px, period s, reverse, ticks) by orb diameter — pure, no RNG. Tilt is always 0: rings face the viewer. */
export function ringSpecs(size: number): RingSpec[] {
  if (size < 24) {
    return [{ widthFraction: 1.0, thicknessPx: 1.5, periodSec: 20, reverse: false, ticks: false }];
  }
  if (size < 40) {
    return [
      { widthFraction: 0.84, thicknessPx: 1.5, periodSec: 22, reverse: false, ticks: false },
      { widthFraction: 1.0, thicknessPx: 1.0, periodSec: 13, reverse: true, ticks: false },
    ];
  }
  if (size < 80) {
    return [
      { widthFraction: 0.72, thicknessPx: Math.max(2.0, size / 32), periodSec: 24, reverse: false, ticks: false },
      { widthFraction: 0.86, thicknessPx: 1.0, periodSec: 10, reverse: true, ticks: true },
      { widthFraction: 1.0, thicknessPx: Math.max(1.5, size / 60), periodSec: 50, reverse: false, ticks: false },
    ];
  }
  return [
    { widthFraction: 0.68, thicknessPx: size / 36, periodSec: 26, reverse: false, ticks: false },
    { widthFraction: 0.79, thicknessPx: Math.max(1.0, size / 110), periodSec: 11, reverse: true, ticks: true },
    { widthFraction: 0.9, thicknessPx: size / 64, periodSec: 44, reverse: false, ticks: false },
    { widthFraction: 1.0, thicknessPx: size / 80, periodSec: 70, reverse: true, ticks: false },
  ];
}

type StopColor = 'bright' | 'dim' | 'transparent';

interface RingStop {
  color: StopColor;
  fromDeg: number;
  toDeg: number;
}

/**
 * A conic-gradient stop list of arcs (bright/dim, weighted 45/55) separated
 * by transparent gaps, covering exactly 0–360deg with no overlap. Ticked
 * rings use many short arcs (2-6deg) and short gaps (4-14deg); normal rings
 * use long arcs (22-85deg) and wider gaps (10-30deg).
 */
function ringStops(rng: Rng, ticks: boolean): RingStop[] {
  const stops: RingStop[] = [];
  let a = 0;
  while (a < 360) {
    let arc = ticks ? rng.uniform(2, 6) : rng.uniform(22, 85);
    const gapRange: [number, number] = ticks ? [4, 14] : [10, 30];
    arc = Math.min(arc, 360 - a);
    const color: StopColor = rng.random() < 0.45 ? 'bright' : 'dim';
    stops.push({ color, fromDeg: a, toDeg: a + arc });
    a += arc;
    if (a < 360) {
      let gap = rng.uniform(gapRange[0], gapRange[1]);
      gap = Math.min(gap, 360 - a);
      stops.push({ color: 'transparent', fromDeg: a, toDeg: a + gap });
      a += gap;
    }
  }
  return stops;
}

/**
 * The bright/dim stop colours are `color-mix`ed from `--c` (the state
 * token); the highlight end mixes toward `--text-on-accent` rather than a
 * literal white, per the no-colour-literals-outside-tokens.css rule.
 */
const STOP_EXPR: Record<StopColor, string> = {
  bright: 'color-mix(in srgb, var(--c) 85%, var(--text-on-accent))',
  dim: 'color-mix(in srgb, var(--c) 72%, transparent)',
  transparent: 'transparent',
};

function ringBackground(stops: readonly RingStop[]): string {
  const parts = stops.map((s) => `${STOP_EXPR[s.color]} ${s.fromDeg.toFixed(0)}deg ${s.toDeg.toFixed(0)}deg`);
  return `conic-gradient(from 0deg, ${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Top-level generator
// ---------------------------------------------------------------------------

/**
 * Builds the full geometry for one orb size. Deterministic: the same `size`
 * always returns the same node/edge/ring data (seeded on `size * 7 + 3`,
 * matching orb.py).
 */
export function generateOrbGeometry(size: number): OrbGeometry {
  const rng = new Rng(size * 7 + 3);
  const [nShell, nCore] = detailCounts(size);
  const specs = ringSpecs(size);

  const r = (size / 2 - 2) * (size >= 40 ? 0.4 : 0.55);
  const dot = Math.max(2, Math.round(size / 40));
  const line = size < 80 ? 1 : 1.5;

  const shellUnit = fibonacciSphere(nShell, rng, 0.08);
  const coreUnit = fibonacciSphere(nCore, rng, 0.25);
  const shell: Point3[] = shellUnit.map(([x, y, z]) => [x * r, y * r, z * r]);
  const core: Point3[] = coreUnit.map(([x, y, z]) => [x * r * 0.42, y * r * 0.42, z * r * 0.42]);
  const allPts: Point3[] = [...shell, ...core];

  const shellRange = Array.from({ length: nShell }, (_, i) => i);
  const coreRange = Array.from({ length: nCore }, (_, i) => nShell + i);

  const edgeKeys = new Set<string>();
  const edgePairs: Array<[number, number]> = [];
  function addEdge(i: number, j: number): void {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = `${a}-${b}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edgePairs.push([a, b]);
    }
  }
  for (const i of shellRange) {
    for (const j of nearestIndices(allPts, i, shellRange, 2)) addEdge(i, j);
  }
  for (const i of coreRange) {
    for (const j of nearestIndices(allPts, i, coreRange, 2)) addEdge(i, j);
    for (const j of nearestIndices(allPts, i, shellRange, 1)) addEdge(i, j);
  }
  edgePairs.sort((p, q) => (p[0] - q[0] || p[1] - q[1]));

  const edges: OrbEdge[] = edgePairs.map(([a, b]) => {
    const tier = rng.choiceWeighted(EDGE_TIERS, EDGE_TIER_WEIGHTS);
    return edgeGeometry(allPts[a], allPts[b], rng, tier, 3, a, b);
  });

  const nodes: OrbNode[] = [
    ...shell.map(([x, y, z]): OrbNode => ({ x, y, z, core: false, delaySec: -rng.uniform(0, 7) })),
    ...core.map(([x, y, z]): OrbNode => ({ x, y, z, core: true, delaySec: -rng.uniform(0, 7) })),
  ];

  const rings: OrbRing[] = specs.map((spec, i) => {
    const stops = ringStops(rng, spec.ticks);
    return {
      index: i + 1,
      widthPercent: spec.widthFraction * 100,
      thicknessPx: spec.thicknessPx,
      periodSec: spec.periodSec,
      reverse: spec.reverse,
      delaySec: -rng.uniform(0, spec.periodSec),
      background: ringBackground(stops),
    };
  });

  const exits: OrbExit[] = Array.from({ length: 3 }, () => {
    const a = rng.uniform(0, 2 * Math.PI);
    return {
      dx: `calc(var(--orb-size) * ${(0.5 * Math.cos(a)).toFixed(3)})`,
      dy: `calc(var(--orb-size) * ${(0.5 * Math.sin(a)).toFixed(3)})`,
      delaySec: -rng.uniform(0, 5),
    };
  });

  return { size, dot, line, nodes, edges, rings, exits };
}

/** State → the `--orb-c` custom property value (`detached` reuses the idle token, dimmed by `.orb--detached`'s opacity). */
export function orbColorToken(state: AgentOrbState): string {
  const key = state === 'detached' ? 'idle' : state;
  return `var(--agent-${key})`;
}
