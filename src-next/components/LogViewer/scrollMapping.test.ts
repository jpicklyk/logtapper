import { describe, it, expect } from 'vitest';
import { absoluteLineToFilteredIndex } from './scrollMapping';

describe('absoluteLineToFilteredIndex', () => {
  // Simulate two bugreport sections:
  //   "SYSTEM LOG" lines 100-199
  //   "KERNEL LOG" lines 300-399
  const filtered = [
    ...Array.from({ length: 100 }, (_, i) => 100 + i),  // 100..199
    ...Array.from({ length: 100 }, (_, i) => 300 + i),  // 300..399
  ];

  it('returns null for empty filtered array', () => {
    expect(absoluteLineToFilteredIndex(50, [])).toBeNull();
  });

  it('finds exact match at the start of first section', () => {
    expect(absoluteLineToFilteredIndex(100, filtered)).toBe(0);
  });

  it('finds exact match at the end of first section', () => {
    expect(absoluteLineToFilteredIndex(199, filtered)).toBe(99);
  });

  it('finds exact match at the start of second section', () => {
    // Line 300 is at filtered index 100 (100 lines from first section)
    expect(absoluteLineToFilteredIndex(300, filtered)).toBe(100);
  });

  it('finds exact match at the end of second section', () => {
    expect(absoluteLineToFilteredIndex(399, filtered)).toBe(199);
  });

  it('finds exact match in the middle of a section', () => {
    expect(absoluteLineToFilteredIndex(150, filtered)).toBe(50);
    expect(absoluteLineToFilteredIndex(350, filtered)).toBe(150);
  });

  it('snaps to nearest visible line when target is in the gap between sections', () => {
    // Line 250 is between sections. Nearest filtered line >= 250 is 300 (index 100).
    expect(absoluteLineToFilteredIndex(250, filtered)).toBe(100);
  });

  it('snaps to nearest visible line when target is before all sections', () => {
    // Line 50 is before any filtered content. Nearest is 100 (index 0).
    expect(absoluteLineToFilteredIndex(50, filtered)).toBe(0);
  });

  it('clamps to last index when target is beyond all sections', () => {
    // Line 500 is after all filtered content. Should clamp to last index.
    expect(absoluteLineToFilteredIndex(500, filtered)).toBe(199);
  });

  // --- Regression: this is the exact scenario the bug manifests ---
  it('correctly maps section start lines used by onJumpToLine', () => {
    // Section panel calls onJumpToLine(startLine) with the absolute line.
    // With sections SYSTEM LOG (100-199) and KERNEL LOG (300-399) filtered,
    // clicking "KERNEL LOG" should scroll to filtered index 100, not absolute 300.
    const kernelLogStart = 300;
    const idx = absoluteLineToFilteredIndex(kernelLogStart, filtered);
    expect(idx).toBe(100);

    // And SYSTEM LOG at line 100 should map to index 0.
    const systemLogStart = 100;
    const idx2 = absoluteLineToFilteredIndex(systemLogStart, filtered);
    expect(idx2).toBe(0);
  });

  it('works with a single-element filtered array', () => {
    expect(absoluteLineToFilteredIndex(42, [42])).toBe(0);
    expect(absoluteLineToFilteredIndex(10, [42])).toBe(0);
    expect(absoluteLineToFilteredIndex(99, [42])).toBe(0);
  });
});
