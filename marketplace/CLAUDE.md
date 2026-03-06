# marketplace/ — Processor Marketplace Source

## Directory structure

```
marketplace/
  marketplace.json              ← index: lists all available processors with versions
  processors/                   ← YAML processor definitions
    wifi_state.yaml
    wlan_disconnect_events.yaml
    ...
```

## How it gets to the running app

Tauri's `resources` config (`src-tauri/tauri.conf.json` lines 31-47) copies this directory to `src-tauri/target/debug/marketplace/` at **build time**. The running app's "official" source (see `sources.json`) points to the build output copy, NOT this source directory.

**Consequence:** editing files here does NOT affect the running app. You must either:
1. **Rebuild** (`npx tauri dev` or `cargo build`) — Tauri copies resources on build
2. **Manual copy** — `cp marketplace/<file> src-tauri/target/debug/marketplace/<file>`

## Version bumping checklist

When updating a processor YAML:
1. Bump `version` in the YAML file (`meta.version` or top-level `version`)
2. **Also bump `version` in `marketplace.json`** for the same processor entry — the update checker (`check_updates`) compares installed versions against the **index**, not the YAML files
3. Copy to build output or rebuild (see above)

Forgetting step 2 means the Marketplace "Updates" tab won't detect the change.

## SHA-256 verification

The `sha256` field in `marketplace.json` entries is empty (`""`) for local development — verification is skipped. For production/remote sources, this must contain the actual SHA-256 of the YAML file.
