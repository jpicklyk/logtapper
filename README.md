<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logtapper-social-banner.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/logtapper-social-banner-light.png">
  <img alt="LogTapper Banner" src="assets/logtapper-social-banner-light.png" width="100%">
</picture>

# LogTapper

A desktop log analysis tool for Android developers, IT staff, and support personnel. Load logcat, bugreport, dumpstate, and kernel (dmesg) files, or stream live from ADB — then search, filter, and run custom analysis pipelines powered by a YAML processor system with embedded Rhai scripting.

## Install

Download the latest release for your platform from [GitHub Releases](https://github.com/jpicklyk/logtapper/releases):

- **Windows:** `.exe` (NSIS installer) or `.msi`
- **macOS:** `.dmg` — pick `aarch64` for Apple Silicon or `x64` for Intel (see the note below)
- **Linux:** `.deb` or `.AppImage`

### macOS first launch

LogTapper is not yet notarized by Apple, so a downloaded build carries a quarantine
flag. On first launch macOS reports **"LogTapper is damaged and can't be opened"** and
offers to move it to the Trash. The app is not damaged — this is Gatekeeper blocking an
unsigned download. Right-clicking **Open** no longer clears it on current macOS.

To install:

1. Open the `.dmg` and drag **LogTapper** to your Applications folder.
2. Eject the disk image.
3. Remove the quarantine flag from the installed app:

   ```bash
   xattr -dr com.apple.quarantine /Applications/LogTapper.app
   ```

4. Launch LogTapper from Applications as normal.

You only need to do this once per installed version. Removing notarization from the
warning path requires an Apple Developer Program membership; until then this step is the
supported install route on macOS.

## Tech Stack

**Desktop shell:** [Tauri 2.x](https://v2.tauri.app/) — Rust backend + web frontend in a native window

**Backend (Rust)**
- Tauri command handlers for all IPC
- Custom log parsers (logcat, kernel, bugreport/dumpstate)
- Layered pipeline engine: transformers, reporters, state trackers, correlators
- Rhai scripting sandbox for processor logic
- PII anonymizer with pluggable detectors
- Axum HTTP bridge (loopback only) behind the bundled MCP server

**Frontend (Solid 1.9 / TypeScript)**
- [Vite 8](https://vite.dev/) for bundling and dev server
- Hand-rolled virtualized viewer (`src-solid/viewer/`) over a shared fetch scheduler and line cache (handles millions of lines)
- [CodeMirror 6](https://codemirror.net/) for the editable scratch pad / text editor and analysis bodies
- Three-layer design tokens (`src-solid/styles/tokens.css`): dark, light and high-contrast bases, user themes on top
- Plain Solid stores composed once in `App.tsx`, CSS Modules for scoped component styles
- Tauri dialog and window-state plugins

## Getting Started

### Prerequisites

- **Node.js** >= 22
- **Rust** (stable toolchain, MSVC on Windows)
- **npm** (comes with Node)
- **[Bun](https://bun.sh/)** (optional — only `npm run build:full` needs it, to compile the standalone MCP sidecar binary)

### Install dependencies

```bash
npm install
```

### Development

```bash
# Full app — starts Vite dev server + Rust backend together
npx tauri dev

# Frontend only (no Rust backend)
npm run dev
```

### Build

```bash
# TypeScript check + Vite production bundle
npm run build

# Full Tauri app bundle (includes Rust compilation)
npx tauri build
```

`npx tauri build` does not compile the MCP sidecar binary; the release workflow stages it
with Bun. A source checkout therefore has no sidecar to launch — see
[Running from source](docs/mcp/README.md#running-from-source) to run the server with Node instead.

### Tests

```bash
# Frontend tests
npm test

# Rust backend tests
cargo test --manifest-path src-tauri/Cargo.toml

# Rust linting
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## MCP Server

LogTapper ships a bundled MCP ([Model Context Protocol](https://modelcontextprotocol.io/))
server that gives AI agents direct tool access to your live log sessions — tools
for searching lines, running analysis pipelines, reading state-tracker events, and
managing bookmarks and watches. Installed releases need no Node.js or separate install.

Enable the bridge in **Settings > General > MCP Integration**, then connect your client:

| Client | Setup |
|---|---|
| **[Claude Desktop](docs/mcp/claude-desktop.md)** | Save the bundled `.mcpb` extension from Settings, then install it via Claude Desktop's Developer menu |
| **[Claude Code](docs/mcp/claude-code.md)** | Two commands — the [LogTapper plugin](plugins/logtapper/README.md) finds the binary and registers it for you |
| **[Other MCP clients](docs/mcp/README.md#step-3--connect-your-client)** | Launch the binary bundled with installed releases over stdio — no arguments, no environment variables |

LogTapper must be running with the bridge enabled for tool calls to work.

See the **[MCP Setup Guide](docs/mcp/README.md)** for binary locations, the full
tool list, and troubleshooting.

## Project Structure

```
src-tauri/          Rust backend (Tauri commands, parsers, pipeline engine, MCP bridge)
src-solid/          Frontend source (Solid UI: shell, viewer, stores, surfaces)
src-shared/         Framework-free modules shared with the frontend (IPC bindings, cache, filter, viewport)
mcp-server/         MCP server (Node.js, stdio transport)
marketplace/        Processor marketplace (YAML definitions + pack manifests)
plugins/            Claude Code plugin (attach-mcp skill) and its marketplace manifest
docs/               User documentation (MCP setup, processor authoring)
design_docs/        Architecture and security design specs
```

## Documentation

LogTapper uses a YAML-based processor system with embedded [Rhai](https://rhai.rs/) scripting for custom log analysis. See the **[Processor Authoring Guide](docs/processors/README.md)** to create your own analysis rules — reporters for extracting metrics, state trackers for monitoring transitions, and correlators for linking related events.

## License

Copyright (c) 2026 Jeff Picklyk

Licensed under the [GNU General Public License v3.0](LICENSE).
