/**
 * Pure helpers for the MCP launcher — kept free of process/spawn side effects
 * so they can be unit-tested without starting anything.
 *
 * The launcher is the process Claude Desktop runs from the installed `.mcpb`.
 * Instead of carrying its own copy of the MCP server (which goes stale the
 * moment LogTapper updates), it reads a pointer file that LogTapper rewrites
 * on every startup and execs the `logtapper-mcp` sidecar that shipped with
 * the currently installed app. The bundle therefore only needs re-installing
 * when *this* contract changes, not on every server release.
 */
import { basename, isAbsolute, join } from "node:path";

/** Tauri app identifier — the app data directory is named after it. */
export const APP_IDENTIFIER = "io.github.jpicklyk.logtapper";

/** File LogTapper writes into its app data directory at startup. */
export const POINTER_FILE = "mcp-launcher.json";

/** Only binaries with this basename prefix may be launched. */
const SIDECAR_PREFIX = "logtapper-mcp";

export interface LauncherPointer {
  /** Absolute path to the `logtapper-mcp` sidecar. */
  command: string;
  /** Extra arguments — currently always empty; reserved for the contract. */
  args: string[];
  /** LogTapper version that wrote the pointer — informational only. */
  appVersion?: string;
}

/**
 * Per-platform base directory that matches Tauri's `app_data_dir()`:
 * `%APPDATA%` on Windows, `~/Library/Application Support` on macOS and
 * `$XDG_DATA_HOME` (default `~/.local/share`) elsewhere.
 */
export function dataDirFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  switch (platform) {
    case "win32":
      return env.APPDATA && env.APPDATA.length > 0 ? env.APPDATA : join(home, "AppData", "Roaming");
    case "darwin":
      return join(home, "Library", "Application Support");
    default:
      return env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
        ? env.XDG_DATA_HOME
        : join(home, ".local", "share");
  }
}

/** Full path of the pointer file for this platform. */
export function pointerPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  return join(dataDirFor(platform, env, home), APP_IDENTIFIER, POINTER_FILE);
}

/**
 * Parse and validate the pointer file's JSON.
 *
 * Throws with a human-readable reason on any shape problem. The basename
 * check is the one security-relevant rule: whoever can write the pointer can
 * already run code as this user, but the launcher still refuses to become a
 * generic "run anything" trampoline.
 */
export function parsePointer(text: string): LauncherPointer {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`pointer file is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("pointer file must contain a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const command = obj.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error('pointer file is missing a "command" string');
  }
  if (!isAbsolute(command)) {
    throw new Error(`"command" must be an absolute path, got ${JSON.stringify(command)}`);
  }
  if (!basename(command).startsWith(SIDECAR_PREFIX)) {
    throw new Error(
      `"command" must name the ${SIDECAR_PREFIX} sidecar, got ${JSON.stringify(basename(command))}`,
    );
  }

  const args = obj.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error('"args" must be an array of strings when present');
  }

  const appVersion = typeof obj.appVersion === "string" ? obj.appVersion : undefined;
  return { command, args: args as string[], appVersion };
}
