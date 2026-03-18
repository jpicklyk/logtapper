use tauri::{AppHandle, State};

use crate::claude::analysis::build_analysis_context;
use crate::claude::client::ClaudeClient;
use crate::claude::generator::{build_generator_prompt, extract_yaml};
use crate::commands::AppState;
use crate::processors::AnyProcessor;
use crate::scripting::sandbox::validate_for_install;

// ---------------------------------------------------------------------------
// set_claude_api_key — store the API key in memory
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn set_claude_api_key(
    state: State<'_, AppState>,
    api_key: String,
) -> Result<(), String> {
    let mut key = state
        .api_key
        .lock()
        .map_err(|_| "API key store lock poisoned")?;
    *key = if api_key.trim().is_empty() {
        None
    } else {
        Some(api_key.trim().to_string())
    };
    Ok(())
}

// ---------------------------------------------------------------------------
// claude_analyze — stream analysis of log data back to frontend
// ---------------------------------------------------------------------------

/// Sends an analysis request to Claude and streams the response back via
/// `claude-stream` Tauri events.  Returns when streaming is complete.
#[tauri::command]
pub async fn claude_analyze(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    processor_id: Option<String>,
    user_message: String,
) -> Result<(), String> {
    let api_key = {
        let k = state
            .api_key
            .lock()
            .map_err(|_| "API key store lock poisoned")?;
        k.clone().ok_or("Claude API key not set. Please configure your API key in settings.")?
    };

    // Build context — lock sessions briefly, then release.
    let (system, messages) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Session store lock poisoned")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;

        let pipeline_results = state
            .pipeline_results
            .lock()
            .map_err(|_| "Pipeline results lock poisoned")?;

        let ctx = build_analysis_context(
            session,
            processor_id.as_deref(),
            &pipeline_results,
            &session_id,
            &user_message,
        );

        (ctx.system, ctx.messages)
    };

    let client = ClaudeClient::new(api_key)?;
    client.stream_messages(&system, &messages, &app).await
}

// ---------------------------------------------------------------------------
// claude_generate_processor — one-shot YAML generation
// ---------------------------------------------------------------------------

/// Asks Claude to generate a processor YAML from a description + sample lines.
/// Returns the validated YAML string.
#[tauri::command]
pub async fn claude_generate_processor(
    state: State<'_, AppState>,
    description: String,
    sample_lines: Vec<String>,
) -> Result<String, String> {
    let api_key = {
        let k = state
            .api_key
            .lock()
            .map_err(|_| "API key store lock poisoned")?;
        k.clone().ok_or("Claude API key not set. Please configure your API key in settings.")?
    };

    let messages = build_generator_prompt(&description, &sample_lines);
    let system = crate::claude::generator::GENERATOR_SYSTEM_PROMPT;

    let client = ClaudeClient::new(api_key)?;
    let raw_response = client.complete(system, &messages[0].content).await?;

    let yaml = extract_yaml(&raw_response);

    // Validate the generated YAML before returning it.
    let processor = AnyProcessor::from_yaml(&yaml)
        .map_err(|e| format!("Generated YAML is invalid: {e}"))?;

    // Validate any inline Rhai scripts (AI-generated processors are always reporters).
    if let Some(def) = processor.as_reporter() {
        for stage in &def.pipeline {
            use crate::processors::reporter::schema::PipelineStage;
            if let PipelineStage::Script(s) = stage {
                validate_for_install(&s.src)?;
            }
        }
    }

    Ok(yaml)
}
