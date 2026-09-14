//! Processor + pack install/uninstall/listing.
//!
//! `commands/processors.rs` (UI) and `mcp_bridge/routes/processors.rs` (agent)
//! are both thin adapters over this file — install/uninstall logic, on-disk
//! persistence (via [`super::AppPaths`], never a raw `AppHandle`), and the
//! journal calls all live here exactly once.
//!
//! `resolve_processor_id_checked` stays in `processors::marketplace` (WP-4 left
//! it there and several other services depend on it); this file only owns the
//! processor/pack *store* operations.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

use crate::processors::marketplace::{self, resolve_processor_id_checked};
use crate::processors::{AnyProcessor, PackMeta, PackSummary, ProcessorKind, ProcessorSummary};

use super::paths::AppPaths;
use super::policy;
use super::{lock_svc, Caller, ServiceCtx, ServiceError};

/// Emitted as the `catalog-update` Tauri event on every processor/pack
/// install, uninstall, or update, from either caller — mirrors
/// `WatchUpdateEvent`'s "the UI panel updates live regardless of transport"
/// contract for the catalog rather than one session's artifacts. `ids` are
/// qualified processor ids and/or pack ids, whichever the mutation touched.
/// Never emitted for `add_source`/`remove_source` — sources are a
/// human-only surface, not a catalog change.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogUpdateEvent {
    pub caller: Caller,
    /// `"install"` | `"uninstall"` | `"update"`.
    pub action: String,
    pub ids: Vec<String>,
}

/// Emit `catalog-update` after the journal call, at every processor/pack
/// mutation site. A no-op for an empty `ids` (e.g. `update_all_from_source`
/// finding nothing to apply) — an empty event would tell listeners nothing.
pub(crate) fn emit_catalog_update(ctx: &ServiceCtx, action: &str, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    ctx.events().emit_json(
        "catalog-update",
        serde_json::to_value(CatalogUpdateEvent {
            caller: ctx.caller().clone(),
            action: action.to_string(),
            ids,
        })
        .unwrap_or_default(),
    );
}

/// Provenance string stored as `_installed_by` in a processor's persisted
/// YAML: `"ui"` for the desktop UI, `"agent:<client>"` for an MCP agent.
pub(crate) fn caller_provenance(caller: &Caller) -> String {
    match caller {
        Caller::Ui => "ui".to_string(),
        Caller::Agent { client } => format!("agent:{client}"),
    }
}

/// One `_installed_by: <value>` line with the value YAML-quoted where it needs
/// to be. The agent half of the value is the raw `X-LogTapper-Client` header —
/// a client calling itself `a: b` must not be able to corrupt the persisted
/// file so the processor vanishes on the next load.
pub(crate) fn installed_by_line(installed_by: &str) -> String {
    let scalar = serde_yaml::to_string(installed_by).unwrap_or_else(|_| "''\n".to_string());
    format!("_installed_by: {}", scalar.trim_end_matches('\n'))
}

/// Stamp `_installed_by` onto a caller-supplied YAML document without
/// re-serializing it — comments and layout stay as the author wrote them.
/// Any existing top-level `_installed_by:` line is dropped first (re-uploading
/// an already-installed processor's file would otherwise carry a duplicate
/// key, which serde_yaml rejects on the next load), as is a trailing
/// document-end marker (`...`), after which no mapping content may follow.
pub(crate) fn stamp_installed_by(yaml: &str, installed_by: &str) -> String {
    let mut lines: Vec<&str> = yaml
        .lines()
        .filter(|line| !line.starts_with("_installed_by:"))
        .collect();
    while matches!(lines.last(), Some(l) if l.trim() == "..." || l.trim().is_empty()) {
        lines.pop();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out.push_str(&installed_by_line(installed_by));
    out.push('\n');
    out
}

// ---------------------------------------------------------------------------
// On-disk persistence (paths-based — the one place both commands/processors.rs
// and services/marketplace.rs's install flow write processor/pack YAML).
// ---------------------------------------------------------------------------

pub(crate) fn persist_processor_file(
    paths: &dyn AppPaths,
    id: &str,
    yaml: &str,
) -> Result<(), ServiceError> {
    let data_dir = paths.app_data_dir()?;
    let proc_dir = data_dir.join("processors");
    std::fs::create_dir_all(&proc_dir).map_err(|e| ServiceError::Internal(e.to_string()))?;
    let filename = marketplace::id_to_filename(id);
    // Defense-in-depth: `id` may be a qualified `id@source` string assembled
    // outside `validate_processor_id()` (marketplace install / auto-update),
    // so re-check the actual on-disk filename before writing.
    marketplace::ensure_filename_safe(&filename).map_err(ServiceError::invalid_arg)?;
    std::fs::write(proc_dir.join(format!("{filename}.yaml")), yaml)
        .map_err(|e| ServiceError::Internal(format!("Failed to persist processor: {e}")))
}

pub(crate) fn delete_processor_file(paths: &dyn AppPaths, id: &str) {
    if let Ok(data_dir) = paths.app_data_dir() {
        let filename = marketplace::id_to_filename(id);
        if marketplace::ensure_filename_safe(&filename).is_err() {
            return;
        }
        let _ = std::fs::remove_file(data_dir.join("processors").join(format!("{filename}.yaml")));
    }
}

pub(crate) fn persist_pack_file(paths: &dyn AppPaths, id: &str, yaml: &str) -> Result<(), ServiceError> {
    let data_dir = paths.app_data_dir()?;
    let packs_dir = data_dir.join("packs");
    std::fs::create_dir_all(&packs_dir).map_err(|e| ServiceError::Internal(e.to_string()))?;
    std::fs::write(packs_dir.join(format!("{id}.pack.yaml")), yaml)
        .map_err(|e| ServiceError::Internal(format!("Failed to persist pack: {e}")))
}

pub(crate) fn delete_pack_file(paths: &dyn AppPaths, id: &str) {
    if let Ok(data_dir) = paths.app_data_dir() {
        let _ = std::fs::remove_file(data_dir.join("packs").join(format!("{id}.pack.yaml")));
    }
}

// ---------------------------------------------------------------------------
// list / definition — read side
// ---------------------------------------------------------------------------

/// `ProcessorSummary` for every installed processor, annotated with its pack
/// (if any), builtins first then alphabetical — the shape `list_processors`
/// has always returned.
pub fn list(ctx: &ServiceCtx) -> Result<Vec<ProcessorSummary>, ServiceError> {
    let procs = lock_svc(&ctx.state().processors, "processors")?;
    let mut out: Vec<ProcessorSummary> = procs
        .iter()
        .map(|(key, p)| {
            let mut summary = ProcessorSummary::from(p);
            summary.id = key.clone();
            summary
        })
        .collect();
    drop(procs);

    let packs = lock_svc(&ctx.state().packs, "packs")?;
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

/// Extract the `sections` list from any processor kind — moved verbatim from
/// `mcp_bridge::routes::processors`.
fn extract_sections(p: &AnyProcessor) -> Vec<String> {
    match &p.kind {
        ProcessorKind::Reporter(def) => def.sections.clone(),
        ProcessorKind::StateTracker(def) => {
            let mut sections: Vec<String> = def
                .transitions
                .iter()
                .filter_map(|t| t.filter.section.clone())
                .collect();
            sections.sort();
            sections.dedup();
            sections
        }
        _ => Vec::new(),
    }
}

/// Extract `source_types` from the processor's schema contract.
fn extract_source_types(p: &AnyProcessor) -> &[String] {
    p.schema.as_ref().map_or(&[], |s| s.source_types.as_slice())
}

/// The `GET /mcp/processors` body — every installed processor's agent-facing
/// definition summary. Legacy ad hoc JSON, moved verbatim from
/// `mcp_bridge::routes::processors::h_processor_defs_list` so the wire shape
/// does not change (WP-13 is what eventually types this).
pub fn definitions(ctx: &ServiceCtx) -> Result<Value, ServiceError> {
    let procs = lock_svc(&ctx.state().processors, "processors")?;
    let processors: Vec<Value> = procs
        .iter()
        .map(|(qualified_id, p)| {
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
        })
        .collect();
    drop(procs);

    Ok(json!({
        "processorCount": processors.len(),
        "processors": processors,
    }))
}

/// The `GET /mcp/processors/{id}` body — one processor's full agent-facing
/// definition, including type-specific detail (filters/extracts/aggregations
/// for reporters, state fields for trackers, source ids for correlators).
/// Legacy ad hoc JSON, moved verbatim from
/// `mcp_bridge::routes::processors::h_processor_defs_single`.
pub fn definition(ctx: &ServiceCtx, processor_id: &str) -> Result<Value, ServiceError> {
    let procs = lock_svc(&ctx.state().processors, "processors")?;
    let resolved = resolve_processor_id_checked(&procs, processor_id).map_err(ServiceError::invalid_arg)?;
    let Some(p) = resolved.as_ref().and_then(|rid| procs.get(rid)) else {
        // Message text preserved verbatim from the pre-service
        // `h_processor_defs_single` — the bridge route folds `processor_id`
        // back into a sibling `processorId` field, not into this string.
        return Err(ServiceError::NotFound("processor not found".to_string()));
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
            let filters: Vec<Value> = def
                .pipeline
                .iter()
                .filter_map(|stage| {
                    use crate::processors::reporter::schema::PipelineStage;
                    match stage {
                        PipelineStage::Filter(fs) => {
                            let rules: Vec<String> = fs
                                .rules
                                .iter()
                                .map(|r| match r {
                                    crate::processors::reporter::schema::FilterRule::TagMatch { tags, .. } => {
                                        format!("tag_match: [{}]", tags.join(", "))
                                    }
                                    crate::processors::reporter::schema::FilterRule::MessageContains { value } => {
                                        format!("message_contains: \"{value}\"")
                                    }
                                    crate::processors::reporter::schema::FilterRule::MessageContainsAny { values } => {
                                        format!("message_contains_any: [{}]", values.join(", "))
                                    }
                                    crate::processors::reporter::schema::FilterRule::MessageRegex { pattern } => {
                                        format!("message_regex: \"{pattern}\"")
                                    }
                                    crate::processors::reporter::schema::FilterRule::LevelMin { level } => {
                                        format!("level_min: {level}")
                                    }
                                    crate::processors::reporter::schema::FilterRule::TimeRange { from, to, .. } => {
                                        format!("time_range: {from} - {to}")
                                    }
                                    crate::processors::reporter::schema::FilterRule::SourceTypeIs { source_type } => {
                                        format!("source_type_is: {source_type}")
                                    }
                                    crate::processors::reporter::schema::FilterRule::TagRegex { pattern } => {
                                        format!("tag_regex: \"{pattern}\"")
                                    }
                                    crate::processors::reporter::schema::FilterRule::SectionIs { section } => {
                                        format!("section_is: {section}")
                                    }
                                })
                                .collect();
                            Some(json!(rules))
                        }
                        _ => None,
                    }
                })
                .collect();

            let extracts: Vec<Value> = def
                .pipeline
                .iter()
                .filter_map(|stage| {
                    use crate::processors::reporter::schema::PipelineStage;
                    match stage {
                        PipelineStage::Extract(es) => {
                            let fields: Vec<Value> = es
                                .fields
                                .iter()
                                .map(|f| {
                                    json!({
                                        "name": f.name,
                                        "pattern": f.pattern,
                                        "cast": f.cast.as_ref().map(|c| format!("{c:?}").to_lowercase()),
                                    })
                                })
                                .collect();
                            Some(json!(fields))
                        }
                        _ => None,
                    }
                })
                .collect();

            let aggregations: Vec<String> = def
                .pipeline
                .iter()
                .filter_map(|stage| {
                    use crate::processors::reporter::schema::PipelineStage;
                    match stage {
                        PipelineStage::Aggregate(agg) => {
                            let types: Vec<String> =
                                agg.groups.iter().map(|g| format!("{:?}", g.agg_type).to_lowercase()).collect();
                            Some(types.join(", "))
                        }
                        _ => None,
                    }
                })
                .collect();

            let has_script = def
                .pipeline
                .iter()
                .any(|s| matches!(s, crate::processors::reporter::schema::PipelineStage::Script(_)));

            let vars: Vec<Value> = def
                .vars
                .iter()
                .map(|v| {
                    json!({
                        "name": v.name,
                        "type": format!("{:?}", v.var_type).to_lowercase(),
                        "display": v.display,
                        "label": v.label,
                    })
                })
                .collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("filters".to_string(), json!(filters));
            obj.insert("extracts".to_string(), json!(extracts));
            obj.insert("aggregations".to_string(), json!(aggregations));
            obj.insert("hasScript".to_string(), json!(has_script));
            obj.insert("vars".to_string(), json!(vars));
        }
        ProcessorKind::StateTracker(def) => {
            let state_fields: Vec<Value> = def
                .state
                .iter()
                .map(|f| {
                    json!({
                        "name": f.name,
                        "type": format!("{:?}", f.field_type).to_lowercase(),
                        "default": f.default,
                    })
                })
                .collect();

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
            // Minimal info already in base result.
        }
    }

    Ok(result)
}

/// `PackSummary` for every installed pack.
pub fn packs(ctx: &ServiceCtx) -> Result<Vec<PackSummary>, ServiceError> {
    let packs = lock_svc(&ctx.state().packs, "packs")?;
    Ok(packs.iter().map(PackSummary::from).collect())
}

// ---------------------------------------------------------------------------
// install / uninstall — processors
// ---------------------------------------------------------------------------

fn validate_and_install(ctx: &ServiceCtx, yaml: &str, mut processor: AnyProcessor) -> Result<ProcessorSummary, ServiceError> {
    crate::commands::processors::validate_processor(&processor).map_err(ServiceError::invalid_arg)?;
    // Raw installs (paste/upload/file) carry no provenance in the caller's
    // YAML — stamp who did it, same as a marketplace install's
    // `build_provenance_yaml` (`from_yaml` tolerates the unknown top-level
    // key on the next load, same as `_source`/`_installed_version`).
    let installed_by = caller_provenance(ctx.caller());
    let yaml_with_provenance = stamp_installed_by(yaml, &installed_by);
    persist_processor_file(ctx.paths(), &processor.meta.id, &yaml_with_provenance)?;
    processor.installed_by = Some(installed_by);
    let summary = ProcessorSummary::from(&processor);
    let mut procs = lock_svc(&ctx.state().processors, "processors")?;
    procs.insert(processor.meta.id.clone(), processor);
    Ok(summary)
}

/// Install a processor from a YAML string (paste, upload, or agent-supplied body).
pub fn install_yaml(ctx: &ServiceCtx, yaml: &str) -> Result<ProcessorSummary, ServiceError> {
    let processor = AnyProcessor::from_yaml(yaml).map_err(ServiceError::invalid_arg)?;
    let id = processor.meta.id.clone();
    let summary = validate_and_install(ctx, yaml, processor)?;
    ctx.journal("processor.install", None, format!("installed processor '{id}' from YAML"));
    emit_catalog_update(ctx, "install", vec![id]);
    Ok(summary)
}

/// Install a processor from a YAML file on disk. Agents go through
/// [`policy::authorize_open`] first — an agent installing a processor by path
/// is a filesystem read no different from opening a log file, and must be
/// gated the same way.
pub fn install_from_file(ctx: &ServiceCtx, path: &str) -> Result<ProcessorSummary, ServiceError> {
    let validated = policy::authorize_open(ctx, path)?;
    let yaml = std::fs::read_to_string(&validated)
        .map_err(|e| ServiceError::invalid_arg(format!("Cannot read file: {e}")))?;
    let processor = AnyProcessor::from_yaml(&yaml).map_err(ServiceError::invalid_arg)?;
    let id = processor.meta.id.clone();
    let summary = validate_and_install(ctx, &yaml, processor)?;
    ctx.journal("processor.install", None, format!("installed processor '{id}' from file"));
    emit_catalog_update(ctx, "install", vec![id]);
    Ok(summary)
}

/// Uninstall an installed processor. Built-ins (`__`-prefixed) are refused.
pub fn uninstall(ctx: &ServiceCtx, processor_id: &str) -> Result<(), ServiceError> {
    if processor_id.starts_with("__") {
        return Err(ServiceError::invalid_arg("Built-in processors cannot be uninstalled"));
    }
    let mut procs = lock_svc(&ctx.state().processors, "processors")?;
    if procs.remove(processor_id).is_none() {
        return Err(ServiceError::NotFound(format!("Processor '{processor_id}' not found")));
    }
    drop(procs);
    delete_processor_file(ctx.paths(), processor_id);
    ctx.journal("processor.uninstall", None, format!("uninstalled processor '{processor_id}'"));
    emit_catalog_update(ctx, "uninstall", vec![processor_id.to_string()]);
    Ok(())
}

// ---------------------------------------------------------------------------
// install / uninstall — packs
// ---------------------------------------------------------------------------

/// Install a pack manifest from a YAML string, under the given pack id.
pub fn install_pack_yaml(ctx: &ServiceCtx, pack_id: &str, yaml: &str) -> Result<PackSummary, ServiceError> {
    if pack_id.trim().is_empty() {
        return Err(ServiceError::invalid_arg("pack_id must not be empty"));
    }
    let mut pack = crate::processors::pack::parse_pack_yaml(yaml).map_err(ServiceError::invalid_arg)?;
    pack.id = pack_id.to_string();
    crate::processors::pack::validate_pack(&pack).map_err(ServiceError::invalid_arg)?;
    persist_pack_file(ctx.paths(), &pack.id, yaml)?;
    let summary = PackSummary::from(&pack);
    upsert_pack(ctx, pack)?;
    ctx.journal("pack.install", None, format!("installed pack '{pack_id}' from YAML"));
    emit_catalog_update(ctx, "install", vec![pack_id.to_string()]);
    Ok(summary)
}

/// Install a pack manifest from a `.pack.yaml` file on disk — the pack id is
/// derived from the filename. Agents go through [`policy::authorize_open`].
pub fn load_pack_from_file(ctx: &ServiceCtx, path: &str) -> Result<PackSummary, ServiceError> {
    let validated = policy::authorize_open(ctx, path)?;
    let yaml = std::fs::read_to_string(&validated)
        .map_err(|e| ServiceError::invalid_arg(format!("Cannot read file: {e}")))?;
    let id = crate::processors::pack::pack_id_from_path(&validated).ok_or_else(|| {
        ServiceError::invalid_arg("File must have a '.pack.yaml' extension to be loaded as a pack")
    })?;
    let mut pack: PackMeta = crate::processors::pack::parse_pack_yaml(&yaml).map_err(ServiceError::invalid_arg)?;
    pack.id = id.clone();
    crate::processors::pack::validate_pack(&pack).map_err(ServiceError::invalid_arg)?;
    persist_pack_file(ctx.paths(), &pack.id, &yaml)?;
    let summary = PackSummary::from(&pack);
    upsert_pack(ctx, pack)?;
    ctx.journal("pack.install", None, format!("installed pack '{id}' from file"));
    emit_catalog_update(ctx, "install", vec![id]);
    Ok(summary)
}

/// Uninstall a pack manifest. Unlike marketplace pack uninstall, this leaves
/// the pack's member processors installed — it only removes the manifest
/// (matches the pre-existing `uninstall_pack` command's behavior).
pub fn uninstall_pack(ctx: &ServiceCtx, pack_id: &str) -> Result<(), ServiceError> {
    let mut packs = lock_svc(&ctx.state().packs, "packs")?;
    let before = packs.len();
    packs.retain(|p| p.id != pack_id);
    if packs.len() == before {
        return Err(ServiceError::NotFound(format!("Pack '{pack_id}' not found")));
    }
    drop(packs);
    delete_pack_file(ctx.paths(), pack_id);
    ctx.journal("pack.uninstall", None, format!("uninstalled pack '{pack_id}'"));
    emit_catalog_update(ctx, "uninstall", vec![pack_id.to_string()]);
    Ok(())
}

pub(crate) fn upsert_pack(ctx: &ServiceCtx, pack: PackMeta) -> Result<(), ServiceError> {
    let mut packs = lock_svc(&ctx.state().packs, "packs")?;
    if let Some(existing) = packs.iter_mut().find(|p| p.id == pack.id) {
        *existing = pack;
    } else {
        packs.push(pack);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use crate::services::Caller;

    const MINIMAL_REPORTER: &str = r#"
meta:
  id: test-reporter
  name: Test Reporter
  version: 1.0.0
"#;

    const MINIMAL_PACK: &str = r#"
name: Test Pack
version: 1.0.0
processors:
  - test-reporter
"#;

    fn install_test_processor(ctx: &ServiceCtx, id: &str) {
        let mut procs = ctx.state().processors.lock().unwrap();
        procs.insert(id.to_string(), AnyProcessor::from_yaml(MINIMAL_REPORTER).unwrap());
    }

    #[test]
    fn list_returns_installed_processors_with_pack_annotations() {
        let (ctx, _tmp) = test_ctx().build();
        install_test_processor(&ctx, "test-reporter");
        {
            let mut packs = ctx.state().packs.lock().unwrap();
            let mut pack: PackMeta = crate::processors::pack::parse_pack_yaml(MINIMAL_PACK).unwrap();
            pack.id = "test-pack".to_string();
            packs.push(pack);
        }
        let out = list(&ctx).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "test-reporter");
        assert_eq!(out[0].pack_id.as_deref(), Some("test-pack"));
    }

    #[test]
    fn definitions_lists_every_installed_processor_by_qualified_id() {
        let (ctx, _tmp) = test_ctx().build();
        install_test_processor(&ctx, "test-reporter@official");
        let body = definitions(&ctx).unwrap();
        assert_eq!(body["processorCount"], json!(1));
        assert_eq!(body["processors"][0]["id"], json!("test-reporter@official"));
        assert_eq!(body["processors"][0]["processorType"], json!("reporter"));
    }

    #[test]
    fn definition_resolves_bare_id_and_reports_reporter_detail() {
        let (ctx, _tmp) = test_ctx().build();
        install_test_processor(&ctx, "test-reporter@official");
        let body = definition(&ctx, "test-reporter").unwrap();
        // Legacy behavior, preserved verbatim: `id` is the processor's own
        // `meta.id` (from its YAML), not the qualified store key resolved to
        // find it — that quirk predates this service and callers rely on it.
        assert_eq!(body["id"], json!("test-reporter"));
        assert!(body.get("filters").is_some());
        assert!(body.get("vars").is_some());
    }

    #[test]
    fn definition_on_unknown_id_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = definition(&ctx, "nope").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn install_yaml_persists_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        let summary = install_yaml(&ctx, MINIMAL_REPORTER).unwrap();
        assert_eq!(summary.id, "test-reporter");
        assert!(ctx.state().processors.lock().unwrap().contains_key("test-reporter"));
        let yaml_path = ctx
            .paths()
            .app_data_dir()
            .unwrap()
            .join("processors")
            .join("test-reporter.yaml");
        assert!(yaml_path.exists(), "processor YAML must be persisted to disk");
        let events = sink.events_named("activity");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["action"], json!("processor.install"));
    }

    #[test]
    fn install_from_file_for_ui_reads_the_given_path() {
        let (ctx, _tmp) = test_ctx().build();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), MINIMAL_REPORTER).unwrap();
        let summary = install_from_file(&ctx, &file.path().to_string_lossy()).unwrap();
        assert_eq!(summary.id, "test-reporter");
    }

    #[test]
    fn install_from_file_for_agent_outside_allowlist_is_forbidden() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), MINIMAL_REPORTER).unwrap();
        let err = install_from_file(&ctx, &file.path().to_string_lossy()).unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn uninstall_removes_from_state_and_disk() {
        let (ctx, _tmp) = test_ctx().build();
        install_yaml(&ctx, MINIMAL_REPORTER).unwrap();
        uninstall(&ctx, "test-reporter").unwrap();
        assert!(!ctx.state().processors.lock().unwrap().contains_key("test-reporter"));
        let yaml_path = ctx
            .paths()
            .app_data_dir()
            .unwrap()
            .join("processors")
            .join("test-reporter.yaml");
        assert!(!yaml_path.exists());
    }

    #[test]
    fn uninstall_refuses_builtins() {
        let (ctx, _tmp) = test_ctx().build();
        let err = uninstall(&ctx, "__pii_anonymizer").unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn uninstall_on_unknown_id_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = uninstall(&ctx, "nope").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn packs_lists_installed_packs() {
        let (ctx, _tmp) = test_ctx().build();
        install_pack_yaml(&ctx, "test-pack", MINIMAL_PACK).unwrap();
        let out = packs(&ctx).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "test-pack");
        assert_eq!(out[0].processor_ids, vec!["test-reporter"]);
    }

    #[test]
    fn install_pack_yaml_rejects_empty_id() {
        let (ctx, _tmp) = test_ctx().build();
        let err = install_pack_yaml(&ctx, "", MINIMAL_PACK).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn uninstall_pack_removes_manifest_but_not_processors() {
        let (ctx, _tmp) = test_ctx().build();
        install_test_processor(&ctx, "test-reporter");
        install_pack_yaml(&ctx, "test-pack", MINIMAL_PACK).unwrap();
        uninstall_pack(&ctx, "test-pack").unwrap();
        assert!(packs(&ctx).unwrap().is_empty());
        assert!(ctx.state().processors.lock().unwrap().contains_key("test-reporter"));
    }

    #[test]
    fn uninstall_pack_on_unknown_id_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = uninstall_pack(&ctx, "nope").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn a_ui_caller_may_install_and_an_agent_caller_may_too() {
        // Installing a processor is not a gate-widening mutation (unlike
        // marketplace source management) — both callers may do it.
        let (ui, _t1) = test_ctx().build();
        assert!(install_yaml(&ui, MINIMAL_REPORTER).is_ok());

        let (agent, _t2) = test_ctx().agent("claude-code").build();
        assert!(install_yaml(&agent, MINIMAL_REPORTER).is_ok());
        assert_eq!(*agent.caller(), Caller::agent("claude-code"));
    }

    // -----------------------------------------------------------------------
    // B2: catalog-update event + installed_by provenance
    // -----------------------------------------------------------------------

    #[test]
    fn every_processor_pack_mutation_emits_one_catalog_update() {
        struct Case {
            label: &'static str,
            action: &'static str,
            ids: Vec<&'static str>,
            /// Pre-installs whatever the measured action needs to already
            /// exist (uninstall targets). Its own events are cleared from the
            /// sink before `act` runs, so only `act`'s emission is asserted.
            setup: Box<dyn Fn(&ServiceCtx)>,
            act: Box<dyn Fn(&ServiceCtx)>,
        }

        fn no_setup(_ctx: &ServiceCtx) {}

        let cases: Vec<Case> = vec![
            Case {
                label: "install_yaml",
                action: "install",
                ids: vec!["test-reporter"],
                setup: Box::new(no_setup),
                act: Box::new(|ctx| {
                    install_yaml(ctx, MINIMAL_REPORTER).unwrap();
                }),
            },
            Case {
                label: "install_from_file",
                action: "install",
                ids: vec!["test-reporter"],
                setup: Box::new(no_setup),
                act: Box::new(|ctx| {
                    let file = tempfile::NamedTempFile::new().unwrap();
                    std::fs::write(file.path(), MINIMAL_REPORTER).unwrap();
                    install_from_file(ctx, &file.path().to_string_lossy()).unwrap();
                }),
            },
            Case {
                label: "uninstall",
                action: "uninstall",
                ids: vec!["test-reporter"],
                setup: Box::new(|ctx| {
                    install_yaml(ctx, MINIMAL_REPORTER).unwrap();
                }),
                act: Box::new(|ctx| {
                    uninstall(ctx, "test-reporter").unwrap();
                }),
            },
            Case {
                label: "install_pack_yaml",
                action: "install",
                ids: vec!["test-pack"],
                setup: Box::new(no_setup),
                act: Box::new(|ctx| {
                    install_pack_yaml(ctx, "test-pack", MINIMAL_PACK).unwrap();
                }),
            },
            Case {
                label: "load_pack_from_file",
                action: "install",
                ids: vec!["test-pack-file"],
                setup: Box::new(no_setup),
                act: Box::new(|ctx| {
                    let dir = tempfile::tempdir().unwrap();
                    let path = dir.path().join("test-pack-file.pack.yaml");
                    std::fs::write(&path, MINIMAL_PACK).unwrap();
                    load_pack_from_file(ctx, &path.to_string_lossy()).unwrap();
                }),
            },
            Case {
                label: "uninstall_pack",
                action: "uninstall",
                ids: vec!["test-pack"],
                setup: Box::new(|ctx| {
                    install_pack_yaml(ctx, "test-pack", MINIMAL_PACK).unwrap();
                }),
                act: Box::new(|ctx| {
                    uninstall_pack(ctx, "test-pack").unwrap();
                }),
            },
        ];

        for case in cases {
            let (ctx, sink, _tmp) = test_ctx().build_recording();
            (case.setup)(&ctx);
            sink.clear();
            (case.act)(&ctx);
            let events = sink.events_named("catalog-update");
            assert_eq!(events.len(), 1, "case '{}' should emit exactly one catalog-update", case.label);
            assert_eq!(events[0].payload["action"], json!(case.action), "case '{}'", case.label);
            assert_eq!(events[0].payload["ids"], json!(case.ids), "case '{}'", case.label);
        }
    }

    #[test]
    fn install_yaml_stamps_agent_installed_by_provenance() {
        let (ctx, tmp) = test_ctx().agent("claude").build();
        let summary = install_yaml(&ctx, MINIMAL_REPORTER).unwrap();
        assert_eq!(summary.installed_by.as_deref(), Some("agent:claude"));

        let yaml_path = tmp.path().join("processors").join("test-reporter.yaml");
        let persisted = std::fs::read_to_string(&yaml_path).unwrap();
        let prov: crate::processors::marketplace::Provenance = serde_yaml::from_str(&persisted).unwrap();
        assert_eq!(prov.installed_by.as_deref(), Some("agent:claude"));
    }

    #[test]
    fn install_yaml_stamps_ui_installed_by_provenance() {
        let (ctx, _tmp) = test_ctx().build();
        let summary = install_yaml(&ctx, MINIMAL_REPORTER).unwrap();
        assert_eq!(summary.installed_by.as_deref(), Some("ui"));
    }

    #[test]
    fn reinstalling_an_already_stamped_yaml_replaces_the_key_instead_of_duplicating_it() {
        // A user copies an installed processor's file back out of the data dir
        // (it now carries `_installed_by: ui`) and re-installs it from an agent.
        let (ctx, tmp) = test_ctx().agent("claude").build();
        install_yaml(&ctx, MINIMAL_REPORTER).unwrap();
        let yaml_path = tmp.path().join("processors").join("test-reporter.yaml");
        let exported = std::fs::read_to_string(&yaml_path).unwrap();
        assert!(exported.contains("_installed_by: agent:claude"));

        let (ctx2, tmp2) = test_ctx().build();
        install_yaml(&ctx2, &format!("{exported}...\n")).unwrap();
        let persisted = std::fs::read_to_string(tmp2.path().join("processors").join("test-reporter.yaml")).unwrap();
        assert_eq!(persisted.matches("_installed_by:").count(), 1, "one key, not a duplicate");
        assert!(!persisted.contains("\n..."), "the document-end marker is dropped so the key still parses");
        // The persisted text must load as a processor again — a duplicate key
        // or content after `...` would make `from_yaml` reject it at startup.
        AnyProcessor::from_yaml(&persisted).expect("re-stamped YAML still parses");
        let prov: crate::processors::marketplace::Provenance = serde_yaml::from_str(&persisted).unwrap();
        assert_eq!(prov.installed_by.as_deref(), Some("ui"));
    }

    #[test]
    fn a_hostile_client_name_cannot_corrupt_the_persisted_yaml() {
        let (ctx, tmp) = test_ctx().agent("a: b #c").build();
        install_yaml(&ctx, MINIMAL_REPORTER).unwrap();
        let persisted = std::fs::read_to_string(tmp.path().join("processors").join("test-reporter.yaml")).unwrap();
        AnyProcessor::from_yaml(&persisted).expect("quoted value keeps the document valid");
        let prov: crate::processors::marketplace::Provenance = serde_yaml::from_str(&persisted).unwrap();
        assert_eq!(prov.installed_by.as_deref(), Some("agent:a: b #c"));
    }
}
