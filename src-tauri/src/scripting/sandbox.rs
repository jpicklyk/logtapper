use rhai::Engine;

// ---------------------------------------------------------------------------
// Script validation
// ---------------------------------------------------------------------------

/// Validates a Rhai script without executing it.
/// Returns `Ok(())` or an error message with position information.
pub fn validate_script(src: &str) -> Result<(), String> {
    let engine = make_validation_engine();
    engine.compile(src).map(|_| ()).map_err(|e| e.to_string())
}

/// Estimate script "complexity" by counting AST nodes.
/// Rejects scripts that are likely to be excessively complex.
pub fn check_complexity(src: &str, max_nodes: usize) -> Result<(), String> {
    let engine = make_validation_engine();
    let ast = engine.compile(src).map_err(|e| e.to_string())?;
    // Approximate node count via debug representation length — a rough proxy.
    let approx = format!("{ast:?}").len();
    if approx > max_nodes * 100 {
        return Err(format!(
            "Script exceeds complexity limit (approx {approx} nodes, max {max_nodes})"
        ));
    }
    Ok(())
}

fn make_validation_engine() -> Engine {
    let mut engine = Engine::new();
    engine.set_max_operations(1_000_000);
    engine.set_max_string_size(50_000);
    engine.set_max_array_size(100_000);
    engine.set_max_map_size(10_000);
    engine.set_max_call_levels(32);
    engine
}

// ---------------------------------------------------------------------------
// Install-time checks (used by registry)
// ---------------------------------------------------------------------------

/// Full install-time check: validate syntax + complexity.
pub fn validate_for_install(src: &str) -> Result<(), String> {
    validate_script(src)?;
    check_complexity(src, 5_000)?;
    Ok(())
}

/// Validate a Rhai expression (e.g. correlator `condition` fields).
/// Expressions are single-line boolean tests like `fd_count > 900`.
/// Returns the raw Rhai error string on failure — callers add context.
pub fn validate_expression(src: &str) -> Result<(), String> {
    let engine = make_validation_engine();
    engine
        .compile_expression(src)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_script() {
        let src = r#"
            vars.count += 1;
            if line.message.contains("error") {
                emit(#{ msg: line.message });
            }
        "#;
        assert!(validate_script(src).is_ok());
    }

    #[test]
    fn rejects_syntax_error() {
        let src = "let x = ;;;";
        assert!(validate_script(src).is_err());
    }
}
