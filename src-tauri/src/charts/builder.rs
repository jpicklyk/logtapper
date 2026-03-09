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
        return vec![];
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
