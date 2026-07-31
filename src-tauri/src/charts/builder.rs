use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use serde_json::Value as JsonValue;

use crate::processors::interpreter::Emission;
use crate::processors::schema::{ChartSpec, PipelineStage, ProcessorDef};
use super::aggregation::{
    count_by_field, count_by_time, count_by_time_grouped, json_as_f64,
};

// ---------------------------------------------------------------------------
// Chart data model (IPC-crossing)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPoint {
    pub x: f64,
    pub y: f64,
    pub label: Option<String>,
    pub timeline_pos: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSeries {
    pub label: String,
    pub color: Option<String>,
    pub points: Vec<DataPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisConfig {
    pub label: String,
    pub field: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    pub id: String,
    pub chart_type: String,
    pub title: String,
    pub description: Option<String>,
    pub series: Vec<DataSeries>,
    pub x_axis: AxisConfig,
    pub y_axis: AxisConfig,
    pub interactive: bool,
}

// ---------------------------------------------------------------------------
// ChartBuilder
// ---------------------------------------------------------------------------

/// Compute all ChartData items declared in a processor's output stage.
pub fn build_charts(
    def: &ProcessorDef,
    emissions: &[Emission],
    vars: &HashMap<String, JsonValue>,
) -> Vec<ChartData> {
    // Find the output stage
    let output = def.pipeline.iter().find_map(|s| {
        if let PipelineStage::Output(o) = s { Some(o) } else { None }
    });

    let Some(output) = output else {
        return vec![];
    };

    output
        .charts
        .iter()
        .map(|spec| build_chart(spec, emissions, vars))
        .collect()
}

fn build_chart(
    spec: &ChartSpec,
    emissions: &[Emission],
    _vars: &HashMap<String, JsonValue>,
) -> ChartData {
    let emission_maps: Vec<HashMap<String, JsonValue>> =
        emissions.iter().map(|e| e.fields.iter().cloned().collect()).collect();
    let emission_refs: Vec<&HashMap<String, JsonValue>> =
        emission_maps.iter().collect();

    let series = match spec.chart_type.as_str() {
        "bar" | "pie" => build_bar_series(spec, &emission_refs),
        "time_series" | "area" => build_time_series(spec, &emission_refs),
        "scatter" => build_scatter_series(spec, &emission_refs),
        "histogram" => build_histogram_series(spec, &emission_refs),
        _ => vec![],
    };

    let x_label = spec
        .x
        .as_ref()
        .and_then(|x| x.label.clone())
        .or_else(|| spec.x.as_ref().and_then(|x| x.field.clone()))
        .unwrap_or_default();

    let y_label = spec
        .y
        .as_ref()
        .and_then(|y| y.label.clone())
        .or_else(|| spec.y.as_ref().and_then(|y| y.aggregation.clone()))
        .unwrap_or_default();

    ChartData {
        id: spec.id.clone(),
        chart_type: spec.chart_type.clone(),
        title: spec.title.clone(),
        description: spec.description.clone(),
        series,
        x_axis: AxisConfig { label: x_label, field: spec.x.as_ref().and_then(|x| x.field.clone()) },
        y_axis: AxisConfig { label: y_label, field: None },
        interactive: spec.interactive,
    }
}

// ---------------------------------------------------------------------------
// Bar / Pie
// ---------------------------------------------------------------------------

fn build_bar_series(
    spec: &ChartSpec,
    emissions: &[&HashMap<String, JsonValue>],
) -> Vec<DataSeries> {
    let Some(x_field) = spec.x.as_ref().and_then(|x| x.field.as_deref()) else {
        return vec![];
    };

    let owned: Vec<HashMap<String, JsonValue>> = emissions.iter().map(|&m| m.clone()).collect();
    let counts = count_by_field(&owned, x_field);

    let points: Vec<DataPoint> = counts
        .into_iter()
        .enumerate()
        .map(|(i, (label, count))| DataPoint {
            x: i as f64,
            y: count as f64,
            label: Some(label),
            timeline_pos: None,
        })
        .collect();

    vec![DataSeries {
        label: "count".to_string(),
        color: None,
        points,
    }]
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

fn build_time_series(
    spec: &ChartSpec,
    emissions: &[&HashMap<String, JsonValue>],
) -> Vec<DataSeries> {
    let Some(x_spec) = &spec.x else {
        return vec![];
    };
    let Some(time_field) = x_spec.field.as_deref() else {
        return vec![];
    };
    let interval = x_spec.bucket.as_deref().unwrap_or("1m");

    let owned: Vec<HashMap<String, JsonValue>> = emissions.iter().map(|&m| m.clone()).collect();

    if let Some(group_field) = &spec.group_by {
        let grouped = count_by_time_grouped(&owned, time_field, group_field, interval);
        grouped
            .into_iter()
            .map(|(group, pts)| DataSeries {
                label: group,
                color: None,
                points: pts
                    .into_iter()
                    .map(|(ts, count)| DataPoint {
                        x: ts as f64,
                        y: count as f64,
                        label: None,
                        timeline_pos: None,
                    })
                    .collect(),
            })
            .collect()
    } else {
        let pts = count_by_time(&owned, time_field, interval);
        vec![DataSeries {
            label: "count".to_string(),
            color: None,
            points: pts
                .into_iter()
                .map(|(ts, count)| DataPoint {
                    x: ts as f64,
                    y: count as f64,
                    label: None,
                    timeline_pos: None,
                })
                .collect(),
        }]
    }
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

fn build_scatter_series(
    spec: &ChartSpec,
    emissions: &[&HashMap<String, JsonValue>],
) -> Vec<DataSeries> {
    let x_field = spec.x.as_ref().and_then(|x| x.field.as_deref()).unwrap_or("x");
    let y_field = spec.y.as_ref().and_then(|y| y.field.as_deref()).unwrap_or("y");

    let points: Vec<DataPoint> = emissions
        .iter()
        .filter_map(|e| {
            let x = json_as_f64(e.get(x_field))?;
            let y = json_as_f64(e.get(y_field))?;
            Some(DataPoint { x, y, label: None, timeline_pos: None })
        })
        .collect();

    vec![DataSeries { label: "data".to_string(), color: None, points }]
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

fn build_histogram_series(
    spec: &ChartSpec,
    emissions: &[&HashMap<String, JsonValue>],
) -> Vec<DataSeries> {
    let field = spec.x.as_ref().and_then(|x| x.field.as_deref()).unwrap_or("value");
    let bins = spec.bins.unwrap_or(20) as usize;

    let vals: Vec<f64> = emissions
        .iter()
        .filter_map(|e| json_as_f64(e.get(field)))
        .collect();

    if vals.is_empty() {
        return vec![];
    }

    let (min, max) = if let Some(range) = spec.range {
        (range[0], range[1])
    } else {
        let mn = vals.iter().copied().fold(f64::INFINITY, f64::min);
        let mx = vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        (mn, mx)
    };

    let bin_width = (max - min) / bins as f64;
    if bin_width <= 0.0 {
        // min == max (every sampled value is identical) or an explicit
        // degenerate `range` was supplied — there's no width to distribute
        // across `bins`, but the samples are real. Report them as a single
        // bin holding the full count instead of an empty series, which
        // previously made a constant-value field indistinguishable from "no
        // data at all" to every chart consumer.
        return vec![DataSeries {
            label: field.to_string(),
            color: None,
            points: vec![DataPoint {
                x: min,
                y: vals.len() as f64,
                label: None,
                timeline_pos: None,
            }],
        }];
    }

    let mut counts = vec![0usize; bins];
    for v in &vals {
        let idx = ((*v - min) / bin_width).floor() as usize;
        let idx = idx.min(bins - 1);
        counts[idx] += 1;
    }

    let points: Vec<DataPoint> = counts
        .into_iter()
        .enumerate()
        .map(|(i, count)| DataPoint {
            x: min + bin_width * (i as f64 + 0.5),
            y: count as f64,
            label: None,
            timeline_pos: None,
        })
        .collect();

    vec![DataSeries { label: field.to_string(), color: None, points }]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::schema::AxisSpec;
    use serde_json::json;

    fn histogram_spec(bins: Option<u32>, range: Option<[f64; 2]>) -> ChartSpec {
        ChartSpec {
            id: "hist".to_string(),
            chart_type: "histogram".to_string(),
            title: "Histogram".to_string(),
            description: None,
            source: "emissions".to_string(),
            x: Some(AxisSpec { field: Some("value".to_string()), label: None, bucket: None, aggregation: None }),
            y: None,
            group_by: None,
            color_by: None,
            stacked: false,
            bins,
            range,
            color_scale: None,
            interactive: false,
            annotations: Vec::new(),
            timeline: None,
        }
    }

    fn emission(value: f64) -> HashMap<String, JsonValue> {
        let mut m = HashMap::new();
        m.insert("value".to_string(), json!(value));
        m
    }

    #[test]
    fn histogram_with_varying_values_bins_normally() {
        let spec = histogram_spec(Some(4), None);
        let owned = vec![emission(0.0), emission(1.0), emission(2.0), emission(3.0)];
        let refs: Vec<&HashMap<String, JsonValue>> = owned.iter().collect();

        let series = build_histogram_series(&spec, &refs);
        assert_eq!(series.len(), 1);
        let total: f64 = series[0].points.iter().map(|p| p.y).sum();
        assert_eq!(total, 4.0, "every sample must land in some bin");
    }

    #[test]
    fn histogram_with_constant_values_yields_single_bin_with_full_count() {
        // Before the fix: min == max => bin_width == 0.0 => the guard
        // returned an empty Vec<DataSeries>, so a processor whose sampled
        // field never varies (e.g. every emission has the same fd_count)
        // silently produced "no chart" instead of "one bin, N samples".
        let spec = histogram_spec(Some(10), None);
        let owned = vec![emission(42.0), emission(42.0), emission(42.0)];
        let refs: Vec<&HashMap<String, JsonValue>> = owned.iter().collect();

        let series = build_histogram_series(&spec, &refs);
        assert_eq!(series.len(), 1, "constant-value samples must still produce a series");
        assert_eq!(series[0].points.len(), 1, "all samples collapse into a single bin");
        assert_eq!(series[0].points[0].y, 3.0, "the single bin must hold the full sample count");
        assert_eq!(series[0].points[0].x, 42.0, "the single bin's x should be the constant value");
    }

    #[test]
    fn histogram_with_degenerate_explicit_range_yields_single_bin() {
        // An explicit `range: [5, 5]` is equally degenerate even if the
        // underlying values vary — same bin_width == 0.0 guard.
        let spec = histogram_spec(Some(10), Some([5.0, 5.0]));
        let owned = vec![emission(5.0), emission(5.0)];
        let refs: Vec<&HashMap<String, JsonValue>> = owned.iter().collect();

        let series = build_histogram_series(&spec, &refs);
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].points.len(), 1);
        assert_eq!(series[0].points[0].y, 2.0);
    }

    #[test]
    fn histogram_with_no_samples_still_yields_empty_series() {
        // Unrelated to the bin_width==0 guard — an empty input has no values
        // at all, so `vals.is_empty()` short-circuits before min/max are
        // even computed. Must remain unchanged by the fix above.
        let spec = histogram_spec(Some(10), None);
        let owned: Vec<HashMap<String, JsonValue>> = Vec::new();
        let refs: Vec<&HashMap<String, JsonValue>> = owned.iter().collect();

        let series = build_histogram_series(&spec, &refs);
        assert!(series.is_empty());
    }
}
