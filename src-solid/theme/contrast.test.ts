import { describe, expect, it } from 'vitest';
import { contrastRatio, hexToRgb, relativeLuminance } from './contrast';

describe('hexToRgb', () => {
  it('parses 6-digit hex', () => {
    expect(hexToRgb('#58a6ff')).toEqual({ r: 0x58, g: 0xa6, b: 0xff });
  });

  it('parses 3-digit hex by doubling each nibble', () => {
    expect(hexToRgb('#0f8')).toEqual({ r: 0, g: 0xff, b: 0x88 });
  });

  it('parses 8-digit hex, ignoring alpha', () => {
    expect(hexToRgb('#58a6ff80')).toEqual({ r: 0x58, g: 0xa6, b: 0xff });
  });

  it('parses 4-digit hex, ignoring alpha', () => {
    expect(hexToRgb('#0f8c')).toEqual({ r: 0, g: 0xff, b: 0x88 });
  });

  it('parses rgb()', () => {
    expect(hexToRgb('rgb(88, 166, 255)')).toEqual({ r: 88, g: 166, b: 255 });
  });

  it('parses rgba(), ignoring alpha', () => {
    expect(hexToRgb('rgba(88, 166, 255, 0.4)')).toEqual({ r: 88, g: 166, b: 255 });
  });

  it('parses rgb() with percentage channels', () => {
    expect(hexToRgb('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('throws on an unsupported format', () => {
    expect(() => hexToRgb('not-a-color')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black', () => {
    expect(relativeLuminance(hexToRgb('#000000'))).toBeCloseTo(0, 5);
  });

  it('is 1 for white', () => {
    expect(relativeLuminance(hexToRgb('#ffffff'))).toBeCloseTo(1, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white (the maximum WCAG ratio)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is 1:1 for a colour against itself', () => {
    expect(contrastRatio('#58a6ff', '#58a6ff')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    const a = contrastRatio('#0c1014', '#b8c4ce');
    const b = contrastRatio('#b8c4ce', '#0c1014');
    expect(a).toBeCloseTo(b, 10);
  });

  it('matches a known mid-range pair (dark theme text on surface)', () => {
    // #b8c4ce on #0c1014 — independently computed via the WCAG formula.
    expect(contrastRatio('#b8c4ce', '#0c1014')).toBeCloseTo(10.75, 1);
  });

  it('matches a known mid-range pair (light theme accent on surface)', () => {
    // #0863cd on #ffffff — independently computed via the WCAG formula.
    expect(contrastRatio('#0863cd', '#ffffff')).toBeCloseTo(5.71, 1);
  });
});
