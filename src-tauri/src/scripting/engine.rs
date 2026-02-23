use rhai::{Dynamic, Engine, Map as RhaiMap, OptimizationLevel, Scope, AST};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::core::line::LineContext;
use super::bridge::BridgeInput;

/// Emission fields as returned by script execution (Vec of key-value pairs).
pub type EmissionFields = Vec<(String, serde_json::Value)>;

// ---------------------------------------------------------------------------
// ScriptEngine
// ---------------------------------------------------------------------------

/// Wraps a Rhai `Engine` configured with safety limits and an AST cache.
/// One instance lives for the duration of a processor run.
///
/// History access is lazy: instead of materializing the full history buffer
/// into a Rhai array on every script invocation (~300KB per call), scripts
/// call `history_get(i)` and `history_len()` which read from a shared
/// `Arc<Mutex<Vec<LineContext>>>` populated before each `run_script()` call.
pub struct ScriptEngine {
    engine: Engine,
    ast_cache: Mutex<HashMap<String, AST>>,
    /// Shared history buffer swapped in before each `run_script()` call.
    /// Registered Rhai functions `history_get(i)` and `history_len()` read from this.
    shared_history: Arc<Mutex<Vec<LineContext>>>,
    /// Persistent scope reused across `run_script()` calls.
    /// On the first call, built from scratch via `build_scope()` and stored here.
    /// On subsequent calls, only `line`, `fields`, and `_emits` are updated in-place;
    /// `vars` persists from the previous execution (accumulates across lines).
    scope: Option<Scope<'static>>,
}

impl ScriptEngine {
    pub fn new() -> Self {
        let shared_history: Arc<Mutex<Vec<LineContext>>> = Arc::new(Mutex::new(Vec::new()));
        let mut engine = Engine::new();

        // Safety limits (per spec)
        engine.set_max_operations(1_000_000);
        engine.set_max_string_size(50_000);
        engine.set_max_array_size(100_000);
        engine.set_max_map_size(10_000);
        engine.set_max_call_levels(32);
        engine.set_optimization_level(OptimizationLevel::Simple);

        // Register lazy history access functions.
        // Scripts call history_get(i) to fetch a single entry on demand,
        // and history_len() to get the buffer size, instead of the old
        // `history` array variable that cloned all entries into scope.
        let hist_ref = Arc::clone(&shared_history);
        engine.register_fn("history_get", move |idx: i64| -> Dynamic {
            let history = hist_ref.lock().unwrap();
            match history.get(idx as usize) {
                Some(lc) => {
                    let mut m = RhaiMap::new();
                    m.insert("timestamp".into(), Dynamic::from(lc.timestamp));
                    m.insert("level".into(), Dynamic::from(lc.level.to_string()));
                    m.insert("tag".into(), Dynamic::from(lc.tag.to_string()));
                    m.insert("message".into(), Dynamic::from(lc.message.to_string()));
                    m.insert("pid".into(), Dynamic::from(lc.pid as i64));
                    m.insert("tid".into(), Dynamic::from(lc.tid as i64));
                    Dynamic::from(m)
                }
                None => Dynamic::UNIT,
            }
        });

        let hist_ref2 = Arc::clone(&shared_history);
        engine.register_fn("history_len", move || -> i64 {
            hist_ref2.lock().unwrap().len() as i64
        });

        Self {
            engine,
            ast_cache: Mutex::new(HashMap::new()),
            shared_history,
            scope: None,
        }
    }

    /// Compile a script (or return cached AST).
    fn compile(&self, src: &str) -> Result<AST, String> {
        let mut cache = self.ast_cache.lock().unwrap();
        if let Some(ast) = cache.get(src) {
            return Ok(ast.clone());
        }
        let ast = self.engine.compile(src).map_err(|e| e.to_string())?;
        cache.insert(src.to_string(), ast.clone());
        Ok(ast)
    }

    /// Execute a script against the given bridge input.
    ///
    /// Returns `(updated_vars_map, new_emissions)`.
    ///
    /// On the first call the full scope is built from `input` (including `vars`
    /// seeded from `VarStore`).  On subsequent calls only `line`, `fields`, and
    /// `_emits` are overwritten; `vars` persists in the scope from the previous
    /// execution so accumulations carry across lines without an extra
    /// build→serialize→deserialize round-trip.
    pub fn run_script(
        &mut self,
        src: &str,
        input: &BridgeInput<'_>,
    ) -> Result<(Dynamic, Vec<EmissionFields>), String> {
        use crate::scripting::bridge::{build_scope, update_scope, drain_emissions};

        let ast = self.compile(src)?;

        // Populate shared_history for this invocation so history_get()/history_len() work.
        {
            let mut h = self.shared_history.lock().unwrap();
            h.clear();
            h.extend_from_slice(input.history);
        }

        // Reuse the persistent scope if available; otherwise build from scratch.
        let scope = match self.scope.as_mut() {
            Some(scope) => {
                update_scope(scope, input);
                scope
            }
            None => {
                self.scope = Some(build_scope(input));
                self.scope.as_mut().unwrap()
            }
        };

        self.engine
            .run_ast_with_scope(scope, &ast)
            .map_err(|e| e.to_string())?;

        let updated_vars = scope
            .get_value::<Dynamic>("vars")
            .unwrap_or(Dynamic::UNIT);

        let emissions = drain_emissions(scope);

        Ok((updated_vars, emissions))
    }
}

impl Default for ScriptEngine {
    fn default() -> Self {
        Self::new()
    }
}
