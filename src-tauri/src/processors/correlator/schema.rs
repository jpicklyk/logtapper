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
