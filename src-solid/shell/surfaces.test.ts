import { describe, expect, it } from 'vitest';
import { TIERS } from './tier';
import type { Tier } from './tier';
import type { Mode } from './mode';
import {
  REGION_ORDER,
  SURFACES,
  activeRegions,
  drawerSurfaces,
  existsInMode,
  placementFor,
  railSurfaces,
  regionSurfaces,
  surfaceById,
} from './surfaces';

const MODES: readonly Mode[] = ['postmortem', 'live'];

describe('surface map', () => {
  it('has a unique id, a title and a one-line description per surface', () => {
    const ids = SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const surface of SURFACES) {
      expect(surface.title.length).toBeGreaterThan(0);
      expect(surface.description.length).toBeGreaterThan(0);
      expect(surface.modes.length).toBeGreaterThan(0);
      expect(surface.placement).toHaveLength(TIERS.length);
    }
  });

  it('gives every surface a distinct two-letter rail glyph', () => {
    // The rail once derived the glyph from the title's first two letters, so
    // Sections and Settings both read "SE" and Analyzers and Analyses "AN".
    const glyphs = SURFACES.map((s) => s.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    for (const glyph of glyphs) expect(glyph).toMatch(/^[A-Z]{2}$/);
  });

  it('places every surface at every tier of every mode it exists in', () => {
    for (const surface of SURFACES) {
      for (const mode of MODES) {
        for (const tier of TIERS) {
          const placement = placementFor(surface.id, mode, tier);
          if (!surface.modes.includes(mode)) {
            expect(placement).toBeNull();
            continue;
          }
          // Nothing is hidden below a tier (brief §6.2).
          expect(placement).not.toBeNull();
          expect(['region', 'rail', 'drawer']).toContain(placement?.kind);
          if (placement?.kind === 'region') {
            expect(REGION_ORDER).toContain(placement.region);
          }
        }
      }
    }
  });

  it('reaches every surface of a mode from a region, the rail or a drawer', () => {
    for (const mode of MODES) {
      for (const tier of TIERS) {
        const reachable = new Set([
          ...REGION_ORDER.flatMap((region) => regionSurfaces(region, mode, tier)).map((s) => s.id),
          ...railSurfaces(mode, tier).map((s) => s.id),
          ...drawerSurfaces(mode, tier).map((s) => s.id),
        ]);
        for (const surface of SURFACES) {
          expect(reachable.has(surface.id)).toBe(surface.modes.includes(mode));
        }
      }
    }
  });

  it('ties mode-only surfaces to their mode', () => {
    expect(existsInMode('watches', 'live')).toBe(true);
    expect(existsInMode('watches', 'postmortem')).toBe(false);
    expect(existsInMode('stream-controls', 'postmortem')).toBe(false);
    expect(existsInMode('sections', 'live')).toBe(false);
    expect(existsInMode('analyses', 'live')).toBe(false);
    expect(existsInMode('timeline', 'live')).toBe(false);
    for (const id of ['viewer', 'analyzers', 'device-state', 'bookmarks', 'presence'] as const) {
      expect(existsInMode(id, 'postmortem')).toBe(true);
      expect(existsInMode(id, 'live')).toBe(true);
    }
  });

  it('collapses navigator and presence to rails and analyzers to a drawer on compact', () => {
    for (const mode of MODES) {
      const railIds = railSurfaces(mode, 'compact').map((s) => s.id);
      expect(railIds).toContain('presence');
      expect(railIds).toContain('bookmarks');
      expect(regionSurfaces('navigator', mode, 'compact')).toHaveLength(0);
      expect(regionSurfaces('presence', mode, 'compact')).toHaveLength(0);

      const drawerIds = drawerSurfaces(mode, 'compact').map((s) => s.id);
      expect(drawerIds).toContain('analyzers');
      expect(drawerIds).toContain('device-state');

      // Only the rail and the single centre column remain.
      expect(activeRegions(mode, 'compact')).toEqual(['viewer']);
    }
  });

  it('gives analyses its own column only from wide up, between details and presence', () => {
    // Analyses is a post-mortem surface; live mode never places it anywhere.
    expect(placementFor('analyses', 'postmortem', 'standard')).toEqual({ kind: 'region', region: 'details' });
    for (const tier of ['wide', 'ultrawide'] as Tier[]) {
      expect(placementFor('analyses', 'postmortem', tier)).toEqual({ kind: 'region', region: 'analyses' });
      expect(regionSurfaces('analyses', 'postmortem', tier).map((s) => s.id)).toEqual(['analyses']);
      expect(placementFor('analyses', 'live', tier)).toBeNull();
      expect(activeRegions('live', tier)).toEqual(['navigator', 'viewer', 'details', 'presence']);
    }
    expect(regionSurfaces('analyses', 'postmortem', 'standard')).toHaveLength(0);
  });

  it('gives presence its own column only from wide up', () => {
    for (const mode of MODES) {
      expect(placementFor('presence', mode, 'standard')).toEqual({
        kind: 'region',
        region: 'details',
      });
      for (const tier of ['wide', 'ultrawide'] as Tier[]) {
        expect(placementFor('presence', mode, tier)).toEqual({
          kind: 'region',
          region: 'presence',
        });
        expect(activeRegions(mode, tier)).toEqual(
          mode === 'postmortem'
            ? ['navigator', 'viewer', 'details', 'analyses', 'presence']
            : ['navigator', 'viewer', 'details', 'presence'],
        );
      }
      expect(activeRegions(mode, 'standard')).toEqual(['navigator', 'viewer', 'details']);
    }
  });

  it('returns null for an unknown surface and undefined from surfaceById', () => {
    // @ts-expect-error — guarding the runtime path a future surface id could hit.
    expect(placementFor('not-a-surface', 'live', 'wide')).toBeNull();
    // @ts-expect-error — same.
    expect(surfaceById('not-a-surface')).toBeUndefined();
    expect(surfaceById('viewer')?.title).toBe('Viewer');
  });
});
