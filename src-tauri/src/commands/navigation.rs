//! Thin Tauri adapter over `services::navigation`. Exists so a UI test (or
//! the UI itself, one day) can exercise the identical path an agent's
//! `POST /mcp/navigate` uses — the request is journaled and emitted the same
//! way regardless of which transport sent it.

use crate::commands::adapters::ui_ctx;
use crate::services::navigation::{NavRequest, NavRequestInput};

#[tauri::command]
pub fn request_navigation(
    app: tauri::AppHandle,
    input: NavRequestInput,
) -> Result<NavRequest, String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::navigation::request_navigation(&ctx, input)?)
}
