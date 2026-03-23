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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::reporter::schema::{VarDecl, VarType};

    fn int_var(name: &str) -> VarDecl {
        VarDecl { name: name.to_string(), var_type: VarType::Int, default: None, display: false, label: None, display_as: None, columns: vec![], configurable: false, min: None, max: None }
    }
    fn float_var(name: &str) -> VarDecl {
        VarDecl { name: name.to_string(), var_type: VarType::Float, default: None, display: false, label: None, display_as: None, columns: vec![], configurable: false, min: None, max: None }
    }
    fn string_var(name: &str) -> VarDecl {
        VarDecl { name: name.to_string(), var_type: VarType::String, default: None, display: false, label: None, display_as: None, columns: vec![], configurable: false, min: None, max: None }
    }
    fn bool_var(name: &str) -> VarDecl {
        VarDecl { name: name.to_string(), var_type: VarType::Bool, default: None, display: false, label: None, display_as: None, columns: vec![], configurable: false, min: None, max: None }
    }
    fn map_var(name: &str) -> VarDecl {
        VarDecl { name: name.to_string(), var_type: VarType::Map, default: None, display: false, label: None, display_as: None, columns: vec![], configurable: false, min: None, max: None }
    }
    fn list_var(name: &str) -> VarDecl {
        VarDecl { name: name.to_string(), var_type: VarType::List, default: None, display: false, label: None, display_as: None, columns: vec![], configurable: false, min: None, max: None }
    }

    #[test]
    fn new_initializes_defaults_by_type() {
        let decls = vec![
            int_var("i"),
            float_var("f"),
            bool_var("b"),
            string_var("s"),
            map_var("m"),
            list_var("l"),
        ];
        let store = VarStore::new(&decls);
        assert_eq!(store.get("i").unwrap().as_int().unwrap(), 0i64);
        assert_eq!(store.get("f").unwrap().as_float().unwrap(), 0.0f64);
        assert!(!store.get("b").unwrap().as_bool().unwrap());
        assert_eq!(store.get("s").unwrap().clone().into_string().unwrap(), "");
        // map and list are non-null Dynamic values
        assert!(store.get("m").is_some());
        assert!(store.get("l").is_some());
    }

    #[test]
    fn new_applies_yaml_default() {
        let mut decl = int_var("count");
        decl.default = Some(serde_yaml::Value::Number(serde_yaml::Number::from(42i64)));
        let store = VarStore::new(&[decl]);
        assert_eq!(store.get("count").unwrap().as_int().unwrap(), 42i64);
    }

    #[test]
    fn get_returns_none_for_unknown() {
        let store = VarStore::new(&[int_var("x")]);
        assert!(store.get("nonexistent").is_none());
    }

    #[test]
    fn set_updates_known_var() {
        let mut store = VarStore::new(&[int_var("x")]);
        store.set("x", Dynamic::from(99i64));
        assert_eq!(store.get("x").unwrap().as_int().unwrap(), 99i64);
    }

    #[test]
    fn set_ignores_unknown_var() {
        let mut store = VarStore::new(&[int_var("x")]);
        // Should not panic, and should not add new key
        store.set("unknown", Dynamic::from(1i64));
        assert!(store.get("unknown").is_none());
    }

    #[test]
    fn to_json_int() {
        let store = VarStore::new(&[int_var("n")]);
        let json = store.to_json();
        assert_eq!(json["n"], serde_json::json!(0i64));
    }

    #[test]
    fn to_json_string() {
        let mut decl = string_var("msg");
        decl.default = Some(serde_yaml::Value::String("hello".to_string()));
        let store = VarStore::new(&[decl]);
        let json = store.to_json();
        assert_eq!(json["msg"], serde_json::json!("hello"));
    }

    #[test]
    fn to_json_map() {
        let store = VarStore::new(&[map_var("m")]);
        let json = store.to_json();
        // An empty map should serialize as an empty JSON object
        assert_eq!(json["m"], serde_json::json!({}));
    }

    #[test]
    fn to_json_bool() {
        let mut decl = bool_var("flag");
        decl.default = Some(serde_yaml::Value::Bool(true));
        let store = VarStore::new(&[decl]);
        let json = store.to_json();
        assert_eq!(json["flag"], serde_json::json!(true));
    }

    #[test]
    fn dynamic_to_json_handles_nested_array() {
        let arr: rhai::Array = vec![
            Dynamic::from(1i64),
            Dynamic::from(2i64),
            Dynamic::from(3i64),
        ];
        let val = Dynamic::from(arr);
        let json = dynamic_to_json(&val);
        assert_eq!(json, serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn dynamic_to_json_handles_nan() {
        let val = Dynamic::from(f64::NAN);
        let json = dynamic_to_json(&val);
        assert_eq!(json, serde_json::Value::Null);
    }

    #[test]
    fn to_rhai_map_and_update_roundtrip() {
        let mut store = VarStore::new(&[int_var("score")]);
        assert_eq!(store.get("score").unwrap().as_int().unwrap(), 0i64);

        // Simulate what Rhai script does: mutate the map and write back
        let mut rhai_map = store.to_rhai_map();
        {
            let map = rhai_map.write_lock::<rhai::Map>().unwrap();
            // We'll rebuild via update_from_rhai after
            drop(map);
        }
        // Build a new map with modified value to simulate script setting vars.score = 7
        let mut new_map = rhai::Map::new();
        new_map.insert("score".into(), Dynamic::from(7i64));
        let new_rhai = Dynamic::from(new_map);
        store.update_from_rhai(&new_rhai);
        assert_eq!(store.get("score").unwrap().as_int().unwrap(), 7i64);
    }

    #[test]
    fn update_from_rhai_ignores_unknown_keys() {
        let mut store = VarStore::new(&[int_var("x")]);
        let mut map = rhai::Map::new();
        map.insert("x".into(), Dynamic::from(5i64));
        map.insert("new_key".into(), Dynamic::from(99i64)); // not declared
        let rhai_val = Dynamic::from(map);
        store.update_from_rhai(&rhai_val);
        assert_eq!(store.get("x").unwrap().as_int().unwrap(), 5i64);
        assert!(store.get("new_key").is_none());
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
