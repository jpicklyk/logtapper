# marketplace/ — Processor Marketplace Source

## Directory structure

```
marketplace/
  marketplace.json              ← index: lists all available processors with versions
  processors/                   ← YAML processor definitions
    wifi_state.yaml
    wlan_disconnect_events.yaml
    ...
  packs/                        ← pack manifests (groups of related processors)
    wifi-diagnostics.pack.yaml
    ...
```

## How source resolution works (dev vs release)

**Dev builds** (`cfg(debug_assertions)`): `resolve_dev_marketplace_path()` in `lib.rs` walks up from the running executable and **prefers the project root `marketplace/` directory** over the `target/` build output copy. It skips any path containing `target/` in its components.

**Consequence in dev:** edits to files in this directory are picked up **immediately** by the running app on next marketplace operation (`check_updates`, browse, install). No rebuild or manual copy needed.

**Release builds:** the official source uses `SourceType::Github` pointing at the repo's `main` branch. The `marketplace/` directory is also copied to the build output via Tauri's `resources` config (`src-tauri/tauri.conf.json`) as a fallback.

## Updates vs new processors

`check_updates` only detects version changes for **already-installed** processors. It compares each installed processor's version against the marketplace index entry with the same qualified ID (`{id}@{source_name}`).

- **Updating an existing processor:** bump the version in both the YAML and `marketplace.json` — the "Updates" tab will show the new version.
- **Adding a new processor:** it will NOT appear in "check for updates." Users must browse the Marketplace and install it (or install/update a pack that includes it).
- **Updating a pack:** `check_updates` runs a pack-level check too (`detect_pack_updates` in `commands/sources.rs`), which flags a pack when the index version is newer than the **installed manifest's** version, or when the index lists processor IDs the installed manifest doesn't have. Clicking "Update Pack" re-runs the pack install, which installs/updates every listed processor and re-persists the manifest.
  - **The installed manifest's `version` is what the check compares against** — not the index entry that was used to install it. If `packs/*.pack.yaml` lags its `marketplace.json` entry, the pack's update row reappears after every install and never clears. The `pack_yaml_versions_match_index` test in `commands/sources.rs` guards this.

## Version bumping checklist

When updating a processor YAML:
1. Bump `version` in the YAML file (`meta.version` or top-level `version`)
2. **Also bump `version` in `marketplace.json`** for the same processor entry — the update checker (`check_updates`) compares installed versions against the **index**, not the YAML files

When adding a new processor:
1. Create the YAML in `processors/`
2. Add the processor entry to `marketplace.json` `processors` array
3. Add the processor ID to the relevant pack's `processors` list (both the `.pack.yaml` and the `processor_ids` array in `marketplace.json`)
4. Bump the pack version in both the `.pack.yaml` and `marketplace.json`
5. Bump the marketplace index `version` number

Forgetting step 2 means the processor won't appear in the Marketplace at all.

## SHA-256 verification

The `sha256` field in `marketplace.json` entries is empty (`""`) for local development — verification is skipped. For production/remote sources, this must contain the actual SHA-256 of the YAML file.
