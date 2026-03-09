use std::collections::{BTreeMap, HashMap};
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
    /// tag → list of timeline entry indices (sorted by timestamp via timeline order)
    by_tag: HashMap<String, Vec<usize>>,
    /// Coarse time buckets (1-second resolution) → timeline entry indices
    time_buckets: BTreeMap<i64, Vec<usize>>,
}

const BUCKET_NS: i64 = 1_000_000_000; // 1 second

impl CrossSourceIndex {
    pub fn build(entries: &[TimelineEntry]) -> Self {
        let mut by_tag: HashMap<String, Vec<usize>> = HashMap::new();
        let mut time_buckets: BTreeMap<i64, Vec<usize>> = BTreeMap::new();

        for (i, e) in entries.iter().enumerate() {
            by_tag.entry(e.tag.clone()).or_default().push(i);
            let bucket = e.timestamp / BUCKET_NS;
            time_buckets.entry(bucket).or_default().push(i);
        }

        Self {
            by_tag,
            time_buckets,
        }
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
            candidates.retain(|&i| tags.contains(&entries[i].tag));
        }

        // Apply source filter
        if let Some(ref sources) = q.sources {
            candidates.retain(|&i| sources.contains(&entries[i].source_id));
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
        self.by_tag.get(tag).map(std::vec::Vec::as_slice)
    }
}
