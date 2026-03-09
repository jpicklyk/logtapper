pub mod annotator;
pub mod correlator;
pub mod filter;
pub mod marketplace;
pub mod registry;
pub mod reporter;
pub mod signals;
pub mod state_tracker;
pub mod transformer;

use serde::{Deserialize, Serialize};

pub use marketplace::SchemaContract;

use reporter::schema::{ReporterDef, DisplayAs};
use transformer::schema::TransformerDef;
use state_tracker::schema::StateTrackerDef;
use correlator::schema::CorrelatorDef;
use annotator::schema::AnnotatorDef;

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
    Annotator(AnnotatorDef),
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
            ProcessorKind::Annotator(_) => "annotator",
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
            _ => {} // Reporter, StateTracker, Annotator — all supported
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
                let def: StateTrackerDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("StateTracker YAML parse error: {e}"))?;
                ProcessorKind::StateTracker(def)
            }
            "correlator" => {
                let mut def: CorrelatorDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Correlator YAML parse error: {e}"))?;
                def.prepare_tag_sets();
                ProcessorKind::Correlator(def)
            }
            "annotator" => {
                let def: AnnotatorDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Annotator YAML parse error: {e}"))?;
                ProcessorKind::Annotator(def)
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
