<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logtapper-social-banner.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/logtapper-social-banner-light.png">
  <img alt="LogTapper Banner" src="assets/logtapper-social-banner-light.png" width="100%">
</picture>

# LogTapper

A desktop log analysis tool for Android developers, IT staff, and support personel. Load logcat, bugreport, dumpstate, and kernel (dmesg) files, or stream live from ADB — then search, filter, and run custom analysis pipelines powered by a YAML processor system with embedded Rhai scripting.

## Install

Download the latest release for your platform from [GitHub Releases](https://github.com/jpicklyk/logtapper/releases):

- **Windows:** `.exe` (NSIS installer) or `.msi`
- **macOS:** `.dmg` (note: you may need to right-click > Open on first launch — the app is not yet notarized)
- **Linux:** `.deb` or `.AppImage`

## Tech Stack

**Desktop shell:** [Tauri 2.x](https://v2.tauri.app/) — Rust backend + web frontend in a native window

**Backend (Rust)**
- Tauri command handlers for all IPC
- Custom log parsers (logcat, kernel, bugreport/dumpstate)
- Layered pipeline engine: transformers, reporters, state trackers, correlators
- Rhai scripting sandbox for processor logic
- PII anonymizer with pluggable detectors
- Axum HTTP bridge for MCP integration (`127.0.0.1:40404`)

**Frontend (React 19 / TypeScript)**
- [Vite 8](https://vite.dev/) for bundling and dev server
- [@tanstack/react-virtual](https://tanstack.com/virtual) for virtualized log viewing (handles millions of lines)
- [CodeMirror 6](https://codemirror.net/) for the editable scratch pad / text editor
- [Recharts](https://recharts.org/) for processor dashboard charts
- [@dnd-kit](https://dndkit.com/) for drag-and-drop tab management and processor chain ordering
- [lucide-react](https://lucide.dev/) icons, [clsx](https://github.com/lukeed/clsx) for class composition
- [mitt](https://github.com/developit/mitt) typed event bus for cross-hook coordination
- CSS Modules for scoped component styles
- Tauri dialog and window-state plugins

## Getting Started

### Prerequisites

- **Node.js** >= 22
- **Rust** (stable toolchain, MSVC on Windows)
- **npm** (comes with Node)
- **[Bun](https://bun.sh/)** (required to compile the MCP sidecar binary for production builds)

### Install dependencies

```bash
npm install
```

### Development

```bash
# Full app — starts Vite dev server + Rust backend together
npx tauri dev

# Frontend only (no Rust backend)
npx vite
```

### Build

```bash
# TypeScript check + Vite production bundle
npm run build

# Full Tauri app bundle (includes Rust compilation)
npx tauri build
```

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
server that gives AI agents direct tool access to your live log sessions — 21 tools
for searching lines, running analysis pipelines, reading state-tracker events, and
managing bookmarks and watches. No Node.js or separate install required.

Enable the bridge in **Settings > General > MCP Integration**, then connect your client:

| Client | Setup |
|---|---|
| **[Claude Code](docs/mcp/claude-code.md)** | Two commands — the LogTapper plugin finds the binary and registers it for you |
| **[Claude Desktop](docs/mcp/claude-desktop.md)** | Add one entry to `claude_desktop_config.json` |
| **[Other MCP clients](docs/mcp/README.md#step-3--connect-your-client)** | Launch the bundled binary over stdio — no arguments, no environment variables |

LogTapper must be running with the bridge enabled for tool calls to work.

See the **[MCP Setup Guide](docs/mcp/README.md)** for binary locations, the full
tool list, and troubleshooting.

## Project Structure

```
src-tauri/          Rust backend (Tauri commands, parsers, pipeline engine, MCP bridge)
src-next/           Frontend source (React components, hooks, cache layer)
mcp-server/         MCP server (Node.js, stdio transport)
marketplace/        Processor marketplace (YAML definitions + pack manifests)
docs/               Documentation
```

## Documentation

LogTapper uses a YAML-based processor system with embedded [Rhai](https://rhai.rs/) scripting for custom log analysis. See the **[Processor Authoring Guide](docs/processors/README.md)** to create your own analysis rules — reporters for extracting metrics, state trackers for monitoring transitions, and correlators for linking related events.

## License

Copyright (c) 2026 Jeff Picklyk

Licensed under the [GNU General Public License v3.0](LICENSE).
