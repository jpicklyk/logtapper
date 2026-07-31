/**
 * Tests for `intersectAllSorted` — the effective-line-nums intersection used
 * by PaneContent to combine section filter, stream filter, and time filter
 * results into the set of lines actually shown by the viewer.
 *
 * Reconnects the time filter (`useFilterScan.setTimeFilter` /
 * `timeFilterLineNums`) to the viewer: previously PaneContent only
 * intersected `sectionFilteredLineNums` and `filteredLineNums`, so a
 * time-range search computed results that nothing displayed.
 */
import { describe, it, expect } from 'vitest';
import { intersectAllSorted } from './utils';

describe('intersectAllSorted', () => {
  it('returns null when every filter is inactive', () => {
    expect(intersectAllSorted([null, null, null])).toBeNull();
  });

  it('returns the sole active filter unchanged when only one is active', () => {
    expect(intersectAllSorted([null, [1, 2, 3], null])).toEqual([1, 2, 3]);
  });

  it('intersects two active filters', () => {
    expect(intersectAllSorted([[1, 2, 3, 4], [2, 4, 6]])).toEqual([2, 4]);
  });

  it('intersects three active filters (section ∩ stream ∩ time)', () => {
    const section = [1, 2, 3, 4, 5, 6];
    const stream = [2, 3, 4, 5];
    const time = [3, 4, 5, 6];
    expect(intersectAllSorted([section, stream, time])).toEqual([3, 4, 5]);
  });

  it('is order-independent — same result regardless of array order', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [3, 4, 5, 6, 7];
    const c = [4, 5, 6];
    const forward = intersectAllSorted([a, b, c]);
    const reversed = intersectAllSorted([c, b, a]);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([4, 5]);
  });

  it('an empty active filter narrows the result to empty', () => {
    expect(intersectAllSorted([[1, 2, 3], []])).toEqual([]);
  });

  it('treats an empty array as active (not the same as null/inactive)', () => {
    // An active filter matching zero lines must still narrow — it must not
    // be treated the same as an inactive (null) filter, which would fall
    // back to showing everything.
    expect(intersectAllSorted([null, []])).toEqual([]);
  });

  it('clearing the time filter (null) restores the section ∩ stream result', () => {
    const section = [1, 2, 3, 4];
    const stream = [2, 3, 4, 5];
    // Time filter active, narrowing further.
    expect(intersectAllSorted([section, stream, [3, 4]])).toEqual([3, 4]);
    // Time filter cleared → back to just section ∩ stream.
    expect(intersectAllSorted([section, stream, null])).toEqual([2, 3, 4]);
  });
});
