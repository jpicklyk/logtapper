//! Thin Tauri adapters over `services::themes`. See that module for the
//! user-theme JSON shape, validation rules, and the Ui-only write/delete gate.

use crate::commands::adapters::ui_ctx;
use crate::services::themes::{ThemeSummary, UserTheme};

/// List every stored user theme.
#[tauri::command]
pub fn list_themes(app: tauri::AppHandle) -> Result<Vec<ThemeSummary>, String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::themes::list(&ctx)?)
}

/// Read one stored theme by slug.
#[tauri::command]
pub fn read_theme(app: tauri::AppHandle, slug: String) -> Result<UserTheme, String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::themes::read(&ctx, &slug)?)
}

/// Create or replace a stored theme.
#[tauri::command]
pub fn write_theme(app: tauri::AppHandle, slug: String, theme: UserTheme) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::themes::write(&ctx, &slug, theme)?)
}

/// Delete a stored theme by slug.
#[tauri::command]
pub fn delete_theme(app: tauri::AppHandle, slug: String) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::themes::delete(&ctx, &slug)?)
}
