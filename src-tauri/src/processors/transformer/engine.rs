use std::collections::HashMap;
use std::sync::Arc;
use regex::Regex;
use crate::core::line::LineContext;
use crate::processors::reporter::schema::FilterStage;
use crate::anonymizer::config::AnonymizerConfig;
use crate::processors::transformer::schema::{TransformerDef, TransformOp, BuiltinTransformer};
use crate::processors::transformer::types::ContinuousTransformerState;
use crate::processors::transformer::builtin::PiiTransformer;

pub struct TransformerRun {
    def: TransformerDef,
    pii_transformer: Option<PiiTransformer>,
    regex_cache: HashMap<String, Regex>,
}

impl TransformerRun {
    pub fn new(def: &TransformerDef) -> Self {
        let pii_transformer = if def
            .builtin
            .as_ref()
            .is_some_and(|b| matches!(b, BuiltinTransformer::PiiAnonymizer))
        {
            Some(PiiTransformer::new())
        } else {
            None
        };
        TransformerRun {
            def: def.clone(),
            pii_transformer,
            regex_cache: HashMap::new(),
        }
    }

    /// Build using the user's configured anonymizer detectors instead of hardcoded defaults.
    /// Use this in the pipeline so Settings → PII config is respected.
    pub fn new_with_anonymizer_config(def: &TransformerDef, config: &AnonymizerConfig) -> Self {
        let pii_transformer = if def
            .builtin
            .as_ref()
            .is_some_and(|b| matches!(b, BuiltinTransformer::PiiAnonymizer))
        {
            Some(PiiTransformer::from_config(config))
        } else {
            None
        };
        TransformerRun {
            def: def.clone(),
            pii_transformer,
            regex_cache: HashMap::new(),
        }
    }

    pub fn new_seeded(def: &TransformerDef, saved: ContinuousTransformerState) -> Self {
        let is_pii = def
            .builtin
            .as_ref()
            .is_some_and(|b| matches!(b, BuiltinTransformer::PiiAnonymizer));

        let pii_transformer = if is_pii {
            Some(match saved.pii_mappings {
                Some(mappings) if !mappings.is_empty() => {
                    PiiTransformer::from_mappings(mappings)
                }
                _ => PiiTransformer::new(),
            })
        } else {
            None
        };

        TransformerRun {
            def: def.clone(),
            pii_transformer,
            regex_cache: HashMap::new(),
        }
    }

    pub fn process_line(&mut self, line: &mut LineContext) -> bool {
        if let Some(filter) = &self.def.filter {
            if !apply_filter(&mut self.regex_cache, filter, line) {
                return false;
            }
        }
        if let Some(pii) = &mut self.pii_transformer {
            pii.apply(line);
        }
        for op in &self.def.transforms {
            apply_transform_op(&mut self.regex_cache, op, line);
        }
        true
    }

    pub fn get_pii_mappings(&self) -> HashMap<String, String> {
        self.pii_transformer
            .as_ref()
            .map(super::builtin::PiiTransformer::current_mappings)
            .unwrap_or_default()
    }

    pub fn into_continuous_state(self, last_processed_line: usize) -> ContinuousTransformerState {
        let pii_mappings = self
            .pii_transformer
            .as_ref()
            .map(super::builtin::PiiTransformer::current_mappings)
            .filter(|m| !m.is_empty());
        ContinuousTransformerState {
            last_processed_line,
            pii_mappings,
        }
    }

}

fn apply_filter(regex_cache: &mut HashMap<String, Regex>, stage: &FilterStage, line: &LineContext) -> bool {
    for rule in &stage.rules {
        if !crate::processors::filter::rule_matches(regex_cache, rule, line, None).matched {
            return false;
        }
    }
    true
}

fn apply_transform_op(regex_cache: &mut HashMap<String, Regex>, op: &TransformOp, line: &mut LineContext) {
    match op {
        TransformOp::ReplaceField { field, regex, replacement } => {
            if let Some(re) = crate::processors::filter::get_or_compile(regex_cache, regex) {
                if field == "message" {
                    let new_msg = re.replace_all(&line.message, replacement.as_str());
                    line.message = Arc::from(new_msg.as_ref());
                } else if field == "tag" {
                    let new_tag = re.replace_all(&line.tag, replacement.as_str());
                    line.tag = Arc::from(new_tag.as_ref());
                } else if let Some(serde_json::Value::String(val)) = line.fields.get(field) {
                    let new_val = re.replace_all(val, replacement.as_str()).to_string();
                    line.fields.insert(field.clone(), serde_json::Value::String(new_val));
                }
            }
        }
        TransformOp::SetField { name, value } => {
            let json_val = yaml_to_json(value);
            line.fields.insert(name.clone(), json_val);
        }
        TransformOp::DropField { name } => {
            line.fields.remove(name);
        }
        TransformOp::AddField { name, script: _script } => {
            line.fields.entry(name.clone()).or_insert(serde_json::Value::String(String::new()));
        }
    }
}

fn yaml_to_json(value: &serde_yaml::Value) -> serde_json::Value {
    match value {
        serde_yaml::Value::String(s) => serde_json::Value::String(s.clone()),
        serde_yaml::Value::Bool(b) => serde_json::Value::Bool(*b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::Number(i.into())
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f)
                    .map_or(serde_json::Value::Null, serde_json::Value::Number)
            } else {
                serde_json::Value::Null
            }
        }
        serde_yaml::Value::Sequence(seq) => {
            serde_json::Value::Array(seq.iter().map(yaml_to_json).collect())
        }
        _ => serde_json::Value::Null, // includes Null
    }
}



#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::line::LogLevel;
    use crate::processors::transformer::schema::TransformOp;

    fn make_line(message: &str) -> LineContext {
        LineContext {
            raw: Arc::from(message),
            timestamp: 0,
            level: LogLevel::Info,
            tag: Arc::from("TestTag"),
            pid: 0,
            tid: 0,
            message: Arc::from(message),
            source_id: Arc::from(""),
            source_line_num: 1,
            fields: HashMap::new(),
            annotations: vec![],
        }
    }

    fn make_def_with_ops(ops: Vec<TransformOp>) -> TransformerDef {
        TransformerDef {
            filter: None,
            transforms: ops,
            builtin: None,
        }
    }

    #[test]
    fn test_replace_field_message() {
        let def = make_def_with_ops(vec![TransformOp::ReplaceField {
            field: "message".to_string(),
            regex: r"\d{4}-\d{2}-\d{2}".to_string(),
            replacement: "DATE".to_string(),
        }]);
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("Error on 2024-01-15: something failed");
        let keep = run.process_line(&mut line);
        assert!(keep);
        assert_eq!(&*line.message, "Error on DATE: something failed");
    }

    #[test]
    fn test_set_field() {
        let def = make_def_with_ops(vec![TransformOp::SetField {
            name: "severity".to_string(),
            value: serde_yaml::Value::String("high".to_string()),
        }]);
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("some error");
        run.process_line(&mut line);
        assert_eq!(
            line.fields.get("severity"),
            Some(&serde_json::Value::String("high".to_string()))
        );
    }

    #[test]
    fn test_drop_field() {
        let def = make_def_with_ops(vec![TransformOp::DropField {
            name: "secret".to_string(),
        }]);
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("some message");
        line.fields.insert(
            "secret".to_string(),
            serde_json::Value::String("sensitive_data".to_string()),
        );
        run.process_line(&mut line);
        assert!(!line.fields.contains_key("secret"));
    }

    #[test]
    fn test_continuous_state_round_trip() {
        let def = TransformerDef { filter: None, transforms: vec![], builtin: None };
        let run = TransformerRun::new(&def);
        let state = run.into_continuous_state(42);
        assert_eq!(state.last_processed_line, 42);
        assert!(state.pii_mappings.is_none());
    }

    #[test]
    fn test_filter_drops_non_matching_line() {
        use crate::processors::reporter::schema::{FilterRule, FilterStage};
        let def = TransformerDef {
            filter: Some(FilterStage {
                source: None,
                rules: vec![FilterRule::MessageContains { value: "ERROR".to_string() }],
            }),
            transforms: vec![],
            builtin: None,
        };
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("normal debug line");
        let keep = run.process_line(&mut line);
        assert!(!keep, "Line without ERROR should be dropped by filter");
    }

    #[test]
    fn test_filter_passes_matching_line() {
        use crate::processors::reporter::schema::{FilterRule, FilterStage};
        let def = TransformerDef {
            filter: Some(FilterStage {
                source: None,
                rules: vec![FilterRule::MessageContains { value: "ERROR".to_string() }],
            }),
            transforms: vec![],
            builtin: None,
        };
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("ERROR: something went wrong");
        let keep = run.process_line(&mut line);
        assert!(keep, "Line with ERROR should pass filter");
    }

    #[test]
    fn test_new_seeded_produces_valid_run() {
        let def = TransformerDef { filter: None, transforms: vec![], builtin: None };
        let saved = ContinuousTransformerState { last_processed_line: 100, pii_mappings: None };
        let mut run = TransformerRun::new_seeded(&def, saved);
        let mut line = make_line("hello");
        let keep = run.process_line(&mut line);
        assert!(keep);
    }
}
