use std::collections::HashMap;
use serde_json::Value as JsonValue;

// ---------------------------------------------------------------------------
// Time bucket aggregation
// ---------------------------------------------------------------------------

/// Convert an interval string like "5m", "30s", "1h" to nanoseconds.
pub fn parse_interval_ns(interval: &str) -> i64 {
    let split_pos = interval
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(interval.len());
    let (num_str, unit) = interval.split_at(split_pos);
    let num: i64 = num_str.parse().unwrap_or(1);
    let ns_per_unit = match unit.trim().to_lowercase().as_str() {
        "ns" => 1,
        "us" | "µs" => 1_000,
        "ms" => 1_000_000,
        "m" | "min" => 60 * 1_000_000_000,
        "h" | "hr" | "hour" => 3_600 * 1_000_000_000_i64,
        _ => 1_000_000_000, // includes "s" | "sec"
    };
    num * ns_per_unit
}

/// Snap a timestamp to the nearest interval bucket (floor).
pub fn bucket_of(timestamp_ns: i64, interval_ns: i64) -> i64 {
    if interval_ns <= 0 { return 0; }
    timestamp_ns / interval_ns * interval_ns
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/// Count emissions grouped by a string field value.
pub fn count_by_field(
    emissions: &[HashMap<String, JsonValue>],
    field: &str,
) -> Vec<(String, usize)> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for e in emissions {
        if let Some(v) = e.get(field) {
            let key = match v {
                JsonValue::String(s) => s.clone(),
                other => other.to_string(),
            };
            *counts.entry(key).or_insert(0) += 1;
        }
    }
    let mut result: Vec<(String, usize)> = counts.into_iter().collect();
    result.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    result
}

/// Count emissions bucketed by timestamp field.
pub fn count_by_time(
    emissions: &[HashMap<String, JsonValue>],
    time_field: &str,
    interval: &str,
) -> Vec<(i64, usize)> {
    let interval_ns = parse_interval_ns(interval);
    let mut buckets: HashMap<i64, usize> = HashMap::new();
    for e in emissions {
        if let Some(ts) = json_as_i64(e.get(time_field)) {
            *buckets.entry(bucket_of(ts, interval_ns)).or_insert(0) += 1;
        }
    }
    let mut result: Vec<(i64, usize)> = buckets.into_iter().collect();
    result.sort_by_key(|(b, _)| *b);
    result
}

/// Count emissions bucketed by time, grouped by a second field.
pub fn count_by_time_grouped(
    emissions: &[HashMap<String, JsonValue>],
    time_field: &str,
    group_field: &str,
    interval: &str,
) -> HashMap<String, Vec<(i64, usize)>> {
    let interval_ns = parse_interval_ns(interval);
    let mut groups: HashMap<String, HashMap<i64, usize>> = HashMap::new();
    for e in emissions {
        let Some(ts) = json_as_i64(e.get(time_field)) else { continue };
        let group = match e.get(group_field) {
            Some(JsonValue::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => continue,
        };
        *groups.entry(group).or_default()
            .entry(bucket_of(ts, interval_ns)).or_insert(0) += 1;
    }
    groups
        .into_iter()
        .map(|(g, b)| {
            let mut pts: Vec<(i64, usize)> = b.into_iter().collect();
            pts.sort_by_key(|(b, _)| *b);
            (g, pts)
        })
        .collect()
}

/// Statistics over a numeric field: (min, max, mean, count).
pub fn stats_field(
    emissions: &[HashMap<String, JsonValue>],
    field: &str,
) -> Option<(f64, f64, f64, usize)> {
    let vals: Vec<f64> = emissions
        .iter()
        .filter_map(|e| json_as_f64(e.get(field)))
        .collect();
    if vals.is_empty() { return None; }
    let min = vals.iter().copied().fold(f64::INFINITY, f64::min);
    let max = vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mean = vals.iter().sum::<f64>() / vals.len() as f64;
    Some((min, max, mean, vals.len()))
}

// ---------------------------------------------------------------------------
// JSON helpers (pub so builder.rs can use them)
// ---------------------------------------------------------------------------

pub fn json_as_f64(v: Option<&JsonValue>) -> Option<f64> {
    match v? {
        JsonValue::Number(n) => n.as_f64(),
        JsonValue::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub fn json_as_i64(v: Option<&JsonValue>) -> Option<i64> {
    match v? {
        JsonValue::Number(n) => n.as_i64(),
        JsonValue::String(s) => s.parse().ok(),
        _ => None,
    }
}
