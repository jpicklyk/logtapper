use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::processors::marketplace;
use crate::processors::pack::{parse_pack_yaml, validate_pack};
use crate::processors::{AnyProcessor, PackMeta, PackSummary, ProcessorSummary};

pub(crate) fn persist_processor(app: &AppHandle, id: &str, yaml: &str) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let proc_dir = data_dir.join("processors");
    std::fs::create_dir_all(&proc_dir).map_err(|e| e.to_string())?;
    let filename = marketplace::id_to_filename(id);
    std::fs::write(proc_dir.join(format!("{filename}.yaml")), yaml)
        .map_err(|e| format!("Failed to persist processor: {e}"))
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

/// Validate, persist, and install a parsed processor into the store.
fn validate_and_install(
    app: &AppHandle,
    state: &AppState,
    yaml: &str,
    processor: AnyProcessor,
) -> Result<ProcessorSummary, String> {
    validate_processor(&processor)?;
    persist_processor(app, &processor.meta.id, yaml)?;
    let summary = ProcessorSummary::from(&processor);
    let mut procs = lock_or_err(&state.processors, "processors")?;
    procs.insert(processor.meta.id.clone(), processor);
    Ok(summary)
}

fn delete_processor_file(app: &AppHandle, id: &str) {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let filename = marketplace::id_to_filename(id);
        let _ = std::fs::remove_file(
            data_dir.join("processors").join(format!("{filename}.yaml"))
        );
    }
}

#[tauri::command]
pub async fn list_processors(
    state: State<'_, AppState>,
) -> Result<Vec<ProcessorSummary>, String> {
    let procs = lock_or_err(&state.processors, "processors")?;
    let mut out: Vec<ProcessorSummary> = procs.iter().map(|(key, p)| {
        let mut summary = ProcessorSummary::from(p);
        // Use the map key (qualified ID for marketplace processors) instead of bare meta.id.
        summary.id = key.clone();
        summary
    }).collect();
    drop(procs);

    // Cross-reference packs to annotate each summary with its pack_id.
    let packs = lock_or_err(&state.packs, "packs")?;
    let proc_to_pack: HashMap<&str, &str> = packs
        .iter()
        .flat_map(|pk| pk.processors.iter().map(move |pid| (pid.as_str(), pk.id.as_str())))
        .collect();
    for summary in &mut out {
        if let Some(pack_id) = proc_to_pack.get(summary.id.as_str()) {
            summary.pack_id = Some((*pack_id).to_string());
        }
    }
    drop(packs);

    out.sort_by(|a, b| b.builtin.cmp(&a.builtin).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn load_processor_yaml(
    state: State<'_, AppState>,
    app: AppHandle,
    yaml: String,
) -> Result<ProcessorSummary, String> {
    let processor = AnyProcessor::from_yaml(&yaml)?;
    validate_and_install(&app, &state, &yaml, processor)
}

#[tauri::command]
pub async fn load_processor_from_file(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<ProcessorSummary, String> {
    let yaml = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    let processor = AnyProcessor::from_yaml(&yaml)?;
    validate_and_install(&app, &state, &yaml, processor)
}

#[tauri::command]
pub async fn get_processor_vars(
    state: State<'_, AppState>,
    session_id: String,
    processor_id: String,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let pr = lock_or_err(&state.pipeline_results, "pipeline_results")?;
    let session_results = pr.get(&session_id)
        .ok_or_else(|| format!("No pipeline results for session '{session_id}'" ))?;
    let result = session_results.get(&processor_id)
        .ok_or_else(|| format!("No result for processor '{processor_id}'" ))?;
    Ok(result.vars.clone())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedLineInfo {
    pub line_num: usize,
    pub raw: String,
}

#[tauri::command]
pub async fn get_matched_lines(
    state: State<'_, AppState>,
    session_id: String,
    processor_id: String,
) -> Result<Vec<MatchedLineInfo>, String> {
    // 1. Reporter pipeline results
    let line_nums: Vec<usize> = {
        let pr = lock_or_err(&state.pipeline_results, "pipeline_results")?;
        if let Some(nums) = pr.get(&session_id)
            .and_then(|s| s.get(&processor_id))
            .map(|r| r.matched_line_nums.clone())
        {
            nums
        } else {
            drop(pr);
            // 2. State tracker transition lines
            let str_lock = lock_or_err(&state.state_tracker_results, "state_tracker_results")?;
            if let Some(nums) = str_lock.get(&session_id)
                .and_then(|s| s.get(&processor_id))
                .map(|r| r.transitions.iter().map(|t| t.line_num).collect::<Vec<_>>())
            {
                nums
            } else {
                drop(str_lock);
                // 3. Correlator event trigger lines
                let cr_lock = lock_or_err(&state.correlator_results, "correlator_results")?;
                cr_lock.get(&session_id)
                    .and_then(|s| s.get(&processor_id))
                    .map(|r| r.events.iter().map(|e| e.trigger_line_num).collect::<Vec<_>>())
                    .unwrap_or_default()
            }
        }
    };
    let mut line_nums = line_nums;
    line_nums.sort_unstable();

    let sessions = lock_or_err(&state.sessions, "sessions")?;
    let session = sessions.get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;
    let src = session.primary_source().ok_or("No sources in session")?;
    let result = line_nums.iter().map(|&n| MatchedLineInfo {
        line_num: n,
        raw: src.raw_line(n).as_deref().unwrap_or("").trim_end_matches(['\r', '\n']).to_string(),
    }).collect();
    Ok(result)
}

#[tauri::command]
pub async fn uninstall_processor(
    state: State<'_, AppState>,
    app: AppHandle,
    processor_id: String,
) -> Result<(), String> {
    if processor_id.starts_with("__") {
        return Err("Built-in processors cannot be uninstalled".to_string());
    }
    let mut procs = lock_or_err(&state.processors, "processors")?;
    if procs.remove(&processor_id).is_none() {
        return Err(format!("Processor '{processor_id}' not found"));
    }
    delete_processor_file(&app, &processor_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Pack commands
// ---------------------------------------------------------------------------

fn persist_pack(app: &AppHandle, id: &str, yaml: &str) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let packs_dir = data_dir.join("packs");
    std::fs::create_dir_all(&packs_dir).map_err(|e| e.to_string())?;
    std::fs::write(packs_dir.join(format!("{id}.pack.yaml")), yaml)
        .map_err(|e| format!("Failed to persist pack: {e}"))
}

/// Public alias for pack manifest persistence — used by marketplace pack install.
pub(crate) fn persist_pack_yaml(app: &AppHandle, id: &str, yaml: &str) -> Result<(), String> {
    persist_pack(app, id, yaml)
}

fn delete_pack_file(app: &AppHandle, id: &str) {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(data_dir.join("packs").join(format!("{id}.pack.yaml")));
    }
}

/// Public alias for pack file deletion — used by marketplace pack uninstall.
pub(crate) fn delete_pack_file_by_id(app: &AppHandle, id: &str) {
    delete_pack_file(app, id);
}

/// Public alias for processor file deletion — used by marketplace pack uninstall.
pub(crate) fn delete_processor_file_by_id(app: &AppHandle, id: &str) {
    delete_processor_file(app, id);
}

#[tauri::command]
pub async fn list_packs(state: State<'_, AppState>) -> Result<Vec<PackSummary>, String> {
    let packs = lock_or_err(&state.packs, "packs")?;
    Ok(packs.iter().map(PackSummary::from).collect())
}

#[tauri::command]
pub async fn install_pack_from_yaml(
    state: State<'_, AppState>,
    app: AppHandle,
    pack_id: String,
    yaml: String,
) -> Result<PackSummary, String> {
    if pack_id.trim().is_empty() {
        return Err("pack_id must not be empty".to_string());
    }
    let mut pack = parse_pack_yaml(&yaml)?;
    pack.id = pack_id;
    validate_pack(&pack)?;
    persist_pack(&app, &pack.id, &yaml)?;
    let summary = PackSummary::from(&pack);
    let mut packs = lock_or_err(&state.packs, "packs")?;
    // Replace if already present, otherwise push.
    if let Some(existing) = packs.iter_mut().find(|p| p.id == pack.id) {
        *existing = pack;
    } else {
        packs.push(pack);
    }
    Ok(summary)
}

#[tauri::command]
pub async fn uninstall_pack(
    state: State<'_, AppState>,
    app: AppHandle,
    pack_id: String,
) -> Result<(), String> {
    let mut packs = lock_or_err(&state.packs, "packs")?;
    let before = packs.len();
    packs.retain(|p| p.id != pack_id);
    if packs.len() == before {
        return Err(format!("Pack '{pack_id}' not found"));
    }
    drop(packs);
    delete_pack_file(&app, &pack_id);
    Ok(())
}

#[tauri::command]
pub async fn load_pack_from_file(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<PackSummary, String> {
    let yaml = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    let file_path = std::path::Path::new(&path);
    let id = crate::processors::pack::pack_id_from_path(file_path)
        .ok_or_else(|| "File must have a '.pack.yaml' extension to be loaded as a pack".to_string())?;
    let mut pack: PackMeta = parse_pack_yaml(&yaml)?;
    pack.id = id;
    validate_pack(&pack)?;
    persist_pack(&app, &pack.id, &yaml)?;
    let summary = PackSummary::from(&pack);
    let mut packs = lock_or_err(&state.packs, "packs")?;
    if let Some(existing) = packs.iter_mut().find(|p| p.id == pack.id) {
        *existing = pack;
    } else {
        packs.push(pack);
    }
    Ok(summary)
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
