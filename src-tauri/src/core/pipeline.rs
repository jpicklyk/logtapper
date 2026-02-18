/// Pipeline engine — executes ordered stages against a stream of LineContexts.
///
/// Phase 1: Filter and Extract stages only (no scripting, no aggregation).
/// Phase 2: Adds Script stage (Rhai), Aggregate stage, and variable system.
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::core::line::{LineContext, LogLevel};

// ---------------------------------------------------------------------------
// Stage definitions (loaded from YAML in Phase 2; hardcoded for Phase 1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum Stage {
    Filter { rules: Vec<FilterRule> },
    Extract { fields: Vec<ExtractField> },
    // Phase 2:
    // Script { runtime: String, src: String },
    // Aggregate { groups: Vec<AggregateGroup> },
    // Correlate { trigger: ..., lookback: ... },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FilterRule {
    TagMatch { tags: Vec<String> },
    MessageContains { value: String },
    MessageContainsAny { values: Vec<String> },
    MessageRegex { pattern: String },
    LevelMin { level: LogLevel },
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

// ---------------------------------------------------------------------------
// Emission — what a processor outputs for each matched line
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Emission {
    pub line_num: usize,
    pub fields: std::collections::HashMap<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Pipeline executor
// ---------------------------------------------------------------------------

pub struct Pipeline {
    pub stages: Vec<Stage>,
    /// Pre-compiled regex cache for FilterRule::MessageRegex and ExtractField.
    filter_regexes: Vec<Option<Regex>>,
    extract_regexes: Vec<Option<Regex>>,
}

impl Pipeline {
    pub fn new(stages: Vec<Stage>) -> Self {
        // Pre-compile all regex patterns
        let mut filter_regexes = Vec::new();
        let mut extract_regexes = Vec::new();

        for stage in &stages {
            match stage {
                Stage::Filter { rules } => {
                    for rule in rules {
                        if let FilterRule::MessageRegex { pattern } = rule {
                            filter_regexes.push(Regex::new(pattern).ok());
                        }
                    }
                }
                Stage::Extract { fields } => {
                    for field in fields {
                        extract_regexes.push(Regex::new(&field.pattern).ok());
                    }
                }
            }
        }

        Self {
            stages,
            filter_regexes,
            extract_regexes,
        }
    }

    /// Run the pipeline against one line. Returns `Some(emission)` if the line
    /// passed all filter stages and produced extracted fields, or `None` if filtered out.
    pub fn process_line(&self, ctx: &mut LineContext) -> Option<Emission> {
        let mut filter_regex_idx = 0usize;
        let mut extract_regex_idx = 0usize;

        for stage in &self.stages {
            match stage {
                Stage::Filter { rules } => {
                    for rule in rules {
                        let passes = match rule {
                            FilterRule::TagMatch { tags } => {
                                tags.iter().any(|t| t == &ctx.tag)
                            }
                            FilterRule::MessageContains { value } => {
                                ctx.message.contains(value.as_str())
                            }
                            FilterRule::MessageContainsAny { values } => {
                                values.iter().any(|v| ctx.message.contains(v.as_str()))
                            }
                            FilterRule::MessageRegex { .. } => {
                                let re = self.filter_regexes.get(filter_regex_idx)?;
                                filter_regex_idx += 1;
                                re.as_ref().map(|r| r.is_match(&ctx.raw)).unwrap_or(false)
                            }
                            FilterRule::LevelMin { level } => ctx.level >= *level,
                        };
                        if !passes {
                            return None;
                        }
                    }
                }
                Stage::Extract { fields } => {
                    for field in fields {
                        let re = self
                            .extract_regexes
                            .get(extract_regex_idx)
                            .and_then(|r| r.as_ref());
                        extract_regex_idx += 1;

                        if let Some(re) = re {
                            if let Some(caps) = re.captures(&ctx.raw) {
                                if let Some(m) = caps.get(1) {
                                    let raw_val = m.as_str();
                                    let value = match &field.cast {
                                        Some(CastType::Int) => raw_val
                                            .parse::<i64>()
                                            .map(serde_json::Value::from)
                                            .unwrap_or_else(|_| {
                                                serde_json::Value::String(raw_val.to_string())
                                            }),
                                        Some(CastType::Float) => raw_val
                                            .parse::<f64>()
                                            .ok()
                                            .and_then(|f| serde_json::Number::from_f64(f))
                                            .map(serde_json::Value::Number)
                                            .unwrap_or_else(|| {
                                                serde_json::Value::String(raw_val.to_string())
                                            }),
                                        _ => serde_json::Value::String(raw_val.to_string()),
                                    };
                                    ctx.fields.insert(field.name.clone(), value);
                                }
                            }
                        }
                    }
                }
            }
        }

        // If we reach here the line passed all filter stages.
        Some(Emission {
            line_num: ctx.source_line_num,
            fields: ctx.fields.clone(),
        })
    }
}
