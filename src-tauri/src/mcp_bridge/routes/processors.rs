//! Processor definition endpoints: list all, single detail.

use std::borrow::Cow;

use axum::{
    Json,
    extract::{Path, State},
};
use serde_json::{Value, json};

use crate::processors::marketplace::resolve_processor_id_checked;
use crate::processors::{AnyProcessor, ProcessorKind};

use crate::mcp_bridge::BridgeCtx;

/// Extract the `sections` list from any processor kind.
///
/// Returns a borrowed slice for reporters (already stored) and an owned Vec
/// for state trackers (computed from transition filters). Other kinds get `[]`.
fn extract_sections(p: &AnyProcessor) -> Cow<'_, [String]> {
    match &p.kind {
        ProcessorKind::Reporter(def) => Cow::Borrowed(&def.sections),
        ProcessorKind::StateTracker(def) => {
            let mut sections: Vec<String> = def.transitions.iter()
                .filter_map(|t| t.filter.section.clone())
                .collect();
            sections.sort();
            sections.dedup();
            Cow::Owned(sections)
        }
        _ => Cow::Borrowed(&[]),
    }
}

/// Extract `source_types` from the processor's schema contract.
fn extract_source_types(p: &AnyProcessor) -> &[String] {
    p.schema.as_ref()
        .map_or(&[], |s| s.source_types.as_slice())
}

// ---------------------------------------------------------------------------
// GET /mcp/processors — list all processor definitions
// ---------------------------------------------------------------------------

pub(crate) async fn h_processor_defs_list(State(ctx): State<BridgeCtx>) -> Json<Value> {
    let state = &*ctx.state;

    let processors: Vec<Value> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs.iter().map(|(qualified_id, p)| {
            json!({
                "id": qualified_id,
                "name": p.meta.name,
                "processorType": p.processor_type(),
                "description": p.meta.description,
                "version": p.meta.version,
                "builtin": p.meta.builtin,
                "tags": p.meta.tags,
                "sections": extract_sections(p),
                "sourceTypes": extract_source_types(p),
            })
        }).collect()
    };

    Json(json!({
        "processorCount": processors.len(),
        "processors": processors,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/processors/{processor_id} — single processor definition detail
// ---------------------------------------------------------------------------

pub(crate) async fn h_processor_defs_single(
    State(ctx): State<BridgeCtx>,
    Path(processor_id): Path<String>,
) -> Json<Value> {
    let state = &*ctx.state;

    let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let resolved = match resolve_processor_id_checked(&procs, &processor_id) {
        Ok(r) => r,
        Err(e) => return Json(json!({ "error": e, "processorId": processor_id })),
    };
    let Some(p) = resolved.as_ref().and_then(|rid| procs.get(rid)) else {
        return Json(json!({ "error": "processor not found", "processorId": processor_id }));
    };

    let mut result = json!({
        "id": p.meta.id,
        "name": p.meta.name,
        "processorType": p.processor_type(),
        "description": p.meta.description,
        "version": p.meta.version,
        "author": p.meta.author,
        "builtin": p.meta.builtin,
        "tags": p.meta.tags,
        "sections": extract_sections(p),
        "sourceTypes": extract_source_types(p),
    });

    match &p.kind {
        ProcessorKind::Reporter(def) => {
            // Summarize filter rules
            let filters: Vec<Value> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Filter(fs) => {
                        let rules: Vec<String> = fs.rules.iter().map(|r| match r {
                            crate::processors::reporter::schema::FilterRule::TagMatch { tags, .. } => format!("tag_match: [{}]", tags.join(", ")),
                            crate::processors::reporter::schema::FilterRule::MessageContains { value } => format!("message_contains: \"{value}\""),
                            crate::processors::reporter::schema::FilterRule::MessageContainsAny { values } => format!("message_contains_any: [{}]", values.join(", ")),
                            crate::processors::reporter::schema::FilterRule::MessageRegex { pattern } => format!("message_regex: \"{pattern}\""),
                            crate::processors::reporter::schema::FilterRule::LevelMin { level } => format!("level_min: {level}"),
                            crate::processors::reporter::schema::FilterRule::TimeRange { from, to, .. } => format!("time_range: {from} - {to}"),
                            crate::processors::reporter::schema::FilterRule::SourceTypeIs { source_type } => format!("source_type_is: {source_type}"),
                            crate::processors::reporter::schema::FilterRule::TagRegex { pattern } => format!("tag_regex: \"{pattern}\""),
                            crate::processors::reporter::schema::FilterRule::SectionIs { section } => format!("section_is: {section}"),
                        }).collect();
                        Some(json!(rules))
                    }
                    _ => None,
                }
            }).collect();

            // Extract patterns
            let extracts: Vec<Value> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Extract(es) => {
                        let fields: Vec<Value> = es.fields.iter().map(|f| {
                            json!({
                                "name": f.name,
                                "pattern": f.pattern,
                                "cast": f.cast.as_ref().map(|c| format!("{c:?}").to_lowercase()),
                            })
                        }).collect();
                        Some(json!(fields))
                    }
                    _ => None,
                }
            }).collect();

            // Aggregation types
            let aggregations: Vec<String> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Aggregate(agg) => {
                        let types: Vec<String> = agg.groups.iter().map(|g| format!("{:?}", g.agg_type).to_lowercase()).collect();
                        Some(types.join(", "))
                    }
                    _ => None,
                }
            }).collect();

            let has_script = def.pipeline.iter().any(|s| matches!(s, crate::processors::reporter::schema::PipelineStage::Script(_)));

            // Var declarations
            let vars: Vec<Value> = def.vars.iter().map(|v| {
                json!({
                    "name": v.name,
                    "type": format!("{:?}", v.var_type).to_lowercase(),
                    "display": v.display,
                    "label": v.label,
                })
            }).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("filters".to_string(), json!(filters));
            obj.insert("extracts".to_string(), json!(extracts));
            obj.insert("aggregations".to_string(), json!(aggregations));
            obj.insert("hasScript".to_string(), json!(has_script));
            obj.insert("vars".to_string(), json!(vars));
        }
        ProcessorKind::StateTracker(def) => {
            let state_fields: Vec<Value> = def.state.iter().map(|f| {
                json!({
                    "name": f.name,
                    "type": format!("{:?}", f.field_type).to_lowercase(),
                    "default": f.default,
                })
            }).collect();

            let transition_names: Vec<String> = def.transitions.iter().map(|t| t.name.clone()).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("group".to_string(), json!(def.group));
            obj.insert("stateFields".to_string(), json!(state_fields));
            obj.insert("transitionNames".to_string(), json!(transition_names));
        }
        ProcessorKind::Correlator(def) => {
            let source_ids: Vec<String> = def.sources.iter().map(|s| s.id.clone()).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("sourceIds".to_string(), json!(source_ids));
            obj.insert("trigger".to_string(), json!(def.correlate.trigger));
            obj.insert("withinLines".to_string(), json!(def.correlate.within_lines));
            obj.insert("withinMs".to_string(), json!(def.correlate.within_ms));
            obj.insert("guidance".to_string(), json!(def.correlate.guidance));
        }
        ProcessorKind::Transformer(_) => {
            // Minimal info already in base result
        }
    }

    Json(result)
}
