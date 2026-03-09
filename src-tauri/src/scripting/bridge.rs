use rhai::{Dynamic, Map as RhaiMap, Scope};
use serde_json::Value as JsonValue;

use crate::core::line::{LineContext, PipelineContext, section_for_line};
use crate::processors::vars::{VarStore, dynamic_to_json};

// ---------------------------------------------------------------------------
// BridgeInput — all data available to a script
// ---------------------------------------------------------------------------

pub struct BridgeInput<'a> {
    pub line: &'a LineContext,
    pub fields: &'a [(String, JsonValue)],
    pub vars: &'a VarStore,
    pub history: &'a [LineContext],
    pub pipeline_ctx: &'a PipelineContext,
}

// ---------------------------------------------------------------------------
// Scope builder — shared helpers
// ---------------------------------------------------------------------------

/// Build the `line` Rhai map from a BridgeInput. Used by both `build_scope`
/// and `update_scope` to avoid duplicating the 13-field construction.
fn build_line_map(input: &BridgeInput<'_>) -> RhaiMap {
    let mut m = RhaiMap::new();
    m.insert("raw".into(), Dynamic::from(input.line.raw.to_string()));
    m.insert("timestamp".into(), Dynamic::from(input.line.timestamp));
    m.insert("level".into(), Dynamic::from(input.line.level.to_string()));
    m.insert("tag".into(), Dynamic::from(input.line.tag.to_string()));
    m.insert("pid".into(), Dynamic::from(input.line.pid as i64));
    m.insert("tid".into(), Dynamic::from(input.line.tid as i64));
    m.insert("message".into(), Dynamic::from(input.line.message.to_string()));
    m.insert("source_id".into(), Dynamic::from(input.line.source_id.to_string()));
    m.insert("source_type".into(), Dynamic::from(input.pipeline_ctx.source_type.to_string()));
    m.insert("section".into(), Dynamic::from(section_for_line(&input.pipeline_ctx.sections, input.line.source_line_num).to_string()));
    m.insert("line_number".into(), Dynamic::from(input.line.source_line_num as i64));
    m.insert("is_streaming".into(), Dynamic::from(input.pipeline_ctx.is_streaming));
    m.insert("source_name".into(), Dynamic::from(input.pipeline_ctx.source_name.to_string()));
    m
}

/// Build the `fields` Rhai map from extracted field pairs.
fn build_fields_map(fields: &[(String, JsonValue)]) -> RhaiMap {
    let mut m = RhaiMap::new();
    for (k, v) in fields {
        m.insert(k.as_str().into(), json_to_dynamic(v));
    }
    m
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

    scope.push("line", Dynamic::from(build_line_map(input)));
    scope.push("fields", Dynamic::from(build_fields_map(input.fields)));
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
// update_scope — update an existing scope in-place for a new line
// ---------------------------------------------------------------------------

/// Update a persistent `Scope` for the next script invocation.
///
/// Only `line`, `fields`, and `_emits` are overwritten.  `vars` is left
/// untouched — it already contains the accumulated values from the previous
/// execution, which is the desired behavior for cross-line accumulation.
///
/// **Critical:** `_emits` MUST be reset to an empty array every invocation,
/// otherwise emissions from line N would be re-reported for line N+1.
pub fn update_scope(scope: &mut Scope<'_>, input: &BridgeInput<'_>) {
    scope.set_value("line", Dynamic::from(build_line_map(input)));
    scope.set_value("fields", Dynamic::from(build_fields_map(input.fields)));

    // ── _emits — MUST be cleared to prevent stale emission carry-over ──────
    scope.set_value("_emits", Dynamic::from(rhai::Array::new()));

    // `vars` is intentionally NOT updated — it persists from the previous execution.
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
