use serde::{Deserialize, Serialize};

// Re-use filter and extract types from the reporter schema so YAML authors
// use the same field names and tag forms they already know.
pub use crate::processors::reporter::schema::{ExtractField, FilterRule};

// ---------------------------------------------------------------------------
// Top-level correlator definition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelatorDef {
    /// Named data sources this correlator watches.
    pub sources: Vec<SourceDef>,
    /// Defines which source triggers the check and what window to look back in.
    pub correlate: CorrelateDef,
    #[serde(default)]
    pub output: CorrelatorOutput,
}

impl CorrelatorDef {
    /// Populate the pre-built `HashSet` in every `TagMatch` filter rule
    /// for O(1) tag lookup at pipeline runtime.
    pub fn prepare_tag_sets(&mut self) {
        for src in &mut self.sources {
            for rule in &mut src.filter {
                rule.prepare_tag_set();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Source definition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceDef {
    /// Unique identifier referenced by `correlate.trigger`.
    pub id: String,
    /// AND-ed filter rules (same schema as reporter filter stage).
    #[serde(default)]
    pub filter: Vec<FilterRule>,
    /// Regex extraction fields (same schema as reporter extract stage).
    #[serde(default)]
    pub extract: Vec<ExtractField>,
    /// Optional Rhai boolean expression evaluated against extracted `fields`.
    /// If present, source match is only stored when the expression is truthy.
    /// Example: `"fd_count > 900"`
    #[serde(default)]
    pub condition: Option<String>,
}

// ---------------------------------------------------------------------------
// Correlation trigger + window
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelateDef {
    /// Source ID whose match triggers the correlation check.
    pub trigger: String,
    /// Look back at most this many lines from the trigger line.
    /// If both `within_lines` and `within_ms` are set, both constraints apply.
    #[serde(default)]
    pub within_lines: Option<usize>,
    /// Look back at most this many milliseconds from the trigger timestamp.
    #[serde(default)]
    pub within_ms: Option<u64>,
    /// Template for the emitted `message` field.
    /// Use `{{source_id.field_name}}` placeholders.
    /// Example: `"FD spike ({{fd_spike.fd_count}}) preceded EBADF in PID {{ebadf_error.erring_pid}}"`
    pub emit: String,
    /// Optional plain-English explanation shown in the Correlations panel header.
    /// Explains what the correlation means and what to investigate next.
    #[serde(default)]
    pub guidance: Option<String>,
}

// ---------------------------------------------------------------------------
// Output options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CorrelatorOutput {
    /// If true, correlated trigger lines are annotated in the log viewer.
    #[serde(default)]
    pub annotate: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_YAML: &str = r#"
sources:
  - id: src_a
    filter:
      - type: tag_match
        tags: [TagA]
  - id: src_b
    filter:
      - type: tag_match
        tags: [TagB]
correlate:
  trigger: src_b
  within_lines: 100
  emit: "A correlated with B"
"#;

    #[test]
    fn parse_minimal_correlator_yaml() {
        let def: CorrelatorDef = serde_yaml::from_str(MINIMAL_YAML).unwrap();
        assert_eq!(def.sources.len(), 2);
        assert_eq!(def.sources[0].id, "src_a");
        assert_eq!(def.sources[1].id, "src_b");
        assert_eq!(def.correlate.trigger, "src_b");
        assert_eq!(def.correlate.within_lines, Some(100));
        assert_eq!(def.correlate.emit, "A correlated with B");
        assert!(def.correlate.within_ms.is_none());
        assert!(def.correlate.guidance.is_none());
    }

    #[test]
    fn parse_correlator_with_within_ms() {
        let yaml = r#"
sources:
  - id: src_a
    filter:
      - type: tag_match
        tags: [TagA]
  - id: src_b
    filter:
      - type: tag_match
        tags: [TagB]
correlate:
  trigger: src_b
  within_ms: 5000
  emit: "time-based correlation"
"#;
        let def: CorrelatorDef = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(def.correlate.within_ms, Some(5000u64));
        assert!(def.correlate.within_lines.is_none());
    }

    #[test]
    fn parse_correlator_with_guidance() {
        let yaml = r#"
sources:
  - id: src_a
    filter:
      - type: tag_match
        tags: [FdTracker]
  - id: src_b
    filter:
      - type: tag_match
        tags: [Binder]
correlate:
  trigger: src_b
  within_lines: 200
  emit: "FD spike before Binder failure"
  guidance: "Investigate file descriptor leaks in the suspect process."
"#;
        let def: CorrelatorDef = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(
            def.correlate.guidance.as_deref(),
            Some("Investigate file descriptor leaks in the suspect process.")
        );
    }

    #[test]
    fn prepare_tag_sets_populates_hash_set() {
        let mut def: CorrelatorDef = serde_yaml::from_str(MINIMAL_YAML).unwrap();
        // Before prepare_tag_sets, tag_set is empty (serde skips it)
        match &def.sources[0].filter[0] {
            FilterRule::TagMatch { tag_set, .. } => {
                assert!(tag_set.is_empty(), "tag_set should be empty before prepare");
            }
            other => panic!("Expected TagMatch rule, got {:?}", other),
        }
        def.prepare_tag_sets();
        // After prepare_tag_sets, tag_set should be populated
        if let FilterRule::TagMatch { tags, tag_set } = &def.sources[0].filter[0] {
            assert!(!tag_set.is_empty(), "tag_set should be populated after prepare");
            assert_eq!(tag_set, tags);
        } else {
            panic!("Expected TagMatch rule");
        }
    }
}
