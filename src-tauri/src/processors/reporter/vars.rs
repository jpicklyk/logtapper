use std::collections::HashMap;
use rhai::{Dynamic, Map as RhaiMap, Array as RhaiArray};
use serde_json::Value as JsonValue;

use super::schema::{VarDecl, VarType};

// ---------------------------------------------------------------------------
// VarStore — runtime variable state for one processor run
// ---------------------------------------------------------------------------

/// Holds the current value of every declared variable for a single processor run.
/// Values are stored as `rhai::Dynamic` so they can be passed directly into
/// Rhai scopes with zero copies.
#[derive(Clone)]
pub struct VarStore {
    decls: Vec<VarDecl>,
    values: HashMap<String, Dynamic>,
}

impl VarStore {
    /// Initialize from a set of variable declarations, applying defaults.
    pub fn new(decls: &[VarDecl]) -> Self {
        let mut values = HashMap::with_capacity(decls.len());
        for d in decls {
            values.insert(d.name.clone(), default_value(d));
        }
        Self {
            decls: decls.to_vec(),
            values,
        }
    }

    /// Read the current value of a variable.
    pub fn get(&self, name: &str) -> Option<&Dynamic> {
        self.values.get(name)
    }

    /// Write a variable back (after Rhai script execution).
    pub fn set(&mut self, name: &str, value: Dynamic) {
        if self.values.contains_key(name) {
            self.values.insert(name.to_string(), value);
        }
    }

    /// Build a Rhai `Dynamic::Map` containing all current values.
    /// The script sees this as a read/write `vars` object.
    pub fn to_rhai_map(&self) -> Dynamic {
        let mut map = RhaiMap::new();
        for (k, v) in &self.values {
            map.insert(k.as_str().into(), v.clone());
        }
        Dynamic::from(map)
    }

    /// Merge updates back from the Rhai `vars` map after script execution.
    pub fn update_from_rhai(&mut self, rhai_vars: &Dynamic) {
        if let Some(map) = rhai_vars.read_lock::<RhaiMap>() {
            for (k, v) in map.iter() {
                let key = k.as_str();
                if self.values.contains_key(key) {
                    self.values.insert(key.to_string(), v.clone());
                }
            }
        }
    }

    /// Serialize current state to JSON for IPC transport.
    pub fn to_json(&self) -> HashMap<String, JsonValue> {
        self.values
            .iter()
            .map(|(k, v)| (k.clone(), dynamic_to_json(v)))
            .collect()
    }

    pub fn decls(&self) -> &[VarDecl] {
        &self.decls
    }
}

// ---------------------------------------------------------------------------
// Default value construction
// ---------------------------------------------------------------------------

fn default_value(decl: &VarDecl) -> Dynamic {
    // Try to use the declared default first.
    if let Some(yaml_val) = &decl.default {
        if let Some(dyn_val) = yaml_to_dynamic(yaml_val) {
            return dyn_val;
        }
    }

    // Fall back to zero-value for the type.
    match decl.var_type {
        VarType::Int => Dynamic::from(0i64),
        VarType::Float => Dynamic::from(0.0f64),
        VarType::Bool => Dynamic::from(false),
        VarType::String => Dynamic::from(""),
        VarType::Map => Dynamic::from(RhaiMap::new()),
        VarType::List => Dynamic::from(RhaiArray::new()),
    }
}

fn yaml_to_dynamic(val: &serde_yaml::Value) -> Option<Dynamic> {
    use serde_yaml::Value as Y;
    Some(match val {
        Y::Null => Dynamic::UNIT,
        Y::Bool(b) => Dynamic::from(*b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                Dynamic::from(i)
            } else if let Some(f) = n.as_f64() {
                Dynamic::from(f)
            } else {
                return None;
            }
        }
        Y::String(s) => Dynamic::from(s.clone()),
        Y::Sequence(seq) => {
            let arr: RhaiArray = seq
                .iter()
                .filter_map(yaml_to_dynamic)
                .collect();
            Dynamic::from(arr)
        }
        Y::Mapping(map) => {
            let mut rmap = RhaiMap::new();
            for (k, v) in map {
                if let (Y::String(key), Some(dv)) = (k, yaml_to_dynamic(v)) {
                    rmap.insert(key.as_str().into(), dv);
                }
            }
            Dynamic::from(rmap)
        }
        Y::Tagged(_) => return None,
    })
}

// ---------------------------------------------------------------------------
// Dynamic → JSON for IPC
// ---------------------------------------------------------------------------

pub fn dynamic_to_json(val: &Dynamic) -> JsonValue {
    if val.is_unit() {
        JsonValue::Null
    } else if let Ok(b) = val.as_bool() {
        JsonValue::Bool(b)
    } else if let Ok(i) = val.as_int() {
        JsonValue::Number(i.into())
    } else if let Ok(f) = val.as_float() {
        if let Some(n) = serde_json::Number::from_f64(f) {
            JsonValue::Number(n)
        } else {
            JsonValue::Null
        }
    } else if let Ok(s) = val.clone().into_string() {
        JsonValue::String(s)
    } else if let Some(arr) = val.read_lock::<RhaiArray>() {
        JsonValue::Array(arr.iter().map(dynamic_to_json).collect())
    } else if let Some(map) = val.read_lock::<RhaiMap>() {
        let obj: serde_json::Map<_, _> = map
            .iter()
            .map(|(k, v)| (k.to_string(), dynamic_to_json(v)))
            .collect();
        JsonValue::Object(obj)
    } else {
        JsonValue::String(val.to_string())
    }
}
