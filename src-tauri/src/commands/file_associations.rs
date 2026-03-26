use serde::Serialize;

/// Extensions that support dynamic (runtime) association toggling.
const DYNAMIC_EXTENSIONS: &[(&str, &str)] = &[
    ("log", "Log File"),
    ("txt", "Text File"),
];

/// Build the ProgID for a given extension, e.g. `LogTapper.log`.
fn prog_id(ext: &str) -> String {
    format!("LogTapper.{ext}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAssocEntry {
    pub ext: String,
    pub label: String,
    /// Whether LogTapper is registered as an available handler for this extension.
    pub registered: bool,
    /// Whether LogTapper is the current default handler (UserChoice on Win 10/11).
    pub is_default: bool,
}

// ── Windows 10/11 implementation ────────────────────────────────────────────
//
// Modern Windows file associations:
// 1. Register ProgID under HKCU\Software\Classes\LogTapper.<ext>
//    with shell\open\command pointing to our exe.
// 2. Register app capabilities under HKCU\Software\LogTapper\Capabilities
//    with FileAssociations mapping .<ext> → ProgID.
// 3. Register the app under HKCU\Software\RegisteredApplications
//    so it appears in Settings > Default Apps.
// 4. To become the default, launch the system "Default Apps" UI —
//    apps cannot programmatically claim defaults on Win 10/11 due to
//    UserChoice hash protection.

#[cfg(target_os = "windows")]
mod platform {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    use super::{prog_id, FileAssocEntry, DYNAMIC_EXTENSIONS};

    const APP_NAME: &str = "LogTapper";
    const CAPABILITIES_PATH: &str = r"Software\LogTapper\Capabilities";

    /// Notify Explorer that file associations changed.
    fn notify_shell() {
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
        }
    }

    /// Check whether our ProgID is registered for this extension.
    fn is_registered(ext: &str) -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let pid = prog_id(ext);
        // Check if the ProgID key exists with a shell\open\command.
        let cmd_path = format!(r"Software\Classes\{pid}\shell\open\command");
        hkcu.open_subkey(&cmd_path).is_ok()
    }

    /// Check whether LogTapper is the current default handler via UserChoice.
    /// This is the authoritative source on Windows 10/11.
    fn is_current_default(ext: &str) -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let uc_path = format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\UserChoice");
        if let Ok(key) = hkcu.open_subkey(&uc_path) {
            if let Ok(val) = key.get_value::<String, _>("ProgId") {
                return val == prog_id(ext);
            }
        }
        false
    }

    /// Register LogTapper as an available handler for an extension.
    /// This does NOT make it the default — the user must choose via Default Apps.
    fn register(ext: &str, description: &str) -> Result<(), String> {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {e}"))?;
        let exe_str = exe_path.to_string_lossy();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 1. Register ProgID: HKCU\Software\Classes\LogTapper.<ext>
        let pid = prog_id(ext);
        let classes = hkcu
            .open_subkey_with_flags(r"Software\Classes", KEY_READ | KEY_WRITE)
            .map_err(|e| format!("Failed to open HKCU\\Software\\Classes: {e}"))?;

        let (prog_key, _) = classes
            .create_subkey(&pid)
            .map_err(|e| format!("Failed to create ProgID key: {e}"))?;
        prog_key
            .set_value("", &description)
            .map_err(|e| format!("Failed to set ProgID description: {e}"))?;

        let (icon_key, _) = prog_key
            .create_subkey("DefaultIcon")
            .map_err(|e| format!("Failed to create DefaultIcon key: {e}"))?;
        icon_key
            .set_value("", &format!("{exe_str},0"))
            .map_err(|e| format!("Failed to set icon: {e}"))?;

        let (cmd_key, _) = prog_key
            .create_subkey(r"shell\open\command")
            .map_err(|e| format!("Failed to create shell\\open\\command key: {e}"))?;
        cmd_key
            .set_value("", &format!("\"{exe_str}\" \"%1\""))
            .map_err(|e| format!("Failed to set open command: {e}"))?;

        // 2. Register app capabilities: HKCU\Software\LogTapper\Capabilities
        let (cap_key, _) = hkcu
            .create_subkey(CAPABILITIES_PATH)
            .map_err(|e| format!("Failed to create Capabilities key: {e}"))?;
        cap_key
            .set_value("ApplicationName", &APP_NAME)
            .map_err(|e| format!("Failed to set ApplicationName: {e}"))?;
        cap_key
            .set_value("ApplicationDescription", &"Android log file analyzer")
            .map_err(|e| format!("Failed to set ApplicationDescription: {e}"))?;

        let (fa_key, _) = cap_key
            .create_subkey("FileAssociations")
            .map_err(|e| format!("Failed to create FileAssociations key: {e}"))?;
        fa_key
            .set_value(format!(".{ext}"), &pid)
            .map_err(|e| format!("Failed to set .{ext} association: {e}"))?;

        // 3. Register under HKCU\Software\RegisteredApplications
        let (ra_key, _) = hkcu
            .create_subkey(r"Software\RegisteredApplications")
            .map_err(|e| format!("Failed to open RegisteredApplications: {e}"))?;
        ra_key
            .set_value(APP_NAME, &CAPABILITIES_PATH)
            .map_err(|e| format!("Failed to register application: {e}"))?;

        // 4. Add OpenWithProgids so we appear in "Open With" for this extension.
        let ext_key_path = format!(r"Software\Classes\.{ext}\OpenWithProgids");
        let (owp_key, _) = hkcu
            .create_subkey(&ext_key_path)
            .map_err(|e| format!("Failed to create OpenWithProgids key: {e}"))?;
        // Empty string value — the value name is the ProgID, value data is empty.
        owp_key
            .set_value(&pid, &"")
            .map_err(|e| format!("Failed to add OpenWithProgids entry: {e}"))?;

        notify_shell();
        Ok(())
    }

    /// Unregister LogTapper as a handler for an extension.
    fn unregister(ext: &str) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let pid = prog_id(ext);

        // Remove ProgID key tree.
        let classes = hkcu
            .open_subkey_with_flags(r"Software\Classes", KEY_READ | KEY_WRITE)
            .map_err(|e| format!("Failed to open HKCU\\Software\\Classes: {e}"))?;
        let _ = classes.delete_subkey_all(&pid);

        // Remove from OpenWithProgids.
        let owp_path = format!(r"Software\Classes\.{ext}\OpenWithProgids");
        if let Ok(owp_key) = hkcu.open_subkey_with_flags(&owp_path, KEY_READ | KEY_WRITE) {
            let _ = owp_key.delete_value(&pid);
        }

        // Remove from Capabilities\FileAssociations.
        let fa_path = format!(r"{CAPABILITIES_PATH}\FileAssociations");
        if let Ok(fa_key) = hkcu.open_subkey_with_flags(&fa_path, KEY_READ | KEY_WRITE) {
            let _ = fa_key.delete_value(format!(".{ext}"));
        }

        // Clean up: if no file associations remain, remove Capabilities and RegisteredApplications entry.
        let has_remaining = if let Ok(fa_key) = hkcu.open_subkey(&fa_path) {
            fa_key.enum_values().count() > 0
        } else {
            false
        };

        if !has_remaining {
            let _ = hkcu.delete_subkey_all(r"Software\LogTapper");
            if let Ok(ra_key) = hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", KEY_READ | KEY_WRITE) {
                let _ = ra_key.delete_value(APP_NAME);
            }
        }

        notify_shell();
        Ok(())
    }

    pub fn get_status() -> Result<Vec<FileAssocEntry>, String> {
        let mut entries = Vec::new();
        for (ext, label) in DYNAMIC_EXTENSIONS {
            entries.push(FileAssocEntry {
                ext: (*ext).to_string(),
                label: (*label).to_string(),
                registered: is_registered(ext),
                is_default: is_current_default(ext),
            });
        }
        Ok(entries)
    }

    pub fn set_association(ext: &str, enabled: bool) -> Result<(), String> {
        let desc = DYNAMIC_EXTENSIONS
            .iter()
            .find(|(e, _)| *e == ext)
            .map(|(_, d)| *d)
            .ok_or_else(|| format!("Extension '.{ext}' is not a manageable file association"))?;

        if enabled {
            register(ext, desc)
        } else {
            unregister(ext)
        }
    }

    pub fn open_default_apps_settings() -> Result<(), String> {
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:defaultapps")
            .spawn()
            .map_err(|e| format!("Failed to open Default Apps settings: {e}"))?;
        Ok(())
    }
}

// ── Non-Windows stubs ───────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::FileAssocEntry;

    pub fn get_status() -> Result<Vec<FileAssocEntry>, String> {
        Ok(Vec::new())
    }

    pub fn set_association(_ext: &str, _enabled: bool) -> Result<(), String> {
        Err("File association management is only available on Windows".to_string())
    }

    pub fn open_default_apps_settings() -> Result<(), String> {
        Err("Default Apps settings are only available on Windows".to_string())
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Get registration and default status for all dynamic extensions.
#[tauri::command]
pub fn get_file_association_status() -> Result<Vec<FileAssocEntry>, String> {
    platform::get_status()
}

/// Register or unregister LogTapper as an available handler for an extension.
/// This makes the app appear in (or disappear from) the "Open With" menu.
/// To become the default, the user must choose via Default Apps settings.
#[tauri::command]
pub fn set_file_association(ext: String, enabled: bool) -> Result<(), String> {
    platform::set_association(&ext, enabled)
}

/// Open the Windows "Default Apps" settings page so the user can choose defaults.
#[tauri::command]
pub fn open_default_apps_settings() -> Result<(), String> {
    platform::open_default_apps_settings()
}
