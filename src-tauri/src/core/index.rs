use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use crate::core::line::LogLevel;
use crate::core::timeline::TimelineEntry;

// ---------------------------------------------------------------------------
// CrossQuery — parameters for cross-source queries from Rhai scripts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CrossQuery {
    pub from_ns: i64,
    pub to_ns: i64,
    pub sources: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub min_level: Option<LogLevel>,
    pub max_results: usize,
}

impl CrossQuery {
    pub fn new(from_ns: i64, to_ns: i64) -> Self {
        Self {
            from_ns,
            to_ns,
            max_results: 1000,
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------------------
// CrossSourceIndex — fast lookup structures built from the timeline
// ---------------------------------------------------------------------------

pub struct CrossSourceIndex {
    /// tag_id → list of timeline entry indices (sorted by timestamp via timeline order).
    /// Keyed by the compact `u16` tag id — no per-line string clones.
    by_tag: HashMap<u16, Vec<usize>>,
    /// Coarse time buckets (1-second resolution) → timeline entry indices.
    time_buckets: BTreeMap<i64, Vec<usize>>,
    /// Tag table (shared with the `Timeline`) for resolving tag strings in queries.
    tag_table: Arc<[Arc<str>]>,
    /// Source id table (shared with the `Timeline`) for resolving source filters.
    source_ids: Vec<Arc<str>>,
}

const BUCKET_NS: i64 = 1_000_000_000; // 1 second

impl CrossSourceIndex {
    /// An empty index (no entries, empty resolution tables).
    pub fn empty() -> Self {
        Self {
            by_tag: HashMap::new(),
            time_buckets: BTreeMap::new(),
            tag_table: Arc::from(Vec::<Arc<str>>::new()),
            source_ids: Vec::new(),
        }
    }

    /// Build the lookup structures from compact timeline entries. `tag_table`
    /// and `source_ids` are the same resolution tables the `Timeline` carries
    /// (indexed by `tag_id` / `source_idx`); they are only consulted when a
    /// query filters by tag or source name.
    pub fn build(
        entries: &[TimelineEntry],
        tag_table: Arc<[Arc<str>]>,
        source_ids: Vec<Arc<str>>,
    ) -> Self {
        let mut by_tag: HashMap<u16, Vec<usize>> = HashMap::new();
        let mut time_buckets: BTreeMap<i64, Vec<usize>> = BTreeMap::new();

        for (i, e) in entries.iter().enumerate() {
            // `u16` key is `Copy` — no per-line allocation (previously cloned the
            // tag `String` once per line even for already-seen tags).
            by_tag.entry(e.tag_id).or_default().push(i);
            let bucket = e.timestamp / BUCKET_NS;
            time_buckets.entry(bucket).or_default().push(i);
        }

        Self {
            by_tag,
            time_buckets,
            tag_table,
            source_ids,
        }
    }

    /// Resolve an entry's tag id to its string (`""` if out of range).
    fn tag_of(&self, entry: &TimelineEntry) -> &str {
        self.tag_table
            .get(entry.tag_id as usize)
            .map_or("", |s| &**s)
    }

    /// Resolve an entry's source idx to its string (`""` if out of range).
    fn source_of(&self, entry: &TimelineEntry) -> &str {
        self.source_ids
            .get(entry.source_idx as usize)
            .map_or("", |s| &**s)
    }

    /// Query timeline entry indices matching the criteria.
    /// Returns indices into the `Timeline::entries` slice.
    pub fn query(&self, q: &CrossQuery, entries: &[TimelineEntry]) -> Vec<usize> {
        // Start from time range
        let lo_bucket = q.from_ns / BUCKET_NS;
        let hi_bucket = q.to_ns / BUCKET_NS;

        let mut candidates: Vec<usize> = self
            .time_buckets
            .range(lo_bucket..=hi_bucket)
            .flat_map(|(_, v)| v.iter().copied())
            .filter(|&i| {
                let e = &entries[i];
                e.timestamp >= q.from_ns && e.timestamp <= q.to_ns
            })
            .collect();

        // Apply tag filter
        if let Some(ref tags) = q.tags {
            candidates.retain(|&i| {
                let t = self.tag_of(&entries[i]);
                tags.iter().any(|qt| qt.as_str() == t)
            });
        }

        // Apply source filter
        if let Some(ref sources) = q.sources {
            candidates.retain(|&i| {
                let s = self.source_of(&entries[i]);
                sources.iter().any(|qs| qs.as_str() == s)
            });
        }

        // Apply level filter
        if let Some(min_level) = q.min_level {
            candidates.retain(|&i| entries[i].level >= min_level);
        }

        // Sort by timestamp and deduplicate
        candidates.sort_unstable();
        candidates.dedup();

        if q.max_results > 0 {
            candidates.truncate(q.max_results);
        }

        candidates
    }

    pub fn entries_for_tag(&self, tag: &str) -> Option<&[usize]> {
        let tag_id = self.tag_table.iter().position(|t| &**t == tag)? as u16;
        self.by_tag.get(&tag_id).map(std::vec::Vec::as_slice)
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

    fn entry(source_idx: u32, line: usize, ts: i64, level: LogLevel, tag_id: u16) -> TimelineEntry {
        TimelineEntry {
            source_idx,
            source_line_num: line,
            timestamp: ts,
            level,
            tag_id,
        }
    }

    type SampleData = (Vec<TimelineEntry>, Arc<[Arc<str>]>, Vec<Arc<str>>);

    fn sample() -> SampleData {
        // tag_table: 0="", 1="Foo", 2="Bar"; sources: 0="a", 1="b"
        let entries = vec![
            entry(0, 0, 1_000_000_000, LogLevel::Info, 1),  // Foo @1s src a
            entry(1, 0, 1_500_000_000, LogLevel::Error, 2), // Bar @1.5s src b
            entry(0, 1, 2_000_000_000, LogLevel::Warn, 1),  // Foo @2s src a
            entry(0, 2, 2_200_000_000, LogLevel::Info, 2),  // Bar @2.2s src a
        ];
        (entries, tags(&["", "Foo", "Bar"]), sources(&["a", "b"]))
    }

    #[test]
    fn entries_for_tag_resolves_by_string() {
        let (entries, tag_table, src_ids) = sample();
        let idx = CrossSourceIndex::build(&entries, tag_table, src_ids);
        assert_eq!(idx.entries_for_tag("Foo"), Some([0usize, 2usize].as_slice()));
        assert_eq!(idx.entries_for_tag("Bar"), Some([1usize, 3usize].as_slice()));
        assert_eq!(idx.entries_for_tag("Missing"), None);
    }

    #[test]
    fn query_filters_by_tag_source_and_level() {
        let (entries, tag_table, src_ids) = sample();
        let idx = CrossSourceIndex::build(&entries, tag_table, src_ids);

        // Full time window.
        let mut q = CrossQuery::new(0, 5_000_000_000);

        // Tag filter.
        q.tags = Some(vec!["Foo".to_string()]);
        assert_eq!(idx.query(&q, &entries), vec![0, 2]);

        // Source filter (reset tags).
        q.tags = None;
        q.sources = Some(vec!["b".to_string()]);
        assert_eq!(idx.query(&q, &entries), vec![1]);

        // Level filter (reset source): Warn and above → error+warn entries.
        q.sources = None;
        q.min_level = Some(LogLevel::Warn);
        assert_eq!(idx.query(&q, &entries), vec![1, 2]);
    }

    #[test]
    fn empty_index_is_queryable() {
        let idx = CrossSourceIndex::empty();
        assert_eq!(idx.entries_for_tag("anything"), None);
        let q = CrossQuery::new(0, i64::MAX);
        assert!(idx.query(&q, &[]).is_empty());
    }
}
