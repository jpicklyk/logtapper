# Marketplace Contributing Guide

LogTapper's marketplace lets users discover and install processor packs with a single click. This guide explains how to create processors and packs for the official marketplace, aimed at Android developers who want to share their work.

The official marketplace repository is at `https://github.com/jpicklyk/android-log-processors`.

---

## Directory Structure

The marketplace repository follows a fixed layout:

```
marketplace/
  marketplace.json              # index of all processors and packs
  processors/
    wifi_state.yaml
    battery_state.yaml
    ...
  packs/
    wifi-diagnostics.pack.yaml
    system-health.pack.yaml
    ...
```

- `marketplace/processors/` — one YAML file per processor
- `marketplace/packs/` — one YAML file per pack manifest
- `marketplace/marketplace.json` — the master index LogTapper reads to display the marketplace UI

---

## Processors Are Organized into Packs

Processors are installed as **packs** — logical groupings of related processors that work together (e.g., "WiFi Diagnostics", "System Health"). A pack is a manifest that references processors by ID; it does not bundle or duplicate them.

Users install a pack and get all of its processors at once.

---

## Creating a Processor for the Marketplace

Write your processor the same way you would for local use (see the type-specific guides for [reporters](reporter-processors.md), [state trackers](state-tracker-processors.md), and [correlators](correlator-processors.md)). The following additional requirements apply to marketplace submissions:

- `meta.id` must be unique across the entire marketplace and use kebab-case (e.g., `wifi-state`, `gc-pressure-monitor`)
- Include a complete `schema:` section with `source_types`, `emissions`, and an `mcp` summary string
- Use underscores in the filename, matching the ID: `wifi_state.yaml` for ID `wifi-state`

---

## Pack Manifests

A pack manifest lives in `marketplace/packs/{pack-id}.pack.yaml`. The pack ID is derived from the filename by stripping `.pack.yaml`.

```yaml
name: WiFi Diagnostics
version: 1.0.0
description: Monitor WiFi state, disconnects, and WLAN events
author: LogTapper
tags: [wifi, network, android]
category: network
processors:
  - wifi-state
  - wlan-disconnect-events
  - wlan-disconnect-tracker
```

**Required fields:** `name`, `version`, `processors` (at least one processor ID)

**Optional fields:** `author`, `description`, `tags`, `category`, `license`, `repository`

The processor IDs in the `processors` list must exactly match the `meta.id` values in the corresponding YAML files.

---

## The `marketplace.json` Index

Every processor and pack must be registered in `marketplace.json`. LogTapper reads this file to build the marketplace UI — entries not listed here are invisible to users.

### Processor entry

```json
{
  "id": "wifi-state",
  "name": "WiFi State",
  "version": "3.0.0",
  "description": "Tracks WiFi enabled/disabled and connection state",
  "path": "processors/wifi_state.yaml",
  "tags": ["wifi", "network"],
  "sha256": "",
  "category": "network",
  "processor_type": "state_tracker",
  "source_types": ["logcat"],
  "deprecated": false
}
```

### Pack entry

```json
{
  "id": "wifi-diagnostics",
  "name": "WiFi Diagnostics",
  "version": "1.0.0",
  "description": "Monitor WiFi state, disconnects, and WLAN events",
  "path": "packs/wifi-diagnostics.pack.yaml",
  "tags": ["wifi", "network"],
  "category": "network",
  "processor_ids": ["wifi-state", "wlan-disconnect-events", "wlan-disconnect-tracker"],
  "sha256": ""
}
```

### Key fields

| Field | Notes |
|---|---|
| `processor_type` | One of: `reporter`, `state_tracker`, `correlator` |
| `sha256` | Leave `""` during development (verification is skipped). For production releases, set to the SHA-256 hash of the YAML file. |
| `processor_ids` | Pack entries only. Must exactly match the processor `id` fields. |
| `category` | One of: `memory`, `network`, `battery`, `process`, `storage`, `security`, `system`, `privacy`, `performance`, `vendor` |
| `deprecated` | Set to `true` to hide a processor from new installs while preserving existing ones. |

---

## ID Conventions

- **Processor IDs:** kebab-case — `wifi-state`, `gc-pressure-monitor`
- **Pack IDs:** kebab-case, derived from the filename — `wifi-diagnostics` from `wifi-diagnostics.pack.yaml`
- **Installed IDs:** When LogTapper installs a processor from a marketplace source, it qualifies the ID as `{id}@{source_name}` (e.g., `wifi-state@official`). This prevents conflicts between processors from different sources that share the same base ID.

---

## Contributing to the Official Marketplace

1. Fork the [android-log-processors](https://github.com/jpicklyk/android-log-processors) repository.
2. Add your processor YAML to `marketplace/processors/`.
3. Add or update a pack manifest in `marketplace/packs/`.
4. Register both entries in `marketplace/marketplace.json`.
5. Test locally by pointing LogTapper at your fork in Settings > Marketplace Sources.
6. Submit a pull request with a brief description of what the processors detect and which Android components or subsystems they target.

For questions or to discuss a processor before submitting, open an issue in the repository first.
