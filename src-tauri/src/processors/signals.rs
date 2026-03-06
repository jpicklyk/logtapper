//! Signal condition evaluator and template renderer for MCP insights.
//!
//! Signal conditions are simple field-comparison expressions like:
//!   `heap_pct >= 90`
//!   `heap_pct >= 80 && heap_pct < 90`
//!   `fd_count > 500`
//!
//! The evaluator parses a condition string into a minimal AST and evaluates
//! it against a map of field values (from a single emission or from vars).

use std::collections::HashMap;
use serde_json::Value;

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum CmpOp {
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
    Neq,
}

#[derive(Debug, Clone)]
pub enum Expr {
    Comparison {
        field: String,
        op: CmpOp,
        value: f64,
    },
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
}

// ---------------------------------------------------------------------------
// Parser — recursive descent over tokens
// ---------------------------------------------------------------------------

fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(&c) = chars.peek() {
        match c {
            ' ' | '\t' => { chars.next(); }
            '&' => {
                chars.next();
                if chars.peek() == Some(&'&') { chars.next(); }
                tokens.push("&&".to_string());
            }
            '|' => {
                chars.next();
                if chars.peek() == Some(&'|') { chars.next(); }
                tokens.push("||".to_string());
            }
            '>' => {
                chars.next();
                if chars.peek() == Some(&'=') { chars.next(); tokens.push(">=".to_string()); }
                else { tokens.push(">".to_string()); }
            }
            '<' => {
                chars.next();
                if chars.peek() == Some(&'=') { chars.next(); tokens.push("<=".to_string()); }
                else { tokens.push("<".to_string()); }
            }
            '!' => {
                chars.next();
                if chars.peek() == Some(&'=') { chars.next(); tokens.push("!=".to_string()); }
                else { tokens.push("!".to_string()); }
            }
            '=' => {
                chars.next();
                if chars.peek() == Some(&'=') { chars.next(); }
                tokens.push("==".to_string());
            }
            '(' => { chars.next(); tokens.push("(".to_string()); }
            ')' => { chars.next(); tokens.push(")".to_string()); }
            _ => {
                // Identifier or number
                let mut s = String::new();
                while let Some(&c2) = chars.peek() {
                    if c2.is_alphanumeric() || c2 == '_' || c2 == '.' || c2 == '-' {
                        s.push(c2);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if !s.is_empty() {
                    tokens.push(s);
                } else {
                    // Unknown char — skip
                    chars.next();
                }
            }
        }
    }
    tokens
}

struct Parser {
    tokens: Vec<String>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<String>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&str> {
        self.tokens.get(self.pos).map(|s| s.as_str())
    }

    fn consume(&mut self) -> Option<&str> {
        let t = self.tokens.get(self.pos).map(|s| s.as_str());
        if t.is_some() { self.pos += 1; }
        t
    }

    /// Parse OR-level expression (lowest precedence).
    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        while self.peek() == Some("||") {
            self.consume();
            let right = self.parse_and()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    /// Parse AND-level expression.
    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_primary()?;
        while self.peek() == Some("&&") {
            self.consume();
            let right = self.parse_primary()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    /// Parse a comparison or parenthesized expression.
    fn parse_primary(&mut self) -> Result<Expr, String> {
        if self.peek() == Some("(") {
            self.consume();
            let expr = self.parse_or()?;
            if self.peek() == Some(")") { self.consume(); }
            return Ok(expr);
        }

        // Expect: <field> <op> <number>
        let field = self.consume()
            .ok_or_else(|| "Expected field name".to_string())?
            .to_string();

        let op_str = self.consume()
            .ok_or_else(|| format!("Expected operator after '{field}'"))?;
        let op = match op_str {
            ">"  => CmpOp::Gt,
            ">=" => CmpOp::Gte,
            "<"  => CmpOp::Lt,
            "<=" => CmpOp::Lte,
            "==" => CmpOp::Eq,
            "!=" => CmpOp::Neq,
            other => return Err(format!("Unknown operator '{other}'")),
        };

        let num_str = self.consume()
            .ok_or_else(|| format!("Expected number after operator for '{field}'"))?;
        let value: f64 = num_str.parse()
            .map_err(|_| format!("Cannot parse '{num_str}' as a number"))?;

        Ok(Expr::Comparison { field, op, value })
    }
}

/// Parse a condition string into an `Expr` AST.
/// Returns `Ok(None)` if the condition string is empty (always true).
pub fn parse_condition(condition: &str) -> Result<Option<Expr>, String> {
    let trimmed = condition.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let tokens = tokenize(trimmed);
    if tokens.is_empty() {
        return Ok(None);
    }
    let mut parser = Parser::new(tokens);
    let expr = parser.parse_or()?;
    Ok(Some(expr))
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/// Evaluate an `Expr` against a field map.
/// Fields are looked up as JSON Values and coerced to f64.
/// Returns `true` if the expression holds.
pub fn evaluate(expr: &Expr, fields: &HashMap<String, Value>) -> bool {
    match expr {
        Expr::Comparison { field, op, value } => {
            let field_val = match fields.get(field) {
                Some(v) => json_to_f64(v),
                None => return false, // missing field — condition fails
            };
            match op {
                CmpOp::Gt  => field_val > *value,
                CmpOp::Gte => field_val >= *value,
                CmpOp::Lt  => field_val < *value,
                CmpOp::Lte => field_val <= *value,
                CmpOp::Eq  => (field_val - value).abs() < f64::EPSILON,
                CmpOp::Neq => (field_val - value).abs() >= f64::EPSILON,
            }
        }
        Expr::And(left, right) => evaluate(left, fields) && evaluate(right, fields),
        Expr::Or(left, right)  => evaluate(left, fields) || evaluate(right, fields),
    }
}

fn json_to_f64(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::Bool(b)   => if *b { 1.0 } else { 0.0 },
        Value::String(s) => s.parse().unwrap_or(0.0),
        _                => 0.0,
    }
}

/// Convenience: parse and evaluate a condition string against a field map.
/// An empty/None condition is always true.
pub fn eval_condition(
    condition: Option<&str>,
    fields: &HashMap<String, Value>,
) -> bool {
    let cond = match condition {
        None | Some("") => return true,
        Some(c) => c,
    };
    match parse_condition(cond) {
        Ok(None) => true,
        Ok(Some(expr)) => evaluate(&expr, fields),
        Err(_) => false, // malformed condition — never matches
    }
}

/// Evaluate a pre-parsed `Expr` against a field map.
/// If `parsed` is `None` (no condition was defined), always returns `true`.
pub fn eval_parsed_condition(parsed: Option<&Expr>, fields: &HashMap<String, Value>) -> bool {
    match parsed {
        Some(expr) => evaluate(expr, fields),
        None => true,
    }
}

// ---------------------------------------------------------------------------
// Template renderer
// ---------------------------------------------------------------------------

/// Render a `{{var_name}}` Mustache-style template.
/// Missing keys become `"<unknown>"`.
pub fn render_template(template: &str, vars: &HashMap<String, Value>) -> String {
    let mut result = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' && chars.peek() == Some(&'{') {
            chars.next(); // consume second '{'
            let mut key = String::new();
            loop {
                match chars.next() {
                    None => break,
                    Some('}') if chars.peek() == Some(&'}') => {
                        chars.next(); // consume second '}'
                        break;
                    }
                    Some(k) => key.push(k),
                }
            }
            let key = key.trim();
            let replacement = vars.get(key).map(value_to_display).unwrap_or_else(|| "<unknown>".to_string());
            result.push_str(&replacement);
        } else {
            result.push(c);
        }
    }
    result
}

fn value_to_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b)   => b.to_string(),
        Value::Null      => "null".to_string(),
        other            => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    // --- Condition parsing and evaluation ---

    #[test]
    fn simple_gt() {
        let f = fields(&[("heap_pct", json!(95))]);
        assert!(eval_condition(Some("heap_pct >= 90"), &f));
        assert!(!eval_condition(Some("heap_pct >= 90"), &fields(&[("heap_pct", json!(80))])));
    }

    #[test]
    fn simple_lt() {
        let f = fields(&[("fd_count", json!(300))]);
        assert!(eval_condition(Some("fd_count < 500"), &f));
        assert!(!eval_condition(Some("fd_count > 500"), &f));
    }

    #[test]
    fn and_expression() {
        let f = fields(&[("heap_pct", json!(85))]);
        assert!(eval_condition(Some("heap_pct >= 80 && heap_pct < 90"), &f));
        assert!(!eval_condition(Some("heap_pct >= 90 && heap_pct < 95"), &f));
    }

    #[test]
    fn or_expression() {
        let f = fields(&[("heap_pct", json!(95))]);
        assert!(eval_condition(Some("heap_pct > 90 || heap_pct < 50"), &f));
        assert!(!eval_condition(Some("heap_pct > 96 || heap_pct < 50"), &f));
    }

    #[test]
    fn eq_neq() {
        let f = fields(&[("status", json!(1))]);
        assert!(eval_condition(Some("status == 1"), &f));
        assert!(eval_condition(Some("status != 0"), &f));
        assert!(!eval_condition(Some("status == 0"), &f));
    }

    #[test]
    fn empty_condition_always_true() {
        let f = fields(&[]);
        assert!(eval_condition(None, &f));
        assert!(eval_condition(Some(""), &f));
    }

    #[test]
    fn missing_field_returns_false() {
        let f = fields(&[]);
        assert!(!eval_condition(Some("heap_pct >= 90"), &f));
    }

    #[test]
    fn float_field() {
        let f = fields(&[("ratio", json!(0.95))]);
        assert!(eval_condition(Some("ratio >= 0.9"), &f));
        assert!(!eval_condition(Some("ratio >= 1.0"), &f));
    }

    #[test]
    fn string_field_numeric_coercion() {
        let f = fields(&[("heap_pct", json!("85"))]);
        assert!(eval_condition(Some("heap_pct >= 80"), &f));
    }

    // --- Template rendering ---

    #[test]
    fn render_simple_vars() {
        let vars: HashMap<String, Value> = [
            ("count".to_string(), json!(42)),
            ("peak".to_string(), json!(97)),
        ].into_iter().collect();
        let result = render_template("{{count}} samples. Peak: {{peak}}%.", &vars);
        assert_eq!(result, "42 samples. Peak: 97%.");
    }

    #[test]
    fn render_missing_key_becomes_unknown() {
        let vars: HashMap<String, Value> = HashMap::new();
        let result = render_template("Hello {{name}}!", &vars);
        assert_eq!(result, "Hello <unknown>!");
    }

    #[test]
    fn render_no_placeholders() {
        let vars: HashMap<String, Value> = HashMap::new();
        let result = render_template("No placeholders here.", &vars);
        assert_eq!(result, "No placeholders here.");
    }

    #[test]
    fn render_string_value() {
        let vars: HashMap<String, Value> = [
            ("device".to_string(), json!("Pixel 8")),
        ].into_iter().collect();
        let result = render_template("Device: {{device}}", &vars);
        assert_eq!(result, "Device: Pixel 8");
    }
}
