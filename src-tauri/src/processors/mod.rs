pub mod correlator;
pub mod filter;
pub mod marketplace;
pub mod pack;
pub mod registry;
pub mod reporter;
pub mod signals;
pub mod state_tracker;
pub mod transformer;

use serde::{Deserialize, Serialize};

pub use marketplace::SchemaContract;
pub use pack::{PackMeta, PackSummary};

use reporter::schema::{ReporterDef, DisplayAs};
use transformer::schema::TransformerDef;
use state_tracker::schema::StateTrackerDef;
use correlator::schema::CorrelatorDef;
// Re-export for backward compatibility with existing callers
pub use reporter::schema::ReporterDef as ProcessorDef;
pub use reporter::engine::ProcessorRun;
pub use reporter::engine::RunResult;
pub use reporter::engine::ContinuousRunState;
pub use reporter::engine::Emission;
pub use reporter::vars::VarStore;

/// Shared metadata present in all processor YAML files.
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
    #[serde(default)]
    pub builtin: bool,
    /// SPDX license identifier (e.g. "MIT", "Apache-2.0").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// Standardized category from the taxonomy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Source repository URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Whether this processor is deprecated and should not be newly installed.
    #[serde(default)]
    pub deprecated: bool,
}

fn default_version() -> String {
    "1.0.0".to_string()
}

#[derive(Debug, Clone)]
pub enum ProcessorKind {
    Reporter(ReporterDef),
    Transformer(TransformerDef),
    StateTracker(StateTrackerDef),
    Correlator(CorrelatorDef),
}

#[derive(Debug, Clone)]
pub struct AnyProcessor {
    pub meta: ProcessorMeta,
    pub kind: ProcessorKind,
    /// Optional schema contract declaring emissions and MCP exposure.
    pub schema: Option<SchemaContract>,
    /// Marketplace source name (e.g. "official"), set at install time.
    pub source: Option<String>,
}

impl AnyProcessor {
    pub fn processor_type(&self) -> &'static str {
        match &self.kind {
            ProcessorKind::Reporter(_) => "reporter",
            ProcessorKind::Transformer(_) => "transformer",
            ProcessorKind::StateTracker(_) => "state_tracker",
            ProcessorKind::Correlator(_) => "correlator",
        }
    }

    pub fn group(&self) -> Option<String> {
        match &self.kind {
            ProcessorKind::StateTracker(def) => {
                if def.group.is_empty() { None } else { Some(def.group.clone()) }
            }
            _ => None,
        }
    }

    pub fn as_reporter(&self) -> Option<&ReporterDef> {
        match &self.kind {
            ProcessorKind::Reporter(def) => Some(def),
            _ => None,
        }
    }

    pub fn as_transformer(&self) -> Option<&TransformerDef> {
        match &self.kind {
            ProcessorKind::Transformer(def) => Some(def),
            _ => None,
        }
    }

    pub fn as_state_tracker(&self) -> Option<&StateTrackerDef> {
        match &self.kind {
            ProcessorKind::StateTracker(def) => Some(def),
            _ => None,
        }
    }

    pub fn as_correlator(&self) -> Option<&CorrelatorDef> {
        match &self.kind {
            ProcessorKind::Correlator(def) => Some(def),
            _ => None,
        }
    }

    /// Validate that filter rules are compatible with this processor type.
    /// `SourceTypeIs` and `SectionIs` are only supported by reporters and state
    /// trackers — reject them at install time for other processor types.
    pub fn validate_filter_rules(&self) -> Result<(), String> {
        use reporter::schema::FilterRule;

        fn check_rules(rules: &[FilterRule], proc_id: &str, proc_type: &str) -> Result<(), String> {
            for rule in rules {
                match rule {
                    FilterRule::SourceTypeIs { .. } | FilterRule::SectionIs { .. } => {
                        return Err(format!(
                            "Processor '{}' (type: {}) uses an unsupported filter rule: {}. \
                             source_type_is and section_is are only supported in reporters and state_trackers.",
                            proc_id, proc_type, rule.rule_name(),
                        ));
                    }
                    _ => {}
                }
            }
            Ok(())
        }

        match &self.kind {
            ProcessorKind::Correlator(def) => {
                for src in &def.sources {
                    check_rules(&src.filter, &self.meta.id, "correlator")?;
                }
            }
            ProcessorKind::Transformer(def) => {
                if let Some(ref stage) = def.filter {
                    check_rules(&stage.rules, &self.meta.id, "transformer")?;
                }
            }
            _ => {} // Reporter, StateTracker — all filter rules supported
        }
        Ok(())
    }

    pub fn from_yaml(yaml: &str) -> Result<Self, String> {
        // Strip UTF-8 BOM if present (common Windows file artifact)
        let yaml = yaml.trim_start_matches('\u{FEFF}');
        // First parse just the type discriminator + meta fields
        #[derive(Deserialize)]
        struct TypeShard {
            #[serde(rename = "type", default)]
            processor_type: Option<String>,
        }

        let shard: TypeShard = serde_yaml::from_str(yaml)
            .map_err(|e| format!("YAML parse error: {e}"))?;

        // Extract ProcessorMeta supporting two YAML layouts:
        //   Root-level:  id: foo / name: bar / ...   (transformers, state_trackers)
        //   Nested meta: meta: { id: foo, name: bar } (reporters generated by AI)
        // Whichever fields are non-empty at root level take precedence; missing
        // root fields fall back to the nested `meta:` block if present.
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct MetaShard {
            id: String,
            name: String,
            version: String,
            author: String,
            description: String,
            tags: Vec<String>,
            builtin: bool,
            license: Option<String>,
            category: Option<String>,
            repository: Option<String>,
            deprecated: bool,
            meta: Option<MetaInner>,
            schema: Option<SchemaContract>,
        }
        #[derive(Deserialize)]
        struct MetaInner {
            id: String,
            #[serde(default)] name: String,
            #[serde(default)] version: String,
            #[serde(default)] author: String,
            #[serde(default)] description: String,
            #[serde(default)] tags: Vec<String>,
            #[serde(default)] builtin: bool,
            #[serde(default)] license: Option<String>,
            #[serde(default)] category: Option<String>,
            #[serde(default)] repository: Option<String>,
            #[serde(default)] deprecated: bool,
        }
        let ms: MetaShard = serde_yaml::from_str(yaml)
            .map_err(|e| format!("YAML meta parse error: {e}"))?;

        let pick = |root: String, nested: Option<String>| -> String {
            if !root.is_empty() { root } else { nested.unwrap_or_default() }
        };
        let pick_opt = |root: Option<String>, nested: Option<String>| -> Option<String> {
            root.or(nested)
        };
        let id   = pick(ms.id.clone(),          ms.meta.as_ref().map(|m| m.id.clone()));
        let name = pick(ms.name.clone(),         ms.meta.as_ref().map(|m| m.name.clone()));
        let ver  = pick(ms.version.clone(),      ms.meta.as_ref().map(|m| m.version.clone()));
        let auth = pick(ms.author.clone(),       ms.meta.as_ref().map(|m| m.author.clone()));
        let desc = pick(ms.description.clone(),  ms.meta.as_ref().map(|m| m.description.clone()));
        let tags = if !ms.tags.is_empty() { ms.tags } else { ms.meta.as_ref().map(|m| m.tags.clone()).unwrap_or_default() };
        let builtin = ms.builtin || ms.meta.as_ref().is_some_and(|m| m.builtin);
        let license    = pick_opt(ms.license,    ms.meta.as_ref().and_then(|m| m.license.clone()));
        let category   = pick_opt(ms.category,   ms.meta.as_ref().and_then(|m| m.category.clone()));
        let repository = pick_opt(ms.repository, ms.meta.as_ref().and_then(|m| m.repository.clone()));
        let deprecated = ms.deprecated || ms.meta.as_ref().is_some_and(|m| m.deprecated);

        if id.is_empty()   { return Err("Processor YAML must have an 'id' field (or 'meta.id')".to_string()); }
        if name.is_empty() { return Err("Processor YAML must have a 'name' field (or 'meta.name')".to_string()); }

        // Validate that bare processor IDs do not contain the namespace separator.
        // Qualified IDs (id@source) are set externally, not parsed from YAML.
        marketplace::validate_processor_id(&id)?;

        let meta = ProcessorMeta {
            id,
            name,
            version: if ver.is_empty() { "1.0.0".to_string() } else { ver },
            author: auth,
            description: desc,
            tags,
            builtin,
            license,
            category,
            repository,
            deprecated,
        };

        let mut schema = ms.schema;
        if let Some(ref mut s) = schema {
            s.prepare_conditions();
        }

        let kind = match shard.processor_type.as_deref().unwrap_or("reporter") {
            "reporter" => {
                let mut def: ReporterDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Reporter YAML parse error: {e}"))?;
                def.prepare_tag_sets();
                ProcessorKind::Reporter(def)
            }
            "transformer" => {
                // Only built-in transformers (id prefix `__`) are allowed.
                // User-created transformers add complexity for no real-world value;
                // the only transformer is the built-in PII anonymizer.
                if !meta.id.starts_with("__") {
                    return Err("Transformer processors cannot be created by users. \
                                Use reporter or state_tracker instead.".into());
                }
                let mut def: TransformerDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Transformer YAML parse error: {e}"))?;
                def.prepare_tag_sets();
                ProcessorKind::Transformer(def)
            }
            "state_tracker" => {
                let mut def: StateTrackerDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("StateTracker YAML parse error: {e}"))?;
                def.compile_filter_rules();
                ProcessorKind::StateTracker(def)
            }
            "correlator" => {
                let mut def: CorrelatorDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Correlator YAML parse error: {e}"))?;
                def.prepare_tag_sets();
                ProcessorKind::Correlator(def)
            }
            other => return Err(format!("Unknown processor type: '{other}'")),
        };

        Ok(AnyProcessor { meta, kind, schema, source: None })
    }
}

/// Display metadata for a single var declaration — sent with ProcessorSummary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VarMeta {
    pub name: String,
    /// Human-readable label (from YAML `label:`, or title-cased name as fallback).
    pub label: String,
    pub display: bool,
    /// `"table"` or `"value"` (from YAML `display_as:`), or None.
    pub display_as: Option<String>,
    pub columns: Vec<String>,
}

/// IPC-serializable summary (returned by list_processors command).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessorSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub tags: Vec<String>,
    pub builtin: bool,
    pub processor_type: String,
    pub group: Option<String>,
    /// Var declarations from the YAML (reporters only; empty for other types).
    pub vars_meta: Vec<VarMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub deprecated: bool,
    /// Whether this processor has a schema contract defined.
    pub has_schema: bool,
    /// Marketplace source name (e.g. "official", "my-team"), if installed from a source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Pack ID this processor belongs to, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_id: Option<String>,
    /// State tracker mode. Only set for state_tracker type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_mode: Option<crate::processors::state_tracker::schema::TrackerMode>,
    /// Section names this state tracker targets (bugreport/dumpstate only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tracker_sections: Vec<String>,
    /// Log source types this processor supports (from schema.source_types).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source_types: Vec<String>,
}

fn snake_to_title(s: &str) -> String {
    s.split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

impl From<&AnyProcessor> for ProcessorSummary {
    fn from(p: &AnyProcessor) -> Self {
        let vars_meta = match &p.kind {
            ProcessorKind::Reporter(def) => def.vars.iter().map(|v| VarMeta {
                name: v.name.clone(),
                label: v.label.clone().unwrap_or_else(|| snake_to_title(&v.name)),
                display: v.display,
                display_as: v.display_as.as_ref().map(|d| match d {
                    DisplayAs::Table => "table".to_string(),
                    DisplayAs::Value => "value".to_string(),
                }),
                columns: v.columns.clone(),
            }).collect(),
            _ => Vec::new(),
        };

        ProcessorSummary {
            id: p.meta.id.clone(),
            name: p.meta.name.clone(),
            version: p.meta.version.clone(),
            description: p.meta.description.clone(),
            tags: p.meta.tags.clone(),
            builtin: p.meta.builtin,
            processor_type: p.processor_type().to_string(),
            group: p.group(),
            vars_meta,
            license: p.meta.license.clone(),
            category: p.meta.category.clone(),
            repository: p.meta.repository.clone(),
            deprecated: p.meta.deprecated,
            has_schema: p.schema.is_some(),
            source: p.source.clone(),
            pack_id: None,
            tracker_mode: match &p.kind {
                ProcessorKind::StateTracker(def) => Some(def.mode),
                _ => None,
            },
            tracker_sections: match &p.kind {
                ProcessorKind::StateTracker(def) => def.section_names().into_iter().map(str::to_string).collect(),
                _ => Vec::new(),
            },
            source_types: p.schema.as_ref().map(|s| s.source_types.clone()).unwrap_or_default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Backward-compatibility shim modules
// These re-export from the new submodule locations so existing callers
// (commands/, charts/, scripting/) that reference the old paths still compile.
// ---------------------------------------------------------------------------

/// Shim: `crate::processors::schema` -> `reporter::schema`
pub mod schema {
    pub use crate::processors::reporter::schema::*;
}

/// Shim: `crate::processors::interpreter` -> `reporter::engine`
pub mod interpreter {
    pub use crate::processors::reporter::engine::*;
}

/// Shim: `crate::processors::vars` -> `reporter::vars`
pub mod vars {
    pub use crate::processors::reporter::vars::*;
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_REPORTER: &str = r#"
meta:
  id: test-reporter
  name: Test Reporter
  version: 1.0.0
"#;

    const MINIMAL_STATE_TRACKER: &str = r#"
type: state_tracker
id: test-tracker
name: Test Tracker
version: 1.0.0
group: Test
state:
  - name: status
    type: string
    default: unknown
transitions:
  - name: active
    filter:
      message_contains: started
    set:
      status: active
"#;

    const MINIMAL_CORRELATOR: &str = r#"
type: correlator
id: test-correlator
name: Test Correlator
version: 1.0.0
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

    const MINIMAL_TRANSFORMER: &str = r#"
type: transformer
id: __test-transformer
name: Test Transformer
version: 1.0.0
transforms:
  - op: replace_field
    field: message
    regex: "secret"
    replacement: "***"
"#;

    #[test]
    fn from_yaml_parses_reporter() {
        let p = AnyProcessor::from_yaml(MINIMAL_REPORTER).unwrap();
        assert_eq!(p.processor_type(), "reporter");
        assert_eq!(p.meta.id, "test-reporter");
        assert_eq!(p.meta.name, "Test Reporter");
    }

    #[test]
    fn from_yaml_parses_state_tracker() {
        let p = AnyProcessor::from_yaml(MINIMAL_STATE_TRACKER).unwrap();
        assert_eq!(p.processor_type(), "state_tracker");
        assert_eq!(p.meta.id, "test-tracker");
    }

    #[test]
    fn from_yaml_parses_correlator() {
        let p = AnyProcessor::from_yaml(MINIMAL_CORRELATOR).unwrap();
        assert_eq!(p.processor_type(), "correlator");
        assert_eq!(p.meta.id, "test-correlator");
    }

    #[test]
    fn from_yaml_parses_transformer() {
        let p = AnyProcessor::from_yaml(MINIMAL_TRANSFORMER).unwrap();
        assert_eq!(p.processor_type(), "transformer");
        assert_eq!(p.meta.id, "__test-transformer");
    }

    #[test]
    fn from_yaml_rejects_invalid_yaml() {
        let result = AnyProcessor::from_yaml("<<<not yaml>>>");
        assert!(result.is_err());
    }

    #[test]
    fn from_yaml_defaults_to_reporter() {
        // YAML without a `type:` field should default to reporter
        let yaml = r#"
meta:
  id: implicit-reporter
  name: Implicit Reporter
"#;
        let p = AnyProcessor::from_yaml(yaml).unwrap();
        assert_eq!(p.processor_type(), "reporter");
    }

    #[test]
    fn from_yaml_rejects_unknown_type() {
        let yaml = r#"
type: foobar
meta:
  id: bad-proc
  name: Bad Processor
"#;
        let result = AnyProcessor::from_yaml(yaml);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("foobar"), "error should mention the unknown type: {msg}");
    }

    #[test]
    fn processor_summary_from_any_processor() {
        let p = AnyProcessor::from_yaml(MINIMAL_REPORTER).unwrap();
        let summary = ProcessorSummary::from(&p);
        assert_eq!(summary.id, "test-reporter");
        assert_eq!(summary.name, "Test Reporter");
        assert_eq!(summary.version, "1.0.0");
        assert_eq!(summary.processor_type, "reporter");
        assert!(!summary.builtin);
        assert!(!summary.deprecated);
        assert!(!summary.has_schema);
    }

    #[test]
    fn validate_filter_rules_accepts_valid_regex() {
        // A reporter with message_regex is valid — validate_filter_rules only
        // checks for SourceTypeIs/SectionIs in correlator/transformer types.
        let yaml = r#"
meta:
  id: regex-reporter
  name: Regex Reporter
pipeline:
  - stage: filter
    rules:
      - type: message_regex
        pattern: "foo.*bar"
"#;
        let p = AnyProcessor::from_yaml(yaml).unwrap();
        assert!(p.validate_filter_rules().is_ok());
    }

    #[test]
    fn validate_filter_rules_rejects_source_type_is_in_correlator() {
        // Correlators must not use SourceTypeIs — this is what validate_filter_rules
        // actually checks. Invalid regex silently passes per design (see CLAUDE.md).
        let yaml = r#"
type: correlator
id: bad-correlator
name: Bad Correlator
sources:
  - id: src_a
    filter:
      - type: source_type_is
        source_type: Logcat
  - id: src_b
    filter:
      - type: tag_match
        tags: [TagB]
correlate:
  trigger: src_b
  within_lines: 100
  emit: "test"
"#;
        let p = AnyProcessor::from_yaml(yaml).unwrap();
        let result = p.validate_filter_rules();
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("source_type_is"), "error should mention the rule: {msg}");
    }
}
