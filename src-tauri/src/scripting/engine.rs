use rhai::{Dynamic, Engine, OptimizationLevel, AST};
use std::collections::HashMap;
use std::sync::Mutex;

use super::bridge::BridgeInput;

// ---------------------------------------------------------------------------
// ScriptEngine
// ---------------------------------------------------------------------------

/// Wraps a Rhai `Engine` configured with safety limits and an AST cache.
/// One instance lives for the duration of a processor run.
pub struct ScriptEngine {
    engine: Engine,
    ast_cache: Mutex<HashMap<String, AST>>,
}

impl ScriptEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // Safety limits (per spec)
        engine.set_max_operations(1_000_000);
        engine.set_max_string_size(50_000);
        engine.set_max_array_size(100_000);
        engine.set_max_map_size(10_000);
        engine.set_max_call_levels(32);
        engine.set_optimization_level(OptimizationLevel::Simple);

        // Register emit and emit_chart as no-ops here; the bridge overrides them
        // by using scope variables that the script writes to.

        Self {
            engine,
            ast_cache: Mutex::new(HashMap::new()),
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
    ) -> Result<(Dynamic, Vec<HashMap<String, serde_json::Value>>), String> {
        use crate::scripting::bridge::{build_scope, drain_emissions};

        let ast = self.compile(src)?;
        let mut scope = build_scope(input);

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
