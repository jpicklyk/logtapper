use tauri::State;

// TODO Phase 1: implement file loading with mmap

#[tauri::command]
pub async fn load_log_file(_path: String) -> Result<String, String> {
    Err("not yet implemented".into())
}

#[tauri::command]
pub async fn get_lines(_request: serde_json::Value) -> Result<serde_json::Value, String> {
    Err("not yet implemented".into())
}

#[tauri::command]
pub async fn search_logs(_query: serde_json::Value) -> Result<serde_json::Value, String> {
    Err("not yet implemented".into())
}
