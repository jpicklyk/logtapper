use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;
use crate::core::line::LogLevel;

// ---------------------------------------------------------------------------
// TimelineEntry — lightweight cross-source line reference
// ---------------------------------------------------------------------------
//
// Compact by design: every field is a `Copy` scalar and the whole struct is 24
// bytes with no heap allocation. The source and tag are stored as small integer
// handles (`source_idx` into `Timeline::source_ids`, `tag_id` from the session's
// `TagInterner`) rather than owned `String`s. Resolve them via
// `Timeline::resolve_source` / `Timeline::resolve_tag`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimelineEntry {
    /// Index into `Timeline::source_ids`.
    pub source_idx: u32,
    pub source_line_num: usize,
    pub timestamp: i64,
    pub level: LogLevel,
    /// Compact tag handle from the session's `TagInterner`. Resolve against
    /// `Timeline::tag_table` (or the interner) — index into that table.
    pub tag_id: u16,
}

/// Deterministic ordering for timeline entries: timestamp, then source, then
/// source line number. For the current single-source model `source_idx` is
/// constant, so this reduces to (timestamp, source_line_num) — identical to the
/// previous string-based comparator (a single source compared equal on id).
fn entry_cmp(a: &TimelineEntry, b: &TimelineEntry) -> Ordering {
    a.timestamp
        .cmp(&b.timestamp)
        .then_with(|| a.source_idx.cmp(&b.source_idx))
        .then_with(|| a.source_line_num.cmp(&b.source_line_num))
}

// ---------------------------------------------------------------------------
// Timeline — merged, sorted view across all sources
// ---------------------------------------------------------------------------

pub struct Timeline {
    /// All entries sorted by timestamp.
    pub entries: Vec<TimelineEntry>,
    /// Distinct source id strings, indexed by `TimelineEntry::source_idx`.
    source_ids: Vec<Arc<str>>,
    /// Snapshot of the interner's tag table, indexed by `TimelineEntry::tag_id`.
    /// Shared cheaply (Arc) with the matching `CrossSourceIndex`.
    tag_table: Arc<[Arc<str>]>,
    /// Maps (source_idx, source_line_num) → index in `entries`.
    /// `None` means the mapping is the identity — a single source whose entries
    /// are in natural line order, so `timeline_index(sid, n) == n`. This avoids
    /// materializing a per-line `HashMap` (~48+ bytes/line) in the common case.
    source_to_timeline: Option<HashMap<(u32, usize), usize>>,
}

/// An empty `Arc<[Arc<str>]>` — used for the empty timeline / index.
fn empty_table() -> Arc<[Arc<str>]> {
    Arc::from(Vec::<Arc<str>>::new())
}

impl Timeline {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            source_ids: Vec::new(),
            tag_table: empty_table(),
            source_to_timeline: None,
        }
    }

    /// Build (or rebuild) the timeline from a pre-materialized set of compact
    /// entries plus the resolution tables. `entries` may be in any order — they
    /// are sorted here (skipped when already sorted, the common case).
    ///
    /// `source_ids` is indexed by `TimelineEntry::source_idx`; `tag_table` by
    /// `TimelineEntry::tag_id`.
    pub fn from_source_entries(
        mut entries: Vec<TimelineEntry>,
        source_ids: Vec<Arc<str>>,
        tag_table: Arc<[Arc<str>]>,
    ) -> Self {
        // Sort by (timestamp, source_idx, source_line_num). Skip when already
        // ordered — the typical single-source case where line order already
        // equals timestamp order — which is also a prerequisite for the
        // arithmetic identity mapping below. (`windows`/`all` rather than
        // `slice::is_sorted_by`, which is only stable since Rust 1.82 > MSRV.)
        let already_sorted = entries
            .windows(2)
            .all(|w| entry_cmp(&w[0], &w[1]) != Ordering::Greater);
        if !already_sorted {
            entries.sort_by(entry_cmp);
        }

        // Identity fast path: a single source whose entries are in natural line
        // order needs no per-line map — `timeline_index(sid, n) == n`.
        let identity = source_ids.len() == 1
            && entries
                .iter()
                .enumerate()
                .all(|(i, e)| e.source_idx == 0 && e.source_line_num == i);

        let source_to_timeline = if identity {
            None
        } else {
            Some(
                entries
                    .iter()
                    .enumerate()
                    .map(|(i, e)| ((e.source_idx, e.source_line_num), i))
                    .collect(),
            )
        };

        Self {
            entries,
            source_ids,
            tag_table,
            source_to_timeline,
        }
    }

    /// Resolve a `source_idx` back to its source id string (`""` if unknown).
    pub fn resolve_source(&self, source_idx: u32) -> &str {
        self.source_ids
            .get(source_idx as usize)
            .map_or("", |s| &**s)
    }

    /// Resolve a `tag_id` back to its tag string (`""` if unknown).
    pub fn resolve_tag(&self, tag_id: u16) -> &str {
        self.tag_table.get(tag_id as usize).map_or("", |s| &**s)
    }

    /// Look up the timeline index for a given source line.
    pub fn timeline_index(&self, source_id: &str, source_line_num: usize) -> Option<usize> {
        let source_idx = self
            .source_ids
            .iter()
            .position(|s| &**s == source_id)? as u32;
        match &self.source_to_timeline {
            Some(map) => map.get(&(source_idx, source_line_num)).copied(),
            None => {
                // Identity mapping (single source in line order): the timeline
                // index equals the source line number.
                (source_line_num < self.entries.len()).then_some(source_line_num)
            }
        }
    }

    /// Return all entries in a timestamp range [from_ns, to_ns].
    /// Returns an empty slice if `from_ns > to_ns`.
    pub fn entries_in_range(&self, from_ns: i64, to_ns: i64) -> &[TimelineEntry] {
        if from_ns > to_ns {
            return &[];
        }
        let lo = self
            .entries
            .partition_point(|e| e.timestamp < from_ns);
        let hi = self
            .entries
            .partition_point(|e| e.timestamp <= to_ns);
        &self.entries[lo..hi]
    }

    pub fn total_entries(&self) -> usize {
        self.entries.len()
    }
}

impl Default for Timeline {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(list: &[&str]) -> Arc<[Arc<str>]> {
        list.iter().map(|s| Arc::<str>::from(*s)).collect()
    }

    fn sources(list: &[&str]) -> Vec<Arc<str>> {
        list.iter().map(|s| Arc::<str>::from(*s)).collect()
    }

    fn entry(source_idx: u32, line: usize, ts: i64, tag_id: u16) -> TimelineEntry {
        TimelineEntry {
            source_idx,
            source_line_num: line,
            timestamp: ts,
            level: LogLevel::Info,
            tag_id,
        }
    }

    /// Brute-force reference: scan entries for the one matching (source, line).
    fn brute_index(
        entries: &[TimelineEntry],
        source_ids: &[Arc<str>],
        source_id: &str,
        line: usize,
    ) -> Option<usize> {
        let sidx = source_ids.iter().position(|s| &**s == source_id)? as u32;
        entries
            .iter()
            .position(|e| e.source_idx == sidx && e.source_line_num == line)
    }

    #[test]
    fn identity_mapping_single_source_in_line_order() {
        // Timestamps already ascending → sorted order == line order → identity.
        let entries: Vec<_> = (0..5).map(|i| entry(0, i, i as i64 * 10, 0)).collect();
        let tl = Timeline::from_source_entries(entries, sources(&["src"]), tags(&[""]));

        // Identity mapping means no per-line HashMap was materialized.
        assert!(tl.source_to_timeline.is_none(), "single-source line order must use identity mapping");

        for n in 0..5 {
            assert_eq!(tl.timeline_index("src", n), Some(n));
        }
        assert_eq!(tl.timeline_index("src", 5), None, "out-of-range line has no index");
        assert_eq!(tl.timeline_index("other", 0), None, "unknown source has no index");
    }

    #[test]
    fn out_of_order_single_source_builds_explicit_map() {
        // Descending timestamps force a sort that reorders lines → not identity.
        let entries: Vec<_> = (0..5).map(|i| entry(0, i, (5 - i as i64) * 10, 0)).collect();
        let tl = Timeline::from_source_entries(entries, sources(&["src"]), tags(&[""]));

        assert!(tl.source_to_timeline.is_some(), "reordered entries need an explicit map");
        // Entry with line 0 has the largest timestamp → sorts to the end.
        assert_eq!(tl.timeline_index("src", 0), Some(4));
        assert_eq!(tl.timeline_index("src", 4), Some(0));
    }

    #[test]
    fn multi_source_mapping_equivalence() {
        // Two sources interleaved in time. Verify the built map agrees with a
        // brute-force scan for every (source, line) pair.
        let entries = vec![
            entry(0, 0, 100, 0),
            entry(1, 0, 150, 1),
            entry(0, 1, 200, 0),
            entry(1, 1, 120, 1),
            entry(0, 2, 250, 0),
        ];
        let src_ids = sources(&["a", "b"]);
        let tl = Timeline::from_source_entries(entries, src_ids.clone(), tags(&["x", "y"]));

        assert!(tl.source_to_timeline.is_some(), "multi-source must use an explicit map");

        for (sid, max_line) in [("a", 3usize), ("b", 2usize)] {
            for line in 0..max_line {
                assert_eq!(
                    tl.timeline_index(sid, line),
                    brute_index(&tl.entries, &src_ids, sid, line),
                    "mapping mismatch for source {sid} line {line}",
                );
            }
        }
    }

    #[test]
    fn tag_id_round_trips_through_table() {
        let entries = vec![entry(0, 0, 10, 0), entry(0, 1, 20, 2)];
        let tl = Timeline::from_source_entries(entries, sources(&["s"]), tags(&["", "B", "C"]));
        assert_eq!(tl.resolve_tag(0), "");
        assert_eq!(tl.resolve_tag(2), "C");
        assert_eq!(tl.resolve_tag(99), "", "out-of-range tag id resolves to empty");
        assert_eq!(tl.resolve_source(0), "s");
        assert_eq!(tl.resolve_source(7), "", "out-of-range source idx resolves to empty");
        // The stored entries carry the compact ids that resolve to the originals.
        assert_eq!(tl.resolve_tag(tl.entries[1].tag_id), "C");
    }

    #[test]
    fn entries_in_range_still_works() {
        let entries: Vec<_> = (0..10).map(|i| entry(0, i, i as i64, 0)).collect();
        let tl = Timeline::from_source_entries(entries, sources(&["s"]), tags(&[""]));
        let slice = tl.entries_in_range(3, 6);
        assert_eq!(slice.len(), 4);
        assert_eq!(slice.first().unwrap().timestamp, 3);
        assert_eq!(slice.last().unwrap().timestamp, 6);
        assert!(tl.entries_in_range(6, 3).is_empty(), "inverted range is empty");
    }
}
