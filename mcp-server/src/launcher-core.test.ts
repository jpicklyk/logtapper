import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { APP_IDENTIFIER, POINTER_FILE, dataDirFor, parsePointer, pointerPath } from "./launcher-core.ts";

const HOME = "/home/u";

describe("dataDirFor mirrors Tauri's app_data_dir", () => {
  it("win32 uses %APPDATA% when set", () => {
    expect(dataDirFor("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe(
      "C:\\Users\\u\\AppData\\Roaming",
    );
  });
  it("win32 falls back to the Roaming folder under home", () => {
    expect(dataDirFor("win32", {}, "C:\\Users\\u")).toBe(join("C:\\Users\\u", "AppData", "Roaming"));
  });
  it("darwin uses Application Support", () => {
    expect(dataDirFor("darwin", {}, HOME)).toBe(join(HOME, "Library", "Application Support"));
  });
  it("linux honours XDG_DATA_HOME and defaults to ~/.local/share", () => {
    expect(dataDirFor("linux", { XDG_DATA_HOME: "/xdg" }, HOME)).toBe("/xdg");
    expect(dataDirFor("linux", { XDG_DATA_HOME: "" }, HOME)).toBe(join(HOME, ".local", "share"));
  });
  it("pointerPath nests identifier and file name", () => {
    expect(pointerPath("darwin", {}, HOME)).toBe(
      join(HOME, "Library", "Application Support", APP_IDENTIFIER, POINTER_FILE),
    );
  });
});

describe("parsePointer", () => {
  const win = "C:\\Program Files\\LogTapper\\logtapper-mcp.exe";
  const mac = "/Applications/LogTapper.app/Contents/MacOS/logtapper-mcp";

  it("accepts a sidecar path with no args", () => {
    expect(parsePointer(JSON.stringify({ command: mac }))).toEqual({ command: mac, args: [], appVersion: undefined });
  });
  it("accepts a Windows path, args and appVersion", () => {
    expect(parsePointer(JSON.stringify({ command: win, args: ["--x"], appVersion: "0.13.0" }))).toEqual({
      command: win,
      args: ["--x"],
      appVersion: "0.13.0",
    });
  });
  it("accepts a triple-suffixed sidecar name", () => {
    const p = "/opt/logtapper/logtapper-mcp-x86_64-unknown-linux-gnu";
    expect(parsePointer(JSON.stringify({ command: p })).command).toBe(p);
  });
  it.each([
    ["not json", "{", /not valid JSON/],
    ["array", "[]", /JSON object/],
    ["missing command", "{}", /missing a "command"/],
    ["relative command", JSON.stringify({ command: "logtapper-mcp" }), /absolute path/],
    ["wrong binary", JSON.stringify({ command: "/usr/bin/bash" }), /must name the logtapper-mcp sidecar/],
    ["bad args", JSON.stringify({ command: mac, args: [1] }), /"args" must be an array of strings/],
  ])("rejects %s", (_name, text, re) => {
    expect(() => parsePointer(text)).toThrow(re);
  });
});
