use std::collections::HashMap;
use serde::{Deserialize, Serialize};

use crate::processors::reporter::schema::FilterRule;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTrackerDef {
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub state: Vec<StateFieldDecl>,
    #[serde(default)]
    pub transitions: Vec<TransitionRule>,
    #[serde(default)]
    pub output: StateTrackerOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateFieldDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: StateFieldType,
    /// If omitted from YAML, defaults to `null` — meaning "unknown until first observed".
    #[serde(default)]
    pub default: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateFieldType {
    Bool,
    Int,
    Float,
    String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionRule {
    pub name: String,
    pub filter: TransitionFilter,
    /// Compiled filter rules derived from `filter` at parse time.
    /// Uses the shared `FilterRule` system for consistent matching semantics.
    #[serde(skip)]
    pub filter_rules: Vec<FilterRule>,
    #[serde(default)]
    pub set: HashMap<String, serde_yaml::Value>,
    #[serde(default)]
    pub clear: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TransitionFilter {
    pub tag: Option<String>,
    pub tag_regex: Option<String>,
    pub message_regex: Option<String>,
    pub message_contains: Option<String>,
    pub level: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
}

impl TransitionFilter {
    /// Convert this filter's fields into `Vec<FilterRule>` for use with the
    /// shared filter system. This gives state trackers the same matching
    /// semantics as reporters/transformers/correlators:
    /// - `tag` becomes `TagMatch` (prefix matching instead of exact)
    /// - `tag_regex` becomes `TagRegex` (with capture group support)
    /// - `level` becomes `LevelMin` (threshold instead of exact match)
    pub fn to_filter_rules(&self) -> Vec<FilterRule> {
        let mut rules = Vec::new();

        // Cheapest rules first (matching cost_rank ordering)
        if let Some(ref st) = self.source_type {
            rules.push(FilterRule::SourceTypeIs { source_type: st.clone() });
        }
        if let Some(ref sec) = self.section {
            rules.push(FilterRule::SectionIs { section: sec.clone() });
        }
        if let Some(ref lvl) = self.level {
            rules.push(FilterRule::LevelMin { level: lvl.clone() });
        }
        if let Some(ref t) = self.tag {
            let mut rule = FilterRule::TagMatch {
                tags: vec![t.clone()],
                tag_set: Vec::new(),
            };
            rule.prepare_tag_set();
            rules.push(rule);
        }
        if let Some(ref p) = self.tag_regex {
            rules.push(FilterRule::TagRegex { pattern: p.clone() });
        }
        if let Some(ref s) = self.message_contains {
            rules.push(FilterRule::MessageContains { value: s.clone() });
        }
        if let Some(ref p) = self.message_regex {
            rules.push(FilterRule::MessageRegex { pattern: p.clone() });
        }

        rules
    }
}

impl StateTrackerDef {
    /// Populate `filter_rules` on each `TransitionRule` from its `TransitionFilter`.
    /// Call this once after deserialization.
    pub fn compile_filter_rules(&mut self) {
        for transition in &mut self.transitions {
            transition.filter_rules = transition.filter.to_filter_rules();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StateTrackerOutput {
    #[serde(default)]
    pub timeline: bool,
    #[serde(default)]
    pub annotate: bool,
}
