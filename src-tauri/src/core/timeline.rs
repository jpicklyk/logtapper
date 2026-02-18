use std::collections::HashMap;
use crate::core::line::LogLevel;

// ---------------------------------------------------------------------------
// TimelineEntry — lightweight cross-source line reference
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TimelineEntry {
    pub source_id: String,
    pub source_line_num: usize,
    pub timestamp: i64,
    pub level: LogLevel,
    pub tag: String,
}

// ---------------------------------------------------------------------------
// Timeline — merged, sorted view across all sources
// ---------------------------------------------------------------------------

pub struct Timeline {
    /// All entries sorted by timestamp.
    pub entries: Vec<TimelineEntry>,
    /// Maps (source_id, source_line_num) → index in `entries`.
    source_to_timeline: HashMap<(String, usize), usize>,
}

impl Timeline {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            source_to_timeline: HashMap::new(),
        }
    }

    /// Build (or rebuild) the timeline from a set of sources.
    /// Each source contributes a slice of (LineContext, line_num) pairs.
    pub fn build<'a>(
        sources: impl Iterator<Item = (&'a str, impl Iterator<Item = TimelineEntry>)>,
    ) -> Self {
        let mut entries: Vec<TimelineEntry> = Vec::new();
        for (_source_id, source_entries) in sources {
            entries.extend(source_entries);
        }

        // Sort by timestamp, tie-break by source_id + line_num for determinism.
        entries.sort_by(|a, b| {
            a.timestamp
                .cmp(&b.timestamp)
                .then_with(|| a.source_id.cmp(&b.source_id))
                .then_with(|| a.source_line_num.cmp(&b.source_line_num))
        });

        let source_to_timeline: HashMap<_, _> = entries
            .iter()
            .enumerate()
            .map(|(i, e)| ((e.source_id.clone(), e.source_line_num), i))
            .collect();

        Self {
            entries,
            source_to_timeline,
        }
    }

    /// Look up the timeline index for a given source line.
    pub fn timeline_index(&self, source_id: &str, source_line_num: usize) -> Option<usize> {
        self.source_to_timeline
            .get(&(source_id.to_string(), source_line_num))
            .copied()
    }

    /// Return all entries in a timestamp range [from_ns, to_ns].
    pub fn entries_in_range(&self, from_ns: i64, to_ns: i64) -> &[TimelineEntry] {
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
