//! Thin Tauri adapters over `services::filters`, plus `FilterProgress`, the
//! `filter-progress` event payload shape.
//!
//! `FilterProgress` is no longer constructed anywhere — the scan
//! (`services::filters::scan_filter_background`) reports through
//! `services::events::FilterProgressEvent` instead, which
//! `commands::adapters::TauriProgressSink` emits under the very same
//! `"filter-progress"` event name with a byte-identical field set (see the
//! shared name/shape test in `services::events`). This struct is kept purely
//! so the TS binding `src-next/bridge/events.ts` already imports (`import type
//! { ... FilterProgress ... } from './types'`) keeps resolving without
//! touching `src-next/`, which is out of scope for this package.

use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use ts_rs::TS;

use crate::commands::adapters::{ui_ctx, TauriProgressSink};
use crate::core::filter::FilterCriteria;
use crate::services::events::ProgressSink;
use crate::services::filters::{self, FilterCreateResult, FilterInfo, FilteredLinesResult};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilterProgress {
    pub filter_id: String,
    pub matched_so_far: usize,
    pub lines_scanned: usize,
    pub total_lines: usize,
    pub done: bool,
}

/// Create a filter on `session_id` and spawn its background scan. Returns
/// immediately with the snapshot `total_lines` — the scan continues after
/// this call returns, reporting progress via the `filter-progress` event.
///
/// See `services::filters` for the full snapshot-semantics contract: lines
/// arriving after this call (e.g. new ADB batches) are never covered by this
/// filter.
#[tauri::command]
pub async fn create_filter(
    app: AppHandle,
    session_id: String,
    criteria: FilterCriteria,
) -> Result<FilterCreateResult, String> {
    let ctx = ui_ctx(&app);
    let progress: Arc<dyn ProgressSink> = Arc::new(TauriProgressSink::new(app));
    Ok(filters::create(&ctx, session_id, criteria, progress)?)
}

/// A page of a filter's matched lines so far. Safe to call while the
/// background scan is still running.
#[tauri::command]
pub fn get_filtered_lines(
    app: AppHandle,
    filter_id: String,
    offset: usize,
    count: usize,
) -> Result<FilteredLinesResult, String> {
    let ctx = ui_ctx(&app);
    Ok(filters::lines(&ctx, &filter_id, offset, count)?)
}

/// Stop a filter's background scan early. The filter stays registered —
/// only `close_filter` removes it.
#[tauri::command]
pub fn cancel_filter(app: AppHandle, filter_id: String) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    filters::cancel(&ctx, &filter_id)?;
    Ok(())
}

/// Lifecycle + progress snapshot of a filter (`scanning` | `complete` |
/// `cancelled`, lines scanned so far, total matches).
#[tauri::command]
pub fn get_filter_info(app: AppHandle, filter_id: String) -> Result<FilterInfo, String> {
    let ctx = ui_ctx(&app);
    Ok(filters::info(&ctx, &filter_id)?)
}

/// Remove a filter from the registry, cancelling its scan first if still
/// running. Closing an unknown/already-closed id is not an error.
#[tauri::command]
pub fn close_filter(app: AppHandle, filter_id: String) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    filters::close(&ctx, &filter_id)?;
    Ok(())
}
