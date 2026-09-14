use serde::Serialize;
use std::collections::HashMap;
use tauri::AppHandle;

use crate::processors::{AnyProcessor, PackSummary, ProcessorSummary};
use crate::services::processors as svc;
use ts_rs::TS;

/// Persist a processor YAML to disk. Kept as a direct `AppHandle`-based
/// helper — `lib.rs`'s startup auto-update path calls this before any
/// `ServiceCtx` exists — but delegates to the same `AppPaths`-based writer
/// [`crate::services::processors::install_yaml`] uses, so there is exactly
/// one place that knows the on-disk layout.
pub(crate) fn persist_processor(app: &AppHandle, id: &str, yaml: &str) -> Result<(), String> {
    let paths = crate::commands::adapters::TauriPaths::new(app.clone());
    svc::persist_processor_file(&paths, id, yaml).map_err(|e| e.message())
}

/// Pure validation checks for an `AnyProcessor` — no I/O, no AppHandle needed.
/// Returns `Ok(())` if all checks pass, or an error string describing the problem.
pub(crate) fn validate_processor(processor: &AnyProcessor) -> Result<(), String> {
    // Reject transformer AddField ops that have a non-empty script — the script
    // is never evaluated (AddField only inserts an empty string placeholder).
    if let Some(transformer_def) = processor.as_transformer() {
        use crate::processors::transformer::schema::TransformOp;
        for op in &transformer_def.transforms {
            if let TransformOp::AddField { script, .. } = op {
                if !script.is_empty() {
                    return Err(
                        "AddField with script is not yet supported. \
                         Use SetField for static values."
                            .to_string(),
                    );
                }
            }
        }
    }

    processor.validate_filter_rules()?;
    if let Some(reporter_def) = processor.as_reporter() {
        for stage in &reporter_def.pipeline {
            use crate::processors::schema::PipelineStage;
            use crate::processors::reporter::schema::AggType;
            match stage {
                PipelineStage::Script(s) => {
                    crate::scripting::sandbox::validate_for_install(&s.src)?;
                }
                PipelineStage::Aggregate(agg) => {
                    for group in &agg.groups {
                        match &group.agg_type {
                            AggType::Min => return Err("Unsupported aggregate type 'min'. Supported types: count, count_by, burst_detector".to_string()),
                            AggType::Max => return Err("Unsupported aggregate type 'max'. Supported types: count, count_by, burst_detector".to_string()),
                            AggType::Avg => return Err("Unsupported aggregate type 'avg'. Supported types: count, count_by, burst_detector".to_string()),
                            AggType::Percentile => return Err("Unsupported aggregate type 'percentile'. Supported types: count, count_by, burst_detector".to_string()),
                            AggType::TimeBucket => return Err("Unsupported aggregate type 'time_bucket'. Supported types: count, count_by, burst_detector".to_string()),
                            AggType::Count | AggType::CountBy | AggType::BurstDetector => {}
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(correlator_def) = processor.as_correlator() {
        for src in &correlator_def.sources {
            if let Some(condition) = &src.condition {
                crate::scripting::sandbox::validate_expression(condition).map_err(|e| {
                    format!(
                        "Correlator source '{}' has invalid condition: {e}",
                        src.id
                    )
                })?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — thin adapters over services::processors
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_processors(app: AppHandle) -> Result<Vec<ProcessorSummary>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::list(&ctx).map_err(|e| e.message())
}

#[tauri::command]
pub async fn load_processor_yaml(app: AppHandle, yaml: String) -> Result<ProcessorSummary, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::install_yaml(&ctx, &yaml).map_err(|e| e.message())
}

#[tauri::command]
pub async fn load_processor_from_file(app: AppHandle, path: String) -> Result<ProcessorSummary, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::install_from_file(&ctx, &path).map_err(|e| e.message())
}

/// Accumulated variables for one reporter. Thin adapter over
/// [`crate::services::pipeline::processor_vars`] — the same aggregate the MCP
/// bridge reads, so the two transports cannot drift. (WP-4; unchanged.)
#[tauri::command]
pub async fn get_processor_vars(
    app: AppHandle,
    session_id: String,
    processor_id: String,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    crate::services::pipeline::processor_vars(&ctx, &session_id, &processor_id)
        .map_err(|e| e.message())
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchedLineInfo {
    pub line_num: usize,
    pub raw: String,
}

/// Every line one processor touched, with its text. Thin adapter over
/// [`crate::services::pipeline::matched_lines`], which owns the
/// reporter → state-tracker → correlator fallback and the caller's redaction
/// gate (a no-op for the UI caller). (WP-4; unchanged.)
#[tauri::command]
pub async fn get_matched_lines(
    app: AppHandle,
    session_id: String,
    processor_id: String,
) -> Result<Vec<MatchedLineInfo>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    crate::services::pipeline::matched_lines(&ctx, &session_id, &processor_id)
        .map_err(|e| e.message())
}

#[tauri::command]
pub async fn uninstall_processor(app: AppHandle, processor_id: String) -> Result<(), String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::uninstall(&ctx, &processor_id).map_err(|e| e.message())
}

// ---------------------------------------------------------------------------
// Pack commands — thin adapters over services::processors
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_packs(app: AppHandle) -> Result<Vec<PackSummary>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::packs(&ctx).map_err(|e| e.message())
}

#[tauri::command]
pub async fn install_pack_from_yaml(app: AppHandle, pack_id: String, yaml: String) -> Result<PackSummary, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::install_pack_yaml(&ctx, &pack_id, &yaml).map_err(|e| e.message())
}

#[tauri::command]
pub async fn uninstall_pack(app: AppHandle, pack_id: String) -> Result<(), String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::uninstall_pack(&ctx, &pack_id).map_err(|e| e.message())
}

#[tauri::command]
pub async fn load_pack_from_file(app: AppHandle, path: String) -> Result<PackSummary, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::load_pack_from_file(&ctx, &path).map_err(|e| e.message())
}

// ---------------------------------------------------------------------------
// Gap 4: Install validation tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::validate_processor;
    use crate::processors::{AnyProcessor, ProcessorKind, ProcessorMeta};
    use crate::processors::transformer::schema::{TransformerDef, TransformOp};
    use crate::processors::reporter::schema::{ReporterDef, AggType};

    fn make_meta(id: &str) -> ProcessorMeta {
        ProcessorMeta {
            id: id.to_string(),
            name: "Test".to_string(),
            version: "1.0.0".to_string(),
            author: String::new(),
            description: String::new(),
            tags: vec![],
            builtin: false,
            license: None,
            category: None,
            repository: None,
            deprecated: false,
        }
    }

    fn make_reporter_with_agg(agg_type: AggType) -> AnyProcessor {
        let def: ReporterDef = serde_yaml::from_str(&format!(r#"
meta:
  id: test_reporter
  name: Test
pipeline:
  - stage: aggregate
    groups:
      - type: {agg_type}
"#, agg_type = match agg_type {
    AggType::Count => "count",
    AggType::CountBy => "count_by",
    AggType::Min => "min",
    AggType::Max => "max",
    AggType::Avg => "avg",
    AggType::Percentile => "percentile",
    AggType::TimeBucket => "time_bucket",
    AggType::BurstDetector => "burst_detector",
})).unwrap();
        AnyProcessor {
            meta: make_meta("test_reporter"),
            kind: ProcessorKind::Reporter(std::sync::Arc::new(def)),
            schema: None,
            source: None,
            installed_by: None,
        }
    }

    // ── 4a. Rejects AddField with non-empty script ──────────────────────────

    #[test]
    fn rejects_addfield_with_script() {
        let def = TransformerDef {
            filter: None,
            transforms: vec![TransformOp::AddField {
                name: "foo".to_string(),
                script: "some_script".to_string(),
            }],
            builtin: None,
        };
        let proc = AnyProcessor {
            meta: make_meta("__test_transformer"),
            kind: ProcessorKind::Transformer(std::sync::Arc::new(def)),
            schema: None,
            source: None,
            installed_by: None,
        };
        let result = validate_processor(&proc);
        assert!(result.is_err(), "Expected AddField with script to be rejected");
    }

    // ── 4c. Accepts AddField with empty script ────────────────────────────────

    #[test]
    fn accepts_addfield_without_script() {
        let def = TransformerDef {
            filter: None,
            transforms: vec![TransformOp::AddField {
                name: "foo".to_string(),
                script: String::new(),
            }],
            builtin: None,
        };
        let proc = AnyProcessor {
            meta: make_meta("__test_transformer"),
            kind: ProcessorKind::Transformer(std::sync::Arc::new(def)),
            schema: None,
            source: None,
            installed_by: None,
        };
        // The AddField check should pass (other checks may still apply but at
        // minimum the AddField-specific rejection must not trigger)
        let result = validate_processor(&proc);
        assert!(
            result.is_ok() || !result.as_ref().unwrap_err().contains("AddField"),
            "AddField with empty script should not be rejected for AddField reason, got: {:?}",
            result
        );
    }

    // ── 4d. Rejects aggregate min ─────────────────────────────────────────────

    #[test]
    fn rejects_unimplemented_aggregate_min() {
        let proc = make_reporter_with_agg(AggType::Min);
        let result = validate_processor(&proc);
        assert!(result.is_err(), "Expected 'min' aggregate to be rejected");
        assert!(result.unwrap_err().contains("min"), "Error should mention 'min'");
    }

    // ── 4e. Rejects aggregate avg ─────────────────────────────────────────────

    #[test]
    fn rejects_unimplemented_aggregate_avg() {
        let proc = make_reporter_with_agg(AggType::Avg);
        let result = validate_processor(&proc);
        assert!(result.is_err(), "Expected 'avg' aggregate to be rejected");
        assert!(result.unwrap_err().contains("avg"), "Error should mention 'avg'");
    }

    // ── 4f. Accepts aggregate count ──────────────────────────────────────────

    #[test]
    fn accepts_implemented_aggregate_count() {
        let proc = make_reporter_with_agg(AggType::Count);
        let result = validate_processor(&proc);
        assert!(result.is_ok(), "Expected 'count' aggregate to be accepted, got: {:?}", result);
    }

    // ── 4g. Accepts aggregate count_by ───────────────────────────────────────

    #[test]
    fn accepts_implemented_aggregate_count_by() {
        let proc = make_reporter_with_agg(AggType::CountBy);
        let result = validate_processor(&proc);
        assert!(result.is_ok(), "Expected 'count_by' aggregate to be accepted, got: {:?}", result);
    }
}
