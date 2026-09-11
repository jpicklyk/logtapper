//! Thin Tauri adapters over `services::settings`. Each command builds a
//! [`crate::commands::adapters::ui_ctx`], calls one service function, and
//! marshals the `Result<T, ServiceError>` into the `Result<T, String>` the
//! frontend expects.
//!
//! The `AnonymizerTestResult` / `PiiReplacement` wire types, and the
//! anonymizer-config persistence logic, moved to `services::settings` (WP-12)
//! — nothing anonymizer-specific is defined in this file any more.

use std::collections::HashMap;

use tauri::AppHandle;

use crate::anonymizer::config::AnonymizerConfig;
use crate::commands::adapters::ui_ctx;
use crate::services::settings::{self, AnonymizerTestResult};

/// Read the current anonymizer configuration.
#[tauri::command]
pub fn get_anonymizer_config(app: AppHandle) -> Result<AnonymizerConfig, String> {
    let ctx = ui_ctx(&app);
    Ok(settings::anonymizer_config(&ctx)?)
}

/// Replace the anonymizer configuration and persist it to disk.
#[tauri::command]
pub fn set_anonymizer_config(app: AppHandle, config: AnonymizerConfig) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    Ok(settings::set_anonymizer_config(&ctx, config)?)
}

/// Preview what the current anonymizer configuration would redact in `text`.
#[tauri::command]
pub fn test_anonymizer(app: AppHandle, text: String) -> Result<AnonymizerTestResult, String> {
    let ctx = ui_ctx(&app);
    Ok(settings::test_anonymizer(&ctx, text)?)
}

/// The token -> original-value map accumulated for `session_id`.
#[tauri::command]
pub fn get_pii_mappings(app: AppHandle, session_id: String) -> Result<HashMap<String, String>, String> {
    let ctx = ui_ctx(&app);
    Ok(settings::pii_mappings(&ctx, &session_id)?)
}
