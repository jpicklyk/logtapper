# fake-adb — streaming bench shim

A fake `adb` that answers exactly the subcommands `src-tauri/src/services/stream.rs`
issues, so a bench run can exercise the real ADB-streaming path (the 100-line/50ms
`chunks_timeout` batching, the real Tauri `Channel`) with **no backend change and no
attached Android device**.

- `devices -l` → one fake device (`emulator-5554`), in the exact format
  `services::stream::parse_adb_devices` expects.
- `-s <serial> logcat -v threadtime -T 1 [--pid <pid>]` → replays a fixture file to
  stdout at 100 lines / 50ms, looping at EOF (matches `AdbLineSource::open` and
  `run_streaming_task`'s batching window).
- anything else (e.g. `-s <serial> shell pidof <package>`) → exits 0 with empty stdout,
  the same as `package_pids` sees for a package that isn't running.

## Files

- `adb.cmd` — the shim actually placed on `PATH`; delegates to `fake-adb.mjs`.
- `fake-adb.mjs` — the real logic (device listing, fixture replay, exit handling).
- `selftest.mjs` — throughput + kill-latency check, no Tauri app involved.

## Running a bench session

1. Generate the fixture once (± 1s for 1,000,000 lines):

   ```powershell
   node scripts/gen-logcat.mjs --lines 1000000 --out bench/logcat-1m.log
   ```

2. In the **same PowerShell session** you'll launch the app from, prepend this
   directory to `PATH` so `adb.cmd` resolves before any real `adb.exe` (Android
   Studio's platform-tools, if installed, is commonly already on `PATH`):

   ```powershell
   $env:PATH = "$PWD\scripts\fake-adb;$env:PATH"
   ```

   This only affects the current PowerShell process — close the tab (or open a new
   one) to go back to the real `adb`. Verify the override took effect:

   ```powershell
   Get-Command adb   # should print scripts\fake-adb\adb.cmd, not platform-tools\adb.exe
   ```

3. Launch the app from that same session (`npx tauri dev`, or the Solid variant once
   it exists) and start an ADB stream from the UI. The device picker should list
   `emulator-5554` / `Pixel_6_API_34` — that confirms the app is talking to the shim,
   not a real device. Starting the stream should show ~100 lines arriving every 50ms
   from `bench/logcat-1m.log`, looping forever once it reaches the end.

4. To point at a different (e.g. smaller, hand-crafted) fixture, or to make the shim
   stop at EOF instead of looping:

   ```powershell
   $env:FAKE_ADB_SOURCE = "D:\path\to\some-other.log"
   $env:FAKE_ADB_ONCE = "1"
   ```

   Unset them (`Remove-Item Env:FAKE_ADB_SOURCE`, `Remove-Item Env:FAKE_ADB_ONCE`) to
   go back to the default (`bench/logcat-1m.log`, looping).

## Self-test (no app required)

```powershell
node scripts/gen-logcat.mjs --lines 1000000   # if bench/logcat-1m.log doesn't exist yet
node scripts/fake-adb/selftest.mjs
```

Spawns the shim with the exact argv the backend uses, measures lines arriving per
50ms window, then kills it and checks the process reports exit promptly. Prints the
per-window counts, the steady-state average (target ~100/window), and the kill→exit
latency; exits non-zero if either is out of range.

## Known limitation: the `.cmd` wrapper and process trees

`adb.cmd` is a batch file, not a real binary. Windows' `CreateProcess` cannot execute a
`.bat`/`.cmd` file directly — only `cmd.exe` can interpret one — so **any** caller
spawning it (Rust's `std`/`tokio::process::Command`, or this repo's own `selftest.mjs`
via `{ shell: true }`) is really spawning `cmd.exe`, which in turn spawns `node.exe` to
run `fake-adb.mjs`. That's two OS processes for what looks like one child.

This matters for the backend's stop path (`services::stream::stop`,
`ChildHandle::kill`/`start_kill` in `services/stream.rs`): `TerminateProcess` is called
on the *immediate* child only — `cmd.exe` — not on the `node.exe` grandchild it spawned.
Verified empirically (kill only the top-level `cmd.exe` PID, then poll for the
`node.exe` process): the `node.exe` process survives as a real, if short-lived, orphan.

This is **not** a functional bug in the stop path itself — `run_streaming_task`'s
`cancel` branch (services/stream.rs:1294-1301) fires independently of the child
process's lifecycle and reports `StreamStopped` immediately, so `stop_adb_stream`
completes correctly either way. The orphaned `fake-adb.mjs` process self-heals: once
Rust's reader task drops its end of the stdout pipe (which happens as soon as the
`cancel` branch runs), the orphan's next `process.stdout.write()` — at most one 50ms
batch interval later — fails with `EPIPE`, which `fake-adb.mjs` treats as a stop signal
and exits on its own. Net effect: a bounded (~50ms) cleanup delay, not a hang, and no
resource leak that survives a bench session.

A **real** `adb.exe` (used in actual production streaming, never a `.cmd` file) has no
such wrapping and no such delay — this is purely a cost of using a script-based shim for
the bench. It does not need a backend change: propagating kill through the `cmd.exe`
layer (e.g. a Windows Job Object associating the whole tree) would only benefit this
fixture, at the cost of new complexity in a path production traffic never takes.
