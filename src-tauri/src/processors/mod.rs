pub mod annotator;
pub mod correlator;
pub mod registry;
pub mod reporter;
pub mod state_tracker;
pub mod transformer;

use serde::{Deserialize, Serialize};

use reporter::schema::ReporterDef;
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
                if def.group.is_empty() {
                    None
                } else {
                    Some(def.group.clone())
                }
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

        let meta: ProcessorMeta = serde_yaml::from_str(yaml)
            .map_err(|e| format!("YAML meta parse error: {e}"))?;

        let kind = match shard.processor_type.as_deref().unwrap_or("reporter") {
            "reporter" => {
                let def: ReporterDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Reporter YAML parse error: {e}"))?;
                ProcessorKind::Reporter(def)
            }
            "transformer" => {
                let def: TransformerDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Transformer YAML parse error: {e}"))?;
                ProcessorKind::Transformer(def)
            }
            "state_tracker" => {
                let def: StateTrackerDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("StateTracker YAML parse error: {e}"))?;
                ProcessorKind::StateTracker(def)
            }
            "correlator" => {
                let def: CorrelatorDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Correlator YAML parse error: {e}"))?;
                ProcessorKind::Correlator(def)
            }
            "annotator" => {
                let def: AnnotatorDef = serde_yaml::from_str(yaml)
                    .map_err(|e| format!("Annotator YAML parse error: {e}"))?;
                ProcessorKind::Annotator(def)
            }
            other => return Err(format!("Unknown processor type: '{other}'")),
        };

        Ok(AnyProcessor { meta, kind })
    }
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
}

impl From<&AnyProcessor> for ProcessorSummary {
    fn from(p: &AnyProcessor) -> Self {
        ProcessorSummary {
            id: p.meta.id.clone(),
            name: p.meta.name.clone(),
            version: p.meta.version.clone(),
            description: p.meta.description.clone(),
            tags: p.meta.tags.clone(),
            builtin: p.meta.builtin,
            processor_type: p.processor_type().to_string(),
            group: p.group(),
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
