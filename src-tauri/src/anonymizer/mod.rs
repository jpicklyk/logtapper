pub mod detectors;
pub mod mapping;

use detectors::{PiiDetector, PiiMatch, default_detectors};
use mapping::PiiMappings;

// ---------------------------------------------------------------------------
// LogAnonymizer
// ---------------------------------------------------------------------------

/// Sits between the parser and the processor pipeline.
/// Replaces PII spans with deterministic tokens and records `HighlightSpan`s
/// so the viewer can show the user where substitutions occurred.
pub struct LogAnonymizer {
    detectors: Vec<Box<dyn PiiDetector>>,
    pub mappings: PiiMappings,
}

impl LogAnonymizer {
    /// Build with the default detector set.
    pub fn new() -> Self {
        Self {
            detectors: default_detectors(),
            mappings: PiiMappings::new(),
        }
    }

    /// Build with a custom detector set.
    pub fn with_detectors(detectors: Vec<Box<dyn PiiDetector>>) -> Self {
        Self {
            detectors,
            mappings: PiiMappings::new(),
        }
    }

    /// Anonymize `text` in-place and return the byte ranges that were replaced.
    ///
    /// Matches are deduplicated and sorted longest-first to prevent partial
    /// replacements when patterns overlap.
    pub fn anonymize(&self, text: &str) -> (String, Vec<ReplacedSpan>) {
        if self.detectors.is_empty() {
            return (text.to_string(), Vec::new());
        }

        // Collect all matches
        let mut all_matches: Vec<PiiMatch> = Vec::new();
        for det in &self.detectors {
            if !det.quick_screen(text) {
                continue;
            }
            all_matches.extend(det.find_all(text));
        }

        if all_matches.is_empty() {
            return (text.to_string(), Vec::new());
        }

        // Sort longest-first, tie-break by start position
        all_matches.sort_by(|a, b| {
            let len_a = a.range.end - a.range.start;
            let len_b = b.range.end - b.range.start;
            len_b.cmp(&len_a).then(a.range.start.cmp(&b.range.start))
        });

        // Greedy non-overlapping selection
        let mut used: Vec<PiiMatch> = Vec::new();
        'outer: for m in all_matches {
            for u in &used {
                if m.range.start < u.range.end && m.range.end > u.range.start {
                    continue 'outer; // overlaps
                }
            }
            used.push(m);
        }

        // Sort by start position for left-to-right replacement
        used.sort_by_key(|m| m.range.start);

        // Build the replacement string and collect span info
        let mut result = String::with_capacity(text.len());
        let mut replaced_spans: Vec<ReplacedSpan> = Vec::with_capacity(used.len());
        let mut cursor = 0usize;

        for m in &used {
            if m.range.start > cursor {
                result.push_str(&text[cursor..m.range.start]);
            }
            let token = self.mappings.token_for(&m.raw_value, m.category);
            let span_start = result.len();
            result.push_str(&token);
            replaced_spans.push(ReplacedSpan {
                start: span_start,
                end: result.len(),
            });
            cursor = m.range.end;
        }
        if cursor < text.len() {
            result.push_str(&text[cursor..]);
        }

        (result, replaced_spans)
    }
}

impl Default for LogAnonymizer {
    fn default() -> Self {
        Self::new()
    }
}

/// A byte range within the *output* string where a PII token was placed.
/// Used to generate `HighlightKind::PiiReplaced` spans for the viewer.
#[derive(Debug, Clone)]
pub struct ReplacedSpan {
    pub start: usize,
    pub end: usize,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_email() {
        let anon = LogAnonymizer::new();
        let (out, spans) = anon.anonymize("send to user@example.com please");
        assert!(!out.contains("user@example.com"), "email not replaced: {out}");
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn replaces_ipv4() {
        let anon = LogAnonymizer::new();
        let (out, spans) = anon.anonymize("connecting to 192.168.1.100:8080");
        assert!(!out.contains("192.168.1.100"), "IPv4 not replaced: {out}");
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn replaces_mac() {
        let anon = LogAnonymizer::new();
        let (out, spans) = anon.anonymize("MAC address: AA:BB:CC:DD:EE:FF connected");
        assert!(!out.contains("AA:BB"), "MAC not replaced: {out}");
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn deterministic_tokens() {
        let anon = LogAnonymizer::new();
        let (out1, _) = anon.anonymize("email=test@test.com");
        let (out2, _) = anon.anonymize("from test@test.com again");
        // Both occurrences should get the same token
        let tok1 = out1
            .split('=')
            .nth(1)
            .unwrap_or("")
            .trim();
        let tok2 = out2
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .trim();
        assert_eq!(tok1, tok2, "tokens should be deterministic across calls");
    }

    #[test]
    fn no_false_positives_on_plain_text() {
        let anon = LogAnonymizer::new();
        let text = "Normal log line with no PII content here";
        let (out, spans) = anon.anonymize(text);
        assert_eq!(out, text);
        assert!(spans.is_empty());
    }
}
