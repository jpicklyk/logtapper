//! Processor + marketplace endpoints: definitions, and the WP-9
//! install/uninstall/packs/sources/updates surface.
//!
//! `h_processor_defs_list` / `h_processor_defs_single` call
//! [`crate::services::processors::{definitions, definition}`], which own the
//! processor-description JSON so the Tauri-side `list_processors` command and
//! the bridge cannot drift on *how* a processor is described. Those two are the
//! only bridge responses still typed as `serde_json::Value`: the shape is
//! assembled inside the service from a processor's YAML-derived schema, which
//! is genuinely heterogeneous (reporter pipelines, tracker state machines,
//! correlator windows). Typing it belongs with whoever next owns
//! `services/processors.rs` — it is not something this package can do from the
//! route side. Every other route in this file answers with a `Serialize`
//! struct.
//!
//! Errors are [`ServiceError`] throughout: `404 NOT_FOUND` for an unknown
//! processor, `403 NOT_ALLOWED` for a gated path, `400` for a malformed body.

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::sources::{MarketplaceFetchResult, UpdateCheckResult, UpdateResult};
use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, client_name};
use crate::processors::marketplace::{MarketplacePackEntry, Source};
use crate::processors::{PackSummary, ProcessorSummary};
use crate::services::error::ServiceError;
use crate::services::wire::Ack;
use crate::services::{marketplace, processors};

// ---------------------------------------------------------------------------
// GET /mcp/processors — list all processor definitions
// ---------------------------------------------------------------------------

pub(crate) async fn h_processor_defs_list(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<Value>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(processors::definitions(&svc)?))
}

// ---------------------------------------------------------------------------
// GET /mcp/processors/{processor_id} — single processor definition
// ---------------------------------------------------------------------------

pub(crate) async fn h_processor_defs_single(
    State(ctx): State<BridgeCtx>,
    Path(processor_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(processors::definition(&svc, &processor_id)?))
}

// ---------------------------------------------------------------------------
// WP-9 processors/marketplace
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct InstallProcessorBody {
    yaml: String,
}

/// `POST /mcp/processors/install` — install a processor from a YAML body.
pub(crate) async fn h_install_processor(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<InstallProcessorBody>,
) -> Result<Json<ProcessorSummary>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(processors::install_yaml(&svc, &body.yaml)?))
}

/// `DELETE /mcp/processors/{id}` — uninstall an installed processor.
pub(crate) async fn h_uninstall_processor(
    State(ctx): State<BridgeCtx>,
    Path(processor_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    processors::uninstall(&svc, &processor_id)?;
    Ok(Json(Ack::ok()))
}

/// `GET /mcp/packs` — every installed processor pack.
pub(crate) async fn h_packs(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<Vec<PackSummary>>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(processors::packs(&svc)?))
}

/// `GET /mcp/marketplace/sources` — configured marketplace sources.
///
/// Read-only. There is deliberately no route to add or remove a source: a
/// marketplace source is a supply-chain surface (it's where every future
/// processor install's *code* comes from), and
/// `services::marketplace::{add_source, remove_source}` refuse an agent
/// caller (`Forbidden`/`NOT_ALLOWED`) — see that module's doc comment. Since
/// an agent could never succeed at either mutation, no route exposes them.
pub(crate) async fn h_marketplace_sources(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<Vec<Source>>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(marketplace::sources(&svc)?))
}

/// `GET /mcp/marketplace/sources/{id}/fetch` — fetch one source's marketplace index.
pub(crate) async fn h_marketplace_fetch(
    State(ctx): State<BridgeCtx>,
    Path(source_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MarketplaceFetchResult>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(marketplace::fetch(&svc, &source_id).await?))
}

/// `GET /mcp/marketplace/updates` — check every enabled source for updates.
pub(crate) async fn h_marketplace_updates(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<UpdateCheckResult>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(marketplace::check_updates(&svc).await?))
}

/// Either a single marketplace entry or a pack entry — a
/// `POST /mcp/marketplace/install` body names exactly one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketplaceInstallBody {
    source_name: String,
    #[serde(default)]
    entry: Option<MarketplaceEntryInstall>,
    #[serde(default)]
    pack: Option<MarketplacePackEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketplaceEntryInstall {
    id: String,
    name: String,
    path: String,
    version: String,
    #[serde(default)]
    sha256: String,
}

/// Either result shape `POST /mcp/marketplace/install` can produce, depending
/// on whether the body named a processor `entry` or a `pack`.
#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum MarketplaceInstallResult {
    Processor(ProcessorSummary),
    Pack(PackSummary),
}

/// `POST /mcp/marketplace/install` — install a processor or a pack from a
/// named marketplace source. The body names exactly one of `entry` / `pack`.
pub(crate) async fn h_marketplace_install(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<MarketplaceInstallBody>,
) -> Result<Json<MarketplaceInstallResult>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    match (body.entry, body.pack) {
        (Some(entry), None) => {
            let summary = marketplace::install_from_marketplace(
                &svc,
                &body.source_name,
                &entry.id,
                &entry.name,
                &entry.path,
                &entry.version,
                &entry.sha256,
            )
            .await?;
            Ok(Json(MarketplaceInstallResult::Processor(summary)))
        }
        (None, Some(pack)) => {
            let summary =
                marketplace::install_pack_from_marketplace(&svc, &body.source_name, pack).await?;
            Ok(Json(MarketplaceInstallResult::Pack(summary)))
        }
        (None, None) => Err(ServiceError::invalid_arg(
            "body must include either 'entry' or 'pack'",
        )),
        (Some(_), Some(_)) => Err(ServiceError::invalid_arg(
            "body must include only one of 'entry' or 'pack', not both",
        )),
    }
}

/// `POST /mcp/marketplace/update_all/{source_id}` — update every outdated
/// processor installed from one source.
pub(crate) async fn h_marketplace_update_all(
    State(ctx): State<BridgeCtx>,
    Path(source_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<UpdateResult>>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(marketplace::update_all_from_source(&svc, &source_id).await?))
}
