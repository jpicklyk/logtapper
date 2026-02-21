use rhai::{Dynamic, Map as RhaiMap, Scope};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

use crate::core::line::LineContext;
use crate::processors::vars::{VarStore, dynamic_to_json};

// ---------------------------------------------------------------------------
// BridgeInput — all data available to a script
// ---------------------------------------------------------------------------

pub struct BridgeInput<'a> {
    pub line: &'a LineContext,
    pub fields: &'a HashMap<String, JsonValue>,
    pub vars: &'a VarStore,
    pub history: &'a [LineContext],
}

// ---------------------------------------------------------------------------
// Scope builder
// ---------------------------------------------------------------------------

/// Build a Rhai `Scope` with all the bindings described in the spec:
///
/// | Name    | Type            | Access     |
/// |---------|-----------------|------------|
/// | line    | map             | read-only  |
/// | fields  | map             | read-only  |
/// | vars    | map             | read/write |
/// | _emits  | array           | internal — scripts never touch this directly |
///
/// History is NOT materialized here. Scripts access history via the registered
/// `history_get(i)` and `history_len()` Rhai functions on `ScriptEngine`.
pub fn build_scope<'src>(input: &BridgeInput<'_>) -> Scope<'src> {
    let mut scope = Scope::new();

    // ── line ─────────────────────────────────────────────────────────────────
    let mut line_map = RhaiMap::new();
    line_map.insert("raw".into(), Dynamic::from(input.line.raw.clone()));
    line_map.insert("timestamp".into(), Dynamic::from(input.line.timestamp));
    line_map.insert("level".into(), Dynamic::from(input.line.level.to_string()));
    line_map.insert("tag".into(), Dynamic::from(input.line.tag.clone()));
    line_map.insert("pid".into(), Dynamic::from(input.line.pid as i64));
    line_map.insert("tid".into(), Dynamic::from(input.line.tid as i64));
    line_map.insert("message".into(), Dynamic::from(input.line.message.clone()));
    line_map.insert("source_id".into(), Dynamic::from(input.line.source_id.clone()));
    scope.push_constant("line", Dynamic::from(line_map));

    // ── fields ────────────────────────────────────────────────────────────────
    let mut fields_map = RhaiMap::new();
    for (k, v) in input.fields {
        fields_map.insert(k.as_str().into(), json_to_dynamic(v));
    }
    scope.push_constant("fields", Dynamic::from(fields_map));

    // ── vars (read/write) ─────────────────────────────────────────────────────
    scope.push("vars", input.vars.to_rhai_map());

    // ── history — accessed lazily via history_get(i) / history_len() ─────────
    // (No scope variable needed; the ScriptEngine has registered Rhai functions
    //  that read from a shared Arc<Mutex<Vec<LineContext>>> populated before
    //  each run_script() call.)

    // ── _emits — internal accumulator for emit() calls ────────────────────────
    scope.push("_emits", Dynamic::from(rhai::Array::new()));

    scope
}

// ---------------------------------------------------------------------------
// drain_emissions — extract pending emit() results from scope
// ---------------------------------------------------------------------------

/// After script execution, drain `_emits` from the scope and convert to JSON.
pub fn drain_emissions(scope: &mut Scope<'_>) -> Vec<Vec<(String, JsonValue)>> {
    let arr = scope
        .get_value::<rhai::Array>("_emits")
        .unwrap_or_default();

    arr.iter()
        .filter_map(|item| {
            item.read_lock::<RhaiMap>().map(|m| {
                m.iter()
                    .map(|(k, v)| (k.to_string(), dynamic_to_json(v)))
                    .collect()
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn json_to_dynamic(val: &JsonValue) -> Dynamic {
    match val {
        JsonValue::Null => Dynamic::UNIT,
        JsonValue::Bool(b) => Dynamic::from(*b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Dynamic::from(i)
            } else if let Some(f) = n.as_f64() {
                Dynamic::from(f)
            } else {
                Dynamic::UNIT
            }
        }
        JsonValue::String(s) => Dynamic::from(s.clone()),
        JsonValue::Array(arr) => {
            Dynamic::from(arr.iter().map(json_to_dynamic).collect::<rhai::Array>())
        }
        JsonValue::Object(map) => {
            let mut rmap = RhaiMap::new();
            for (k, v) in map {
                rmap.insert(k.as_str().into(), json_to_dynamic(v));
            }
            Dynamic::from(rmap)
        }
    }
}
