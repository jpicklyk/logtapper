use std::collections::HashMap;
use serde::{Deserialize, Serialize};

use crate::processors::reporter::schema::FilterRule;

/// Controls how a state tracker's snapshot is resolved relative to the selected line.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TrackerMode {
    /// State is reconstructed by replaying transitions up to the selected line.
    #[default]
    TimeSeries,
    /// State is always the final state — used for point-in-time dumps (e.g. dumpsys).
    Snapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTrackerDef {
    #[serde(default)]
    pub group: String,
    /// Section names to restrict processing to (Bugreport/Dumpstate only).
    /// Empty = process all lines regardless of section.
    /// Exact match against section names as parsed by BugreportParser.
    #[serde(default)]
    pub sections: Vec<String>,
    #[serde(default)]
    pub mode: TrackerMode,
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
    /// Distinct section names this tracker is configured to process, combining
    /// top-level `sections` and per-transition `filter.section` entries.
    pub fn section_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.sections.iter().map(String::as_str).collect();
        for transition in &self.transitions {
            if let Some(ref sec) = transition.filter.section {
                if !names.contains(&sec.as_str()) {
                    names.push(sec.as_str());
                }
            }
        }
        names
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_YAML: &str = r#"
group: Network
state:
  - name: status
    type: string
    default: unknown
transitions:
  - name: connected
    filter:
      message_contains: "connected"
    set:
      status: connected
"#;

    #[test]
    fn parse_minimal_state_tracker_yaml() {
        let def: StateTrackerDef = serde_yaml::from_str(MINIMAL_YAML).unwrap();
        assert_eq!(def.group, "Network");
        assert_eq!(def.state.len(), 1);
        assert_eq!(def.state[0].name, "status");
        assert_eq!(def.transitions.len(), 1);
        assert_eq!(def.transitions[0].name, "connected");
        assert_eq!(
            def.transitions[0].filter.message_contains.as_deref(),
            Some("connected")
        );
        assert_eq!(
            def.transitions[0].set.get("status").and_then(|v| v.as_str()),
            Some("connected")
        );
    }

    #[test]
    fn parse_state_tracker_with_clear_transition() {
        let yaml = r#"
state:
  - name: active
    type: bool
    default: false
transitions:
  - name: reset
    filter:
      message_contains: "reset"
    clear:
      - active
"#;
        let def: StateTrackerDef = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(def.transitions.len(), 1);
        assert_eq!(def.transitions[0].clear, vec!["active"]);
        assert!(def.transitions[0].set.is_empty());
    }

    #[test]
    fn parse_state_tracker_with_group() {
        let yaml = r#"
group: WiFi
state:
  - name: conn
    type: string
    default: disconnected
transitions:
  - name: up
    filter:
      tag: WifiStateMachine
    set:
      conn: connected
"#;
        let def: StateTrackerDef = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(def.group, "WiFi");
        assert_eq!(def.transitions[0].filter.tag.as_deref(), Some("WifiStateMachine"));
    }

    #[test]
    fn compile_filter_rules_populates_filter_rules() {
        let mut def: StateTrackerDef = serde_yaml::from_str(MINIMAL_YAML).unwrap();
        // Before compile, filter_rules is empty (serde skips it)
        assert!(def.transitions[0].filter_rules.is_empty());
        def.compile_filter_rules();
        // After compile, filter_rules should have the MessageContains rule
        assert!(!def.transitions[0].filter_rules.is_empty());
        let rule = &def.transitions[0].filter_rules[0];
        assert!(matches!(rule, crate::processors::reporter::schema::FilterRule::MessageContains { value } if value == "connected"));
    }
}
