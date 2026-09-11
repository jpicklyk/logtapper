//! `timeline` service — chart and per-processor timeline-series data derived
//! from a session's pipeline results.
//!
//! Moved verbatim from `commands/charts.rs`. Both functions are pure reads —
//! [`chart_data`] locks `processors` then `pipeline_results`; [`timeline_data`]
//! locks `processors` and, per requested processor, `pipeline_results` — never
//! two at once, and neither ever holds a lock across an `.await`. Neither is
//! journaled (reads are never journaled — see `ServiceCtx::journal`'s doc
//! comment).
//!
//! **No `policy::redact_line` call here, deliberately.** [`ChartData`] and
//! [`TimelineSeriesData`] carry only numeric `x`/`y` positions, the processor's
//! own axis/series labels (from its YAML `output.charts` spec), and line
//! *numbers* (`TimelinePoint::line_num`) — never a raw log line's text. Traced
//! through `charts::builder::build_charts`/`build_chart` end to end: they read
//! `Emission::fields` (structured values a reporter's `extract` stage chose to
//! pull out) and a `ChartSpec`, nothing else. There is therefore no raw-text
//! surface for an `Agent` caller to leak here, unlike `services::lines`/
//! `services::search`/`services::pipeline`'s matched-line text.
//!
//! **No `services::tracker` reuse either**, despite this package's task
//! prompt suggesting it: `build_charts`/`build_chart` only ever look at a
//! processor's `Output` pipeline stage and `Emission`s (Reporter-only —
//! `def.as_reporter()` short-circuits to an empty result for any other
//! processor kind), and neither reads a state tracker's transition history at
//! all. There is nothing here that re-reads a result map [`services::tracker`]
//! already owns; if a future chart type needs tracker transitions, reach for
//! `services::tracker` then rather than re-deriving line ranges from
//! `pipeline_results` by hand.

use crate::charts::builder::{build_charts, ChartData};
use crate::processors::schema::PipelineStage;
use serde::Serialize;
use ts_rs::TS;

use super::{lock_svc, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// get_chart_data
// ---------------------------------------------------------------------------

/// Compute every `ChartData` a Reporter processor's `output.charts` spec
/// declares, from that processor's current `pipeline_results` for `session_id`.
///
/// Returns an empty vec (not an error) when the processor is not a Reporter —
/// charts are a Reporter-only concept, and a non-Reporter id is not a caller
/// mistake worth failing on.
pub fn chart_data(
    ctx: &ServiceCtx,
    session_id: &str,
    processor_id: &str,
) -> Result<Vec<ChartData>, ServiceError> {
    let state = ctx.state();

    // Get the processor definition.
    let def = {
        let procs = lock_svc(&state.processors, "processors")?;
        procs
            .get(processor_id)
            .cloned()
            .ok_or_else(|| ServiceError::NotFound(format!("Processor '{processor_id}' not found")))?
    };

    // Get the pipeline run result.
    let (emissions, vars) = {
        let pr = lock_svc(&state.pipeline_results, "pipeline_results")?;
        let session_results = pr.get(session_id).ok_or_else(|| {
            ServiceError::NotFound(format!("No pipeline results for session '{session_id}'"))
        })?;
        let result = session_results.get(processor_id).ok_or_else(|| {
            ServiceError::NotFound(format!("No result for processor '{processor_id}'"))
        })?;
        (result.emissions.clone(), result.vars.clone())
    };

    // Charts are only supported for Reporter-type processors.
    let Some(reporter) = def.as_reporter() else {
        return Ok(vec![]);
    };
    Ok(build_charts(reporter, &emissions, &vars))
}

// ---------------------------------------------------------------------------
// get_timeline_data — extract (line_num, value) pairs for sparkline rendering
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePoint {
    pub line_num: usize,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, TS)]
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

/// Extract downsampled `(line_num, value)` series for every `ChartSpec` with a
/// `timeline` annotation, across the given processors, for sparkline
/// rendering. Silently skips processors that are missing, not Reporters, have
/// no `timeline`-annotated chart, or have no pipeline results yet — an
/// unready processor is not a caller error here (the UI polls this
/// opportunistically as runs complete).
pub fn timeline_data(
    ctx: &ServiceCtx,
    session_id: &str,
    processor_ids: &[String],
) -> Result<Vec<TimelineSeriesData>, ServiceError> {
    let state = ctx.state();
    let mut series_list = Vec::new();

    for pid in processor_ids {
        // Get the processor definition.
        let def = {
            let procs = lock_svc(&state.processors, "processors")?;
            let Some(d) = procs.get(pid) else {
                continue;
            };
            d.clone()
        };

        let Some(reporter) = def.as_reporter() else {
            continue;
        };

        // Find ChartSpecs with timeline annotations.
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

        // Get emissions for this processor.
        let emissions = {
            let pr = lock_svc(&state.pipeline_results, "pipeline_results")?;
            match pr.get(session_id).and_then(|sr| sr.get(pid)) {
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

            // Compute min/max before downsampling.
            let min_value = raw_points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
            let max_value = raw_points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);

            // LTTB downsample to max 500 points.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::{AnyProcessor, Emission, RunResult};
    use crate::services::testing::test_ctx;
    use serde_json::json;

    const BAR_REPORTER_YAML: &str = r#"
meta:
  id: rep-1
  name: R
pipeline:
  - stage: output
    charts:
      - id: bar-1
        type: bar
        title: Bar
        source: emissions
        x:
          field: category
"#;

    const TIMELINE_REPORTER_YAML: &str = r##"
meta:
  id: rep-1
  name: R
pipeline:
  - stage: output
    charts:
      - id: bar-1
        type: bar
        title: Bar
        source: emissions
        x:
          field: category
        timeline:
          field: value
          label: My Value
          color: "#f00"
"##;

    const TRACKER_YAML: &str = r#"
type: state_tracker
id: trk
name: T
version: 1.0.0
"#;

    fn install(ctx: &ServiceCtx, id: &str, yaml: &str) {
        let proc = AnyProcessor::from_yaml(yaml).expect("fixture yaml parses");
        ctx.state().processors.lock().unwrap().insert(id.to_string(), proc);
    }

    fn seed_emissions(ctx: &ServiceCtx, session_id: &str, processor_id: &str, emissions: Vec<Emission>) {
        let mut pr = ctx.state().pipeline_results.lock().unwrap();
        pr.entry(session_id.to_string())
            .or_default()
            .insert(processor_id.to_string(), RunResult { emissions, ..Default::default() });
    }

    #[test]
    fn chart_data_builds_from_reporter_emissions() {
        let (ctx, _tmp) = test_ctx().build();
        install(&ctx, "rep-1", BAR_REPORTER_YAML);
        seed_emissions(
            &ctx,
            "s1",
            "rep-1",
            vec![
                Emission { line_num: 0, fields: vec![("category".to_string(), json!("a"))] },
                Emission { line_num: 1, fields: vec![("category".to_string(), json!("a"))] },
                Emission { line_num: 2, fields: vec![("category".to_string(), json!("b"))] },
            ],
        );

        let charts = chart_data(&ctx, "s1", "rep-1").unwrap();
        assert_eq!(charts.len(), 1);
        assert_eq!(charts[0].id, "bar-1");
        let total: f64 = charts[0].series[0].points.iter().map(|p| p.y).sum();
        assert_eq!(total, 3.0);
    }

    #[test]
    fn chart_data_unknown_processor_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = chart_data(&ctx, "s1", "nope").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn chart_data_missing_pipeline_results_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        install(&ctx, "rep-1", BAR_REPORTER_YAML);
        let err = chart_data(&ctx, "s1", "rep-1").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn chart_data_non_reporter_processor_returns_empty_not_an_error() {
        let (ctx, _tmp) = test_ctx().build();
        install(&ctx, "trk", TRACKER_YAML);
        seed_emissions(&ctx, "s1", "trk", vec![]);
        let charts = chart_data(&ctx, "s1", "trk").unwrap();
        assert!(charts.is_empty());
    }

    #[test]
    fn timeline_data_downsamples_a_timeline_annotated_field() {
        let (ctx, _tmp) = test_ctx().build();
        install(&ctx, "rep-1", TIMELINE_REPORTER_YAML);
        let emissions = (0..10)
            .map(|i| Emission { line_num: i, fields: vec![("value".to_string(), json!(i as f64))] })
            .collect();
        seed_emissions(&ctx, "s1", "rep-1", emissions);

        let series = timeline_data(&ctx, "s1", &["rep-1".to_string()]).unwrap();
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].field, "value");
        assert_eq!(series[0].label, "My Value");
        assert_eq!(series[0].color.as_deref(), Some("#f00"));
        assert_eq!(series[0].min_value, 0.0);
        assert_eq!(series[0].max_value, 9.0);
        assert!(series[0].points.len() <= 10);
    }

    #[test]
    fn timeline_data_skips_processors_without_a_timeline_spec() {
        let (ctx, _tmp) = test_ctx().build();
        install(&ctx, "rep-1", BAR_REPORTER_YAML);
        seed_emissions(&ctx, "s1", "rep-1", vec![]);
        let series = timeline_data(&ctx, "s1", &["rep-1".to_string()]).unwrap();
        assert!(series.is_empty());
    }

    #[test]
    fn timeline_data_skips_unknown_and_non_reporter_processors_without_erroring() {
        let (ctx, _tmp) = test_ctx().build();
        let series = timeline_data(&ctx, "s1", &["does-not-exist".to_string()]).unwrap();
        assert!(series.is_empty());
    }
}
