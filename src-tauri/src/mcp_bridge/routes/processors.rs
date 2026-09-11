//! Processor + marketplace endpoints: definitions (legacy JSON, unchanged),
//! and the WP-9 install/uninstall/packs/sources/updates surface.
//!
//! `h_processor_defs_list` / `h_processor_defs_single` call
//! [`crate::services::processors::{definitions, definition}`] — the exact
//! ad hoc JSON they used to build inline, now owned by the service so the
//! Tauri-side `list_processors` command and the bridge cannot drift on
//! *how* a processor is described (WP-13 is what eventually types this).
//!
//! Everything below `// WP-9` is new surface: it returns typed structs
//! directly and renders `ServiceError` through the bridge's existing
//! `{ error, code }` envelope (the same shape `h_open_file` already uses),
//! rather than the legacy `{ error }`-only, always-200 shape older routes
//! still use.

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::err;
use crate::mcp_bridge::routes::artifacts::client_name;
use crate::processors::marketplace::MarketplacePackEntry;
use crate::processors::{PackSummary, ProcessorSummary};
use crate::services::error::ServiceError;
use crate::services::{marketplace, processors};

/// Render a [`ServiceError`] through the `{ error, code }` envelope with its
/// real HTTP status — the contract every WP-9 route below uses.
fn service_err(e: ServiceError) -> Response {
    let status = StatusCode::from_u16(e.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    err(status, e.message(), e.code())
}

// ---------------------------------------------------------------------------
// GET /mcp/processors — list all processor definitions (legacy shape)
// ---------------------------------------------------------------------------

pub(crate) async fn h_processor_defs_list(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match processors::definitions(&svc) {
        Ok(body) => Json(body),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/processors/{processor_id} — single processor definition (legacy shape)
// ---------------------------------------------------------------------------

pub(crate) async fn h_processor_defs_single(
    State(ctx): State<BridgeCtx>,
    Path(processor_id): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match processors::definition(&svc, &processor_id) {
        Ok(body) => Json(body),
        Err(e) => Json(json!({ "error": e.message(), "processorId": processor_id })),
    }
}

// ---------------------------------------------------------------------------
// WP-9 processors/marketplace — new surface
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct InstallProcessorBody {
    yaml: String,
}

/// `POST /mcp/processors/install` — install a processor from a YAML body.
pub(crate) async fn h_install_processor(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(body): Json<InstallProcessorBody>,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match processors::install_yaml(&svc, &body.yaml) {
        Ok(summary) => Json(summary).into_response(),
        Err(e) => service_err(e),
    }
}

/// `DELETE /mcp/processors/{id}` — uninstall an installed processor.
pub(crate) async fn h_uninstall_processor(
    State(ctx): State<BridgeCtx>,
    Path(processor_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match processors::uninstall(&svc, &processor_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => service_err(e),
    }
}

/// `GET /mcp/packs` — every installed processor pack.
pub(crate) async fn h_packs(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match processors::packs(&svc) {
        Ok(list) => Json(list).into_response(),
        Err(e) => service_err(e),
    }
}

/// `GET /mcp/marketplace/sources` — configured marketplace sources.
///
/// Read-only. There is deliberately no route to add or remove a source: a
/// marketplace source is a supply-chain surface (it's where every future
/// processor install's *code* comes from), and
/// `services::marketplace::{add_source, remove_source}` refuse an agent
/// caller (`Forbidden`/`NOT_ALLOWED`) — see that module's doc comment. Since
/// an agent could never succeed at either mutation, no route exposes them.
pub(crate) async fn h_marketplace_sources(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match marketplace::sources(&svc) {
        Ok(list) => Json(list).into_response(),
        Err(e) => service_err(e),
    }
}

/// `GET /mcp/marketplace/sources/{id}/fetch` — fetch one source's marketplace index.
pub(crate) async fn h_marketplace_fetch(
    State(ctx): State<BridgeCtx>,
    Path(source_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match marketplace::fetch(&svc, &source_id).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => service_err(e),
    }
}

/// `GET /mcp/marketplace/updates` — check every enabled source for updates.
pub(crate) async fn h_marketplace_updates(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match marketplace::check_updates(&svc).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => service_err(e),
    }
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
    Json(body): Json<MarketplaceInstallBody>,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match (body.entry, body.pack) {
        (Some(entry), None) => {
            match marketplace::install_from_marketplace(
                &svc,
                &body.source_name,
                &entry.id,
                &entry.name,
                &entry.path,
                &entry.version,
                &entry.sha256,
            )
            .await
            {
                Ok(summary) => Json(MarketplaceInstallResult::Processor(summary)).into_response(),
                Err(e) => service_err(e),
            }
        }
        (None, Some(pack)) => match marketplace::install_pack_from_marketplace(&svc, &body.source_name, pack).await {
            Ok(summary) => Json(MarketplaceInstallResult::Pack(summary)).into_response(),
            Err(e) => service_err(e),
        },
        (None, None) => service_err(ServiceError::invalid_arg("body must include either 'entry' or 'pack'")),
        (Some(_), Some(_)) => {
            service_err(ServiceError::invalid_arg("body must include only one of 'entry' or 'pack', not both"))
        }
    }
}

/// `POST /mcp/marketplace/update_all/{source_id}` — update every outdated
/// processor installed from one source.
pub(crate) async fn h_marketplace_update_all(
    State(ctx): State<BridgeCtx>,
    Path(source_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match marketplace::update_all_from_source(&svc, &source_id).await {
        Ok(results) => Json(results).into_response(),
        Err(e) => service_err(e),
    }
}
