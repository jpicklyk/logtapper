fn main() {
  tauri_build::build();

  // WP-T2: `tests/bridge_http.rs` constructs `mcp_bridge::BridgeCtx` (via
  // `BridgeCtx::from_parts`) and calls `mcp_bridge::router(ctx)` to drive the
  // real MCP bridge router in-process. `BridgeCtx` carries an
  // `Option<AppHandle<Wry>>` field, and merely linking that type in — even
  // with the value `None` — pulls Wry's window-class registration code into
  // the test binary. Wry requires the version-6 Common Controls assembly;
  // without an activation context requesting it, a plain `cargo test` binary
  // has no manifest at all, so the loader resolves the comctl32 imports
  // against the legacy system32\comctl32.dll (v5.82) and the whole process
  // fails at OS load time with STATUS_ENTRYPOINT_NOT_FOUND — before main(),
  // before any test code, with no output. Confirmed by manually re-embedding
  // a ComCtl32-v6 manifest into the built (crashing) test .exe with `mt.exe`:
  // the crash disappears and all 20 `bridge_http` tests pass.
  //
  // `cargo:rustc-link-arg-tests` (unlike a workspace-wide `.cargo/config.toml`
  // `rustflags` override, which was tried first and broke unrelated
  // dependency build scripts across the whole workspace) is scoped by Cargo
  // to ONLY this package's own `[[test]]` targets — it does not touch the
  // real app binary (which already gets its own manifest via
  // `tauri_build::build()` above) or any dependency's build script.
  #[cfg(windows)]
  {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/msvc-test.manifest");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
  }
}
