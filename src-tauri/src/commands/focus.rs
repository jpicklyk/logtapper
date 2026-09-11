//! Thin Tauri adapters over `services::focus`. See that module for the shared
//! focus context's shape and behavior.

use crate::commands::adapters::ui_ctx;
use crate::services::focus::{FocusContext, FocusContextInput};

/// Set (`Some`) or clear (`None`) the shared focus context. Returns the
/// stamped context that was stored (or `None` when clearing).
#[tauri::command]
pub fn set_focus(
    app: tauri::AppHandle,
    input: Option<FocusContextInput>,
) -> Result<Option<FocusContext>, String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::focus::set_focus(&ctx, input)?)
}

/// Read the current focus context, or `None` when nothing is focused.
#[tauri::command]
pub fn get_focus(app: tauri::AppHandle) -> Result<Option<FocusContext>, String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::focus::get_focus(&ctx)?)
}
