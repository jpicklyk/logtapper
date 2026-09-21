; NSIS installer hooks — wired by `bundle.windows.nsis.installerHooks` in
; tauri.conf.json; `tests/nsis_hooks.rs` pins both the wiring and this content.
;
; The MCP sidecar (logtapper-mcp.exe) is a child of the app. Two things leave
; it running with no app: a crash, and a build older than 0.13.1 handing off to
; this installer through the updater (that exit path skipped the app's own
; cleanup). Windows refuses to overwrite a running exe, so without this NSIS
; stops on "Error opening file for writing: ...\logtapper-mcp.exe" — modal
; even under /P — and an in-app update dies half applied. The app kills its
; sidecar itself since 0.13.1; this covers every installer that runs against
; an older or crashed one. `taskkill` on a name that is not running is a
; harmless non-zero exit, discarded below.

!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /IM logtapper-mcp.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /IM logtapper-mcp.exe'
  Pop $0
!macroend
