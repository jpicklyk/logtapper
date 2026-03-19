use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

use crate::anonymizer::{config::AnonymizerConfig, LogAnonymizer};
use crate::commands::{lock_or_err, AppState};

// ---------------------------------------------------------------------------
// Test result types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiiReplacement {
    pub token: String,
    pub original: String,
    pub category: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnonymizerTestResult {
    pub anonymized: String,
    pub replacements: Vec<PiiReplacement>,
}

// ---------------------------------------------------------------------------
// get_anonymizer_config
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_anonymizer_config(
    state: State<'_, AppState>,
) -> Result<AnonymizerConfig, String> {
    let config = lock_or_err(&state.anonymizer_config, "anonymizer_config")?;
    Ok(config.clone())
}

// ---------------------------------------------------------------------------
// set_anonymizer_config
// ---------------------------------------------------------------------------

fn persist_anonymizer_config(app: &AppHandle, config: &AnonymizerConfig) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join("anonymizer_config.json"), json)
        .map_err(|e| format!("Failed to persist anonymizer config: {e}"))
}

#[tauri::command]
pub async fn set_anonymizer_config(
    state: State<'_, AppState>,
    app: AppHandle,
    config: AnonymizerConfig,
) -> Result<(), String> {
    persist_anonymizer_config(&app, &config)?;
    let mut stored = lock_or_err(&state.anonymizer_config, "anonymizer_config")?;
    *stored = config;
    Ok(())
}

// ---------------------------------------------------------------------------
// test_anonymizer
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn test_anonymizer(
    state: State<'_, AppState>,
    text: String,
) -> Result<AnonymizerTestResult, String> {
    let config = {
        let c = lock_or_err(&state.anonymizer_config, "anonymizer_config")?;
        c.clone()
    };

    let anon = LogAnonymizer::from_config(&config);
    let (anonymized, spans) = anon.anonymize(&text);

    let mut replacements = Vec::with_capacity(spans.len());
    for span in spans {
        let token = anonymized[span.start..span.end].to_string();
        let original = anon.mappings.reveal(&token).unwrap_or_default();
        // Parse category from token: "<EMAIL-1>" → "EMAIL"
        let category = token
            .trim_start_matches('<')
            .split('-')
            .next()
            .unwrap_or("PII")
            .to_string();
        replacements.push(PiiReplacement {
            token,
            original,
            category,
            start: span.start,
            end: span.end,
        });
    }

    Ok(AnonymizerTestResult { anonymized, replacements })
}

// ---------------------------------------------------------------------------
// get_pii_mappings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_pii_mappings(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<HashMap<String, String>, String> {
    let mappings = state
        .pii_mappings
        .lock()
        .map_err(|_| "lock poisoned")?;
    Ok(mappings.get(&session_id).cloned().unwrap_or_default())
}
