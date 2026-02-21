use rhai::{Dynamic, Engine, Map as RhaiMap, OptimizationLevel, AST};
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
                    m.insert("tag".into(), Dynamic::from(lc.tag.clone()));
                    m.insert("message".into(), Dynamic::from(lc.message.clone()));
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
    pub fn run_script(
        &self,
        src: &str,
        input: &BridgeInput<'_>,
    ) -> Result<(Dynamic, Vec<EmissionFields>), String> {
        use crate::scripting::bridge::{build_scope, drain_emissions};

        let ast = self.compile(src)?;
        let mut scope = build_scope(input);

        // Populate shared_history for this invocation so history_get()/history_len() work.
        {
            let mut h = self.shared_history.lock().unwrap();
            h.clear();
            h.extend_from_slice(input.history);
        }

        self.engine
            .run_ast_with_scope(&mut scope, &ast)
            .map_err(|e| e.to_string())?;

        let updated_vars = scope
            .get_value::<Dynamic>("vars")
            .unwrap_or(Dynamic::UNIT);

        let emissions = drain_emissions(&mut scope);

        Ok((updated_vars, emissions))
    }
}

impl Default for ScriptEngine {
    fn default() -> Self {
        Self::new()
    }
}
