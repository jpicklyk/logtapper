//! Schema contract types for the processor marketplace.
//!
//! The `schema:` section in processor YAML declares emission fields
//! and MCP agent exposure (signals, summaries). These types parse
//! and hold that contract at install time.

use serde::{Deserialize, Serialize};

/// Top-level schema contract parsed from the `schema:` YAML section.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaContract {
    /// Which log source types this processor targets.
    #[serde(default)]
    pub source_types: Vec<String>,

    /// Declared emission fields with name, type, and description.
    #[serde(default)]
    pub emissions: Vec<EmissionSchema>,

    /// MCP exposure configuration (summary template + signals).
    #[serde(default)]
    pub mcp: Option<McpSchema>,
}

/// A declared emission field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmissionSchema {
    pub name: String,
    /// Semantic type: "int", "float", "string", "bool".
    #[serde(rename = "type", default)]
    pub field_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// MCP agent exposure configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpSchema {
    /// Summary template with `{{var_name}}` placeholders rendered from vars.
    #[serde(default)]
    pub summary: Option<McpSummary>,
    /// Per-emission or aggregate signals with severity classification.
    #[serde(default)]
    pub signals: Vec<SignalDef>,
}

/// Summary template for MCP responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpSummary {
    /// Mustache-style template: `"{{sample_count}} heap samples. Peak: {{peak_heap_pct}}%."`.
    pub template: String,
    /// Var names to include in the summary. If empty, all vars are available.
    #[serde(default)]
    pub include_vars: Vec<String>,
}

/// A signal definition for MCP agent consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Severity classification: "critical", "warning", "info".
    #[serde(default = "default_severity")]
    pub severity: String,
    /// Condition expression evaluated against emission fields (e.g. "heap_pct >= 90").
    #[serde(default)]
    pub condition: Option<String>,
    /// Emission fields to include in signal output.
    #[serde(default)]
    pub fields: Vec<String>,
    /// Display format with `{{field}}` placeholders.
    #[serde(default)]
    pub format: Option<String>,
    /// "emission" (default, per-line) or "aggregate" (computed from vars).
    #[serde(rename = "type", default = "default_signal_type")]
    pub signal_type: String,
}

fn default_severity() -> String {
    "info".to_string()
}

fn default_signal_type() -> String {
    "emission".to_string()
}

// ---------------------------------------------------------------------------
// Provenance fields (stored in persisted YAML, not in schema contract)
// ---------------------------------------------------------------------------

/// Provenance metadata stored as underscore-prefixed fields in persisted YAML.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Provenance {
    #[serde(rename = "_source", default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(rename = "_installed_version", default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(rename = "_installed_at", default, skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    #[serde(rename = "_sha256", default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

// ---------------------------------------------------------------------------
// Namespace helpers
// ---------------------------------------------------------------------------

/// The separator used in qualified processor IDs: `id@source`.
pub const NAMESPACE_SEP: char = '@';

/// On-disk filename replacement for `@` (Windows filesystem safety).
pub const NAMESPACE_DISK_ESC: &str = "__at__";

/// Category taxonomy — standardized values for `meta.category`.
pub const CATEGORIES: &[&str] = &[
    "memory", "network", "battery", "process", "storage",
    "security", "system", "privacy", "performance", "vendor",
];

/// Validate that a bare processor ID (without source qualifier) does not
/// contain the namespace separator `@`.
pub fn validate_processor_id(id: &str) -> Result<(), String> {
    if id.contains(NAMESPACE_SEP) {
        return Err(format!(
            "Processor ID '{}' must not contain '{}' — that character is reserved for namespace qualification (id@source)",
            id, NAMESPACE_SEP
        ));
    }
    if id.is_empty() {
        return Err("Processor ID must not be empty".to_string());
    }
    Ok(())
}

/// Build a qualified ID: `{id}@{source}`.
pub fn qualified_id(id: &str, source: &str) -> String {
    format!("{}{}{}", id, NAMESPACE_SEP, source)
}

/// Split a qualified ID into `(bare_id, Some(source))` or `(id, None)`.
pub fn split_qualified_id(qid: &str) -> (&str, Option<&str>) {
    match qid.rsplit_once(NAMESPACE_SEP) {
        Some((id, source)) => (id, Some(source)),
        None => (qid, None),
    }
}

/// Escape a processor ID for use as a filename on disk.
/// Replaces `@` with `__at__` for Windows filesystem compatibility.
pub fn id_to_filename(id: &str) -> String {
    id.replace(NAMESPACE_SEP, NAMESPACE_DISK_ESC)
}

/// Reverse the filename escaping to recover the original processor ID.
pub fn filename_to_id(filename: &str) -> String {
    filename.replace(NAMESPACE_DISK_ESC, &NAMESPACE_SEP.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_id_rejects_at_sign() {
        assert!(validate_processor_id("system-server-heap").is_ok());
        assert!(validate_processor_id("__pii_anonymizer").is_ok());
        assert!(validate_processor_id("heap@official").is_err());
        assert!(validate_processor_id("").is_err());
    }

    #[test]
    fn qualified_id_roundtrip() {
        let qid = qualified_id("system-server-heap", "official");
        assert_eq!(qid, "system-server-heap@official");
        let (id, source) = split_qualified_id(&qid);
        assert_eq!(id, "system-server-heap");
        assert_eq!(source, Some("official"));
    }

    #[test]
    fn split_unqualified_id() {
        let (id, source) = split_qualified_id("system-server-heap");
        assert_eq!(id, "system-server-heap");
        assert_eq!(source, None);
    }

    #[test]
    fn filename_escaping_roundtrip() {
        let id = "system-server-heap@official";
        let filename = id_to_filename(id);
        assert_eq!(filename, "system-server-heap__at__official");
        assert!(!filename.contains('@'));
        let recovered = filename_to_id(&filename);
        assert_eq!(recovered, id);
    }

    #[test]
    fn parse_schema_contract() {
        let yaml = r#"
source_types: ["logcat"]
emissions:
  - name: heap_pct
    type: int
    description: "Java heap usage percentage"
mcp:
  summary:
    template: "{{sample_count}} heap samples. Peak: {{peak_heap_pct}}%."
    include_vars: [sample_count, peak_heap_pct]
  signals:
    - name: heap_critical
      severity: critical
      condition: "heap_pct >= 90"
      fields: [heap_pct, heap_used, heap_max]
      format: "Heap at {{heap_pct}}% ({{heap_used}}/{{heap_max}} MB)"
"#;
        let schema: SchemaContract = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(schema.source_types, vec!["logcat"]);
        assert_eq!(schema.emissions.len(), 1);
        assert_eq!(schema.emissions[0].name, "heap_pct");
        let mcp = schema.mcp.unwrap();
        assert!(mcp.summary.is_some());
        assert_eq!(mcp.signals.len(), 1);
        assert_eq!(mcp.signals[0].name, "heap_critical");
        assert_eq!(mcp.signals[0].severity, "critical");
    }

    #[test]
    fn parse_empty_schema() {
        let yaml = "source_types: []\n";
        let schema: SchemaContract = serde_yaml::from_str(yaml).unwrap();
        assert!(schema.emissions.is_empty());
        assert!(schema.mcp.is_none());
    }
}
