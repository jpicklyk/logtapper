/**
 * LogTapper MCP launcher — process entrypoint of the Claude Desktop bundle.
 *
 * See `launcher-core.ts` for the contract. This file only does the I/O:
 * read the pointer LogTapper wrote, exec the sidecar it names with stdio
 * passed straight through, and mirror its exit. Node builtins only, so the
 * bundled launcher is a few kilobytes and has nothing to go stale.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

import { parsePointer, pointerPath, type LauncherPointer } from "./launcher-core.ts";

// stderr is the only channel an MCP host surfaces for a server that never
// completes the handshake (Claude Desktop copies it into its per-server log),
// so every step reports there: one line each, prefixed for grepping.
function note(message: string): void {
  process.stderr.write(`logtapper launcher: ${message}\n`);
}

function fail(message: string): never {
  note(message);
  process.exit(1);
}

const path = pointerPath(process.platform, process.env, homedir());
note(`node ${process.version} pid ${process.pid} platform ${process.platform}; pointer ${path}`);

let pointer: LauncherPointer;
try {
  pointer = parsePointer(readFileSync(path, "utf8"));
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    fail(`${path} not found — start LogTapper once so it can record where its MCP server lives`);
  }
  fail(`${path}: ${(e as Error).message}`);
}

try {
  if (!statSync(pointer.command).isFile()) fail(`${pointer.command} is not a file`);
} catch {
  fail(`${pointer.command} (from ${path}) does not exist — start LogTapper once to refresh it`);
}

// Pump the streams rather than `stdio: "inherit"`. Claude Desktop runs the
// bundle in an Electron utility process whose stdin/stdout are not plain OS
// handles, so an inherited handle gives the sidecar nothing to read and it
// exits on instant EOF. Piping works whatever our own stdio is made of, and
// still propagates EOF: our stdin ending ends the sidecar's stdin, and a
// hard-killed launcher drops the pipe, which the sidecar also reads as EOF.
const child = spawn(pointer.command, pointer.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
note(`spawned ${pointer.command} (app ${pointer.appVersion ?? "?"}) as pid ${child.pid ?? "?"}`);
process.stdin.pipe(child.stdin!);
child.stdout!.pipe(process.stdout);
child.stderr!.pipe(process.stderr);
process.stdin.on("end", () => child.stdin!.end());
child.stdin!.on("error", () => { /* sidecar went away first — its exit handler reports it */ });

child.on("error", (e) => fail(`failed to start ${pointer.command}: ${e.message}`));
child.on("exit", (code, signal) => {
  note(`sidecar exited code=${code} signal=${signal}`);
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
