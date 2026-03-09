use serde::Serialize;
use tauri::State;

use crate::charts::builder::{build_charts, ChartData};
use crate::commands::AppState;
use crate::processors::schema::PipelineStage;

// ---------------------------------------------------------------------------
// get_chart_data
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_chart_data(
    state: State<'_, AppState>,
    session_id: String,
    processor_id: String,
) -> Result<Vec<ChartData>, String> {
    // Get the processor definition
    let def = {
        let procs = state
            .processors
            .lock()
            .map_err(|_| "Processor store lock poisoned")?;
        procs
            .get(&processor_id)
            .cloned()
            .ok_or_else(|| format!("Processor '{processor_id}' not found"))?
    };

    // Get the pipeline run result
    let (emissions, vars) = {
        let pr = state
            .pipeline_results
            .lock()
            .map_err(|_| "Pipeline results lock poisoned")?;
        let session_results = pr
            .get(&session_id)
            .ok_or_else(|| format!("No pipeline results for session '{session_id}'"))?;
        let result = session_results
            .get(&processor_id)
            .ok_or_else(|| format!("No result for processor '{processor_id}'"))?;
        (result.emissions.clone(), result.vars.clone())
    };

    // Charts are only supported for Reporter-type processors.
    let Some(reporter) = def.as_reporter() else {
        return Ok(vec![]);
    };
    let charts = build_charts(reporter, &emissions, &vars);
    Ok(charts)
}

// ---------------------------------------------------------------------------
// get_timeline_data — extract (line_num, value) pairs for sparkline rendering
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePoint {
    pub line_num: usize,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSeriesData {
    pub processor_id: String,
    pub processor_name: String,
    pub field: String,
    pub label: String,
    pub color: Option<String>,
    pub points: Vec<TimelinePoint>,
    pub min_value: f64,
    pub max_value: f64,
}

/// LTTB (Largest-Triangle-Three-Buckets) downsampling.
/// Reduces a series of points to at most `threshold` representative points
/// while preserving the visual shape of the data.
fn lttb_downsample(points: &[(usize, f64)], threshold: usize) -> Vec<(usize, f64)> {
    let n = points.len();
    if n <= threshold || threshold < 3 {
        return points.to_vec();
    }

    let mut result = Vec::with_capacity(threshold);
    // Always keep the first point
    result.push(points[0]);

    let bucket_size = (n - 2) as f64 / (threshold - 2) as f64;

    let mut prev_idx = 0usize;

    for i in 0..(threshold - 2) {
        // Bucket boundaries
        let bucket_start = (i as f64).mul_add(bucket_size, 1.0).floor() as usize;
        let bucket_end = ((i + 1) as f64).mul_add(bucket_size, 1.0).floor().min(n as f64) as usize;

        // Average of the next bucket (for the triangle area calculation)
        let next_start = bucket_end;
        let next_end = ((i + 2) as f64).mul_add(bucket_size, 1.0).floor().min(n as f64) as usize;
        let (avg_x, avg_y) = if next_start < next_end {
            let count = (next_end - next_start) as f64;
            let sx: f64 = (next_start..next_end).map(|j| points[j].0 as f64).sum();
            let sy: f64 = (next_start..next_end).map(|j| points[j].1).sum();
            (sx / count, sy / count)
        } else {
            let last = points[n - 1];
            (last.0 as f64, last.1)
        };

        // Find the point in the current bucket with the largest triangle area
        let (prev_x, prev_y) = (points[prev_idx].0 as f64, points[prev_idx].1);
        let mut max_area = -1.0f64;
        let mut best = bucket_start;

        for (j, pt) in points.iter().enumerate().take(bucket_end).skip(bucket_start) {
            let (cx, cy) = (pt.0 as f64, pt.1);
            let area = (prev_x - avg_x).mul_add(cy - prev_y, -((prev_x - cx) * (avg_y - prev_y))).abs();
            if area > max_area {
                max_area = area;
                best = j;
            }
        }

        result.push(points[best]);
        prev_idx = best;
    }

    // Always keep the last point
    result.push(points[n - 1]);
    result
}

#[tauri::command]
pub async fn get_timeline_data(
    state: State<'_, AppState>,
    session_id: String,
    processor_ids: Vec<String>,
) -> Result<Vec<TimelineSeriesData>, String> {
    let mut series_list = Vec::new();

    for pid in &processor_ids {
        // Get the processor definition
        let def = {
            let procs = state
                .processors
                .lock()
                .map_err(|_| "Processor store lock poisoned")?;
            let Some(d) = procs.get(pid) else {
                continue;
            };
            d.clone()
        };

        let Some(reporter) = def.as_reporter() else {
            continue;
        };

        // Find ChartSpecs with timeline annotations
        let output = reporter.pipeline.iter().find_map(|s| {
            if let PipelineStage::Output(o) = s { Some(o) } else { None }
        });
        let Some(output) = output else {
            continue;
        };

        let timeline_specs: Vec<_> = output
            .charts
            .iter()
            .filter_map(|c| c.timeline.clone())
            .collect();

        if timeline_specs.is_empty() {
            continue;
        }

        // Get emissions for this processor
        let emissions = {
            let pr = state
                .pipeline_results
                .lock()
                .map_err(|_| "Pipeline results lock poisoned")?;
            match pr.get(&session_id).and_then(|sr| sr.get(pid)) {
                Some(result) => result.emissions.clone(),
                None => continue,
            }
        };

        for tspec in &timeline_specs {
            let mut raw_points: Vec<(usize, f64)> = Vec::new();

            for emission in &emissions {
                let val = emission.fields.iter().find_map(|(k, v)| {
                    if k == &tspec.field {
                        match v {
                            serde_json::Value::Number(n) => n.as_f64(),
                            _ => None,
                        }
                    } else {
                        None
                    }
                });
                if let Some(v) = val {
                    raw_points.push((emission.line_num, v));
                }
            }

            if raw_points.is_empty() {
                continue;
            }

            // Compute min/max before downsampling
            let min_value = raw_points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
            let max_value = raw_points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);

            // LTTB downsample to max 500 points
            let downsampled = lttb_downsample(&raw_points, 500);

            let points: Vec<TimelinePoint> = downsampled
                .into_iter()
                .map(|(ln, v)| TimelinePoint { line_num: ln, value: v })
                .collect();

            let label = tspec.label.clone().unwrap_or_else(|| tspec.field.clone());

            series_list.push(TimelineSeriesData {
                processor_id: pid.clone(),
                processor_name: def.meta.name.clone(),
                field: tspec.field.clone(),
                label,
                color: tspec.color.clone(),
                points,
                min_value,
                max_value,
            });
        }
    }

    Ok(series_list)
}
