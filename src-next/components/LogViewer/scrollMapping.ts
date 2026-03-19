/**
 * Maps an absolute line number to its index within a sorted filtered-line array.
 *
 * When section filtering (or any line filter) is active, the virtualizer
 * operates on indices 0..N-1 where N = filteredLines.length.  But
 * scrollToLine from the section panel is an *absolute* line number in the
 * original file.  This function performs a binary search to find the
 * corresponding filtered index.
 *
 * If the exact line is not in the filtered set, returns the index of the
 * nearest line that is (the closest entry whose value is >= the target).
 * Returns null only when filteredLines is empty.
 */
export function absoluteLineToFilteredIndex(
  absoluteLine: number,
  filteredLines: number[],
): number | null {
  if (filteredLines.length === 0) return null;

  let lo = 0;
  let hi = filteredLines.length - 1;

  // Exact-match binary search first
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = filteredLines[mid];
    if (val === absoluteLine) return mid;
    if (val < absoluteLine) lo = mid + 1;
    else hi = mid - 1;
  }

  // `lo` is now the insertion point — the index of the first element > target.
  // Clamp to valid range (prefer the nearest visible line).
  return Math.min(lo, filteredLines.length - 1);
}
