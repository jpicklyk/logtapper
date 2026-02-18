use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Top-level processor definition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessorDef {
    pub meta: ProcessorMeta,
    #[serde(default)]
    pub sources: SourceRequirements,
    #[serde(default)]
    pub vars: Vec<VarDecl>,
    #[serde(default)]
    pub pipeline: Vec<PipelineStage>,
}

impl ProcessorDef {
    pub fn from_yaml(yaml: &str) -> Result<Self, String> {
        serde_yaml::from_str(yaml).map_err(|e| format!("YAML parse error: {e}"))
    }

    pub fn to_yaml(&self) -> Result<String, String> {
        serde_yaml::to_string(self).map_err(|e| format!("YAML serialize error: {e}"))
    }
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessorMeta {
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
        let proc = ProcessorDef::from_yaml(SAMPLE_YAML).unwrap();
        assert_eq!(proc.meta.id, "test-proc");
        assert_eq!(proc.vars.len(), 1);
        assert_eq!(proc.pipeline.len(), 4);
    }

    #[test]
    fn roundtrips_to_yaml() {
        let proc = ProcessorDef::from_yaml(SAMPLE_YAML).unwrap();
        let yaml = proc.to_yaml().unwrap();
        let proc2 = ProcessorDef::from_yaml(&yaml).unwrap();
        assert_eq!(proc.meta.id, proc2.meta.id);
    }
}
