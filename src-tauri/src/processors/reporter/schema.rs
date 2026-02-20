use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Top-level processor definition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReporterDef {
    pub meta: ProcessorMeta,
    #[serde(default)]
    pub sources: SourceRequirements,
    /// Section names to restrict processing to (Bugreport files only).
    /// Empty = process all lines regardless of section.
    /// Exact match against section names as parsed by BugreportParser.
    #[serde(default)]
    pub sections: Vec<String>,
    #[serde(default)]
    pub vars: Vec<VarDecl>,
    #[serde(default)]
    pub pipeline: Vec<PipelineStage>,
}

impl ReporterDef {
    pub fn from_yaml(yaml: &str) -> Result<Self, String> {
        // Strip UTF-8 BOM if present (common Windows clipboard artifact)
        let yaml = yaml.trim_start_matches('\u{FEFF}');
        // Try as-is first; on failure, attempt auto-indent normalization
        // (handles Warp/terminal copy-paste that adds leading spaces to all
        //  lines after the first, corrupting top-level key alignment).
        serde_yaml::from_str(yaml)
            .or_else(|_| serde_yaml::from_str(&normalize_yaml_indent(yaml)))
            .map_err(|e| format!("YAML parse error: {e}"))
    }

    pub fn to_yaml(&self) -> Result<String, String> {
        serde_yaml::to_string(self).map_err(|e| format!("YAML serialize error: {e}"))
    }
}

/// Strips excess leading indentation caused by terminal copy-paste artifacts.
///
/// Detects the pattern where a code block's first line is at column 1 but all
/// subsequent lines have N extra leading spaces (e.g. Warp adds a 2-space
/// margin when copying). The excess is inferred from the first indented child
/// line after a root-level key: if it has more than 2 spaces, the surplus is
/// stripped from every line (clamped so no line goes negative).
fn normalize_yaml_indent(yaml: &str) -> String {
    let lines: Vec<&str> = yaml.lines().collect();

    // Find excess: the first child line under a root key should be 2 spaces in.
    // If it's indented more, the difference is the copy-paste surplus.
    let mut saw_root = false;
    let mut excess: usize = 0;
    for line in &lines {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.bytes().take_while(|&b| b == b' ').count();
        if indent == 0 {
            saw_root = true;
        } else if saw_root {
            if indent > 2 {
                excess = indent - 2;
            }
            break;
        }
    }

    if excess == 0 {
        return yaml.to_string();
    }

    let normalized: Vec<String> = lines
        .iter()
        .map(|line| {
            let spaces = line.bytes().take_while(|&b| b == b' ').count();
            line[spaces.min(excess)..].to_string()
        })
        .collect();

    let mut result = normalized.join("\n");
    if yaml.ends_with('\n') {
        result.push('\n');
    }
    result
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessorMeta {
    #[serde(default)]
    pub builtin: bool,
    pub id: String,
    pub name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

fn default_version() -> String {
    "1.0.0".to_string()
}

// ---------------------------------------------------------------------------
// Source requirements
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceRequirements {
    #[serde(default)]
    pub required: Vec<SourceRef>,
    #[serde(default)]
    pub optional: Vec<SourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    #[serde(rename = "type")]
    pub source_type: String,
    pub alias: String,
}

// ---------------------------------------------------------------------------
// Variable declarations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub var_type: VarType,
    #[serde(default)]
    pub default: Option<serde_yaml::Value>,
    #[serde(default)]
    pub display: bool,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub display_as: Option<DisplayAs>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub configurable: bool,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VarType {
    Int,
    Float,
    Bool,
    String,
    Map,
    List,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayAs {
    Table,
    Value,
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "lowercase")]
pub enum PipelineStage {
    Filter(FilterStage),
    Extract(ExtractStage),
    Correlate(CorrelateStage),
    Script(ScriptStage),
    Aggregate(AggregateStage),
    Output(OutputStage),
}

// ── Filter ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FilterStage {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub rules: Vec<FilterRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FilterRule {
    TagMatch { tags: Vec<String> },
    MessageContains { value: String },
    MessageContainsAny { values: Vec<String> },
    MessageRegex { pattern: String },
    LevelMin { level: String },
    TimeRange { from: String, to: String },
}

// ── Extract ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractStage {
    #[serde(default)]
    pub fields: Vec<ExtractField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractField {
    pub name: String,
    pub pattern: String,
    #[serde(default)]
    pub cast: Option<CastType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CastType {
    Int,
    Float,
    String,
}

// ── Correlate ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelateStage {
    pub trigger: CorrelationTrigger,
    pub lookback: LookbackSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelationTrigger {
    pub message_contains: Option<String>,
    pub tag_match: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookbackSpec {
    pub max_lines: usize,
    pub extract_from_match: Option<LookbackExtract>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookbackExtract {
    pub tag: Option<String>,
    pub message_contains: Option<String>,
    pub field: String,
}

// ── Script ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptStage {
    pub runtime: ScriptRuntime,
    pub src: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptRuntime {
    Rhai,
}

// ── Aggregate ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateStage {
    #[serde(default)]
    pub groups: Vec<AggregateGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateGroup {
    #[serde(rename = "type")]
    pub agg_type: AggType,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub group_by: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggType {
    Count,
    CountBy,
    Min,
    Max,
    Avg,
    Percentile,
    TimeBucket,
}

// ── Output ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputStage {
    #[serde(default)]
    pub views: Vec<OutputView>,
    #[serde(default)]
    pub charts: Vec<ChartSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum OutputView {
    Table {
        source: Option<String>,
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        sort: Option<String>,
    },
    Summary {
        source: Option<String>,
        template: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartSpec {
    pub id: String,
    #[serde(rename = "type")]
    pub chart_type: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub source: String,
    #[serde(default)]
    pub x: Option<AxisSpec>,
    #[serde(default)]
    pub y: Option<AxisSpec>,
    #[serde(default)]
    pub group_by: Option<String>,
    #[serde(default)]
    pub color_by: Option<String>,
    #[serde(default)]
    pub stacked: bool,
    #[serde(default)]
    pub bins: Option<u32>,
    #[serde(default)]
    pub range: Option<[f64; 2]>,
    #[serde(default)]
    pub color_scale: Option<String>,
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub annotations: Vec<AnnotationSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AxisSpec {
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub bucket: Option<String>,
    #[serde(default)]
    pub aggregation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationSpec {
    #[serde(rename = "type")]
    pub ann_type: String,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub from: Option<f64>,
    #[serde(default)]
    pub to: Option<f64>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Backward-compatibility type alias
// ---------------------------------------------------------------------------

/// Backward-compatible alias -- use `ReporterDef` in new code.
pub type ProcessorDef = ReporterDef;

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_YAML: &str = r#"
meta:
  id: test-proc
  name: Test Processor
  version: "1.0.0"

vars:
  - name: count
    type: int
    default: 0
    display: true
    label: "Event Count"

pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: ["WifiStateMachine"]
      - type: message_contains
        value: "DISCONNECT"

  - stage: extract
    fields:
      - name: reason
        pattern: 'reason=(\d+)'
        cast: int

  - stage: script
    runtime: rhai
    src: |
      vars.count += 1;
      emit(#{ reason: fields.reason });

  - stage: output
    views:
      - type: table
        source: emissions
        columns: [reason]
    charts:
      - id: reasons
        type: bar
        title: "Disconnect Reasons"
        source: emissions
        x: { field: reason }
        y: { aggregation: count, label: "Count" }
        interactive: true
"#;

    #[test]
    fn parses_full_processor() {
        let proc = ReporterDef::from_yaml(SAMPLE_YAML).unwrap();
        assert_eq!(proc.meta.id, "test-proc");
        assert_eq!(proc.vars.len(), 1);
        assert_eq!(proc.pipeline.len(), 4);
    }

    #[test]
    fn roundtrips_to_yaml() {
        let proc = ReporterDef::from_yaml(SAMPLE_YAML).unwrap();
        let yaml = proc.to_yaml().unwrap();
        let proc2 = ReporterDef::from_yaml(&yaml).unwrap();
        assert_eq!(proc.meta.id, proc2.meta.id);
    }

    /// Reproduce the user-reported "did not find expected key at line 6 col 3" error.
    /// This is the minimal Java Crash Tracker YAML (no flow sequences, no description).
    #[test]
    fn parses_java_crash_tracker_minimal() {
        let yaml = r#"
meta:
  id: java-crash-tracker
  name: Java Crash Tracker
  version: "1.0.0"

vars:
  - name: crash_count
    type: int
    default: 0
    display: true
    label: Total Crashes

pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: FATAL EXCEPTION
"#;
        let result = ReporterDef::from_yaml(yaml);
        if let Err(e) = &result {
            panic!("Minimal YAML failed to parse: {e}");
        }
        let proc = result.unwrap();
        assert_eq!(proc.meta.id, "java-crash-tracker");
        assert_eq!(proc.vars.len(), 1);
        assert_eq!(proc.pipeline.len(), 1);
    }

    /// Full Java Crash Tracker YAML — verified reference.
    #[test]
    fn parses_java_crash_tracker_full() {
        let yaml = r#"
meta:
  id: java-crash-tracker
  name: Java Crash Tracker

vars:
  - name: crash_count
    type: int
    default: 0
    display: true
    label: Total Crashes
  - name: crashes_by_process
    type: map
    display: true
    display_as: table
    label: Crashes by Process
    columns:
      - process
      - count

pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: FATAL EXCEPTION

  - stage: extract
    fields:
      - name: process
        pattern: 'Process: ([^,\n]+)'
      - name: exception
        pattern: '([\w.]+Exception)'

  - stage: script
    runtime: rhai
    src: |
      vars.crash_count += 1;
      let proc = if fields.process != () { fields.process } else { "unknown" };
      let exc  = if fields.exception != () { fields.exception } else { "unknown" };
      _emits.push(#{ process: proc, exception: exc });

  - stage: output
    views:
      - type: table
        source: emissions
        columns:
          - process
          - exception
"#;
        let result = ReporterDef::from_yaml(yaml);
        if let Err(e) = &result {
            panic!("Full Java Crash Tracker YAML failed to parse: {e}");
        }
        let proc = result.unwrap();
        assert_eq!(proc.meta.id, "java-crash-tracker");
        assert_eq!(proc.vars.len(), 2);
        assert_eq!(proc.pipeline.len(), 4);
    }

    /// Test CRLF line endings — common Windows clipboard paste issue.
    #[test]
    fn parses_yaml_with_crlf_endings() {
        let yaml = "meta:\r\n  id: java-crash-tracker\r\n  name: Java Crash Tracker\r\n\r\nvars:\r\n  - name: crash_count\r\n    type: int\r\n    default: 0\r\n    display: true\r\n\r\npipeline:\r\n  - stage: filter\r\n    rules:\r\n      - type: message_contains\r\n        value: FATAL EXCEPTION\r\n";
        let result = ReporterDef::from_yaml(yaml);
        if let Err(e) = &result {
            eprintln!("CRLF YAML parse error: {e}");
        }
        // We're probing whether serde_yaml 0.9 / libyaml handles CRLF
        assert!(result.is_ok(), "CRLF line endings broke parsing: {:?}", result.err());
    }

    /// Warp terminal adds 2-space margin to all code-block lines when copying,
    /// except the very first line. Verify auto-normalization recovers this.
    #[test]
    fn auto_normalizes_warp_copy_paste_indent() {
        // meta: at col 1, but its children at 4-space and siblings at 2-space —
        // exactly what the user reported pasting from Warp.
        // NOTE: use concat! so Rust line-continuation `\` does not strip the
        // leading spaces that are the whole point of this test.
        let yaml = concat!(
            "meta:\n",
            "    id: java-crash-tracker\n",
            "    name: Java Crash Tracker\n",
            "\n",
            "  vars:\n",
            "    - name: crash_count\n",
            "      type: int\n",
            "      default: 0\n",
            "      display: true\n",
            "      label: Total Crashes\n",
            "\n",
            "  pipeline:\n",
            "    - stage: filter\n",
            "      rules:\n",
            "        - type: message_contains\n",
            "          value: FATAL EXCEPTION\n",
        );
        let result = ReporterDef::from_yaml(yaml);
        assert!(
            result.is_ok(),
            "Warp-style indent should auto-normalize: {:?}",
            result.err()
        );
        let proc = result.unwrap();
        assert_eq!(proc.meta.id, "java-crash-tracker");
        assert_eq!(proc.vars.len(), 1);
        assert_eq!(proc.pipeline.len(), 1);
    }
}
