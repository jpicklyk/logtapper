# Benchmark gate — run procedure (plan §C)

> Historical note (2026-09-16): the Solid UI is now the shipped default (`npx tauri dev`,
> `npm run build`, `npm test` all mean Solid). The React side of this comparison is reachable
> through `npm run tauri:react` / `npm run build:react` until `src-next/` is removed.

The gate compares the React viewer (`src-next/viewport/ReadOnlyViewer.tsx`) and the Solid
viewer (`src-solid/viewer/LogViewer.tsx`) with **one shared harness**,
`src-next/bench/harness.ts`, installed by both. Every command below is run from the repo
root in **PowerShell** (never prefix with `cd`).

The orchestrator runs this and writes the decision. No agent decides the gate.

---

## 0. Read this first — the build-mode constraint

The React hook is guarded by `import.meta.env.DEV && location.search.includes('bench=1')`.
Verified empirically on this checkout:

| Build command | `import.meta.env.DEV` | Bench hook in `dist/` |
|---|---|---|
| `npx vite build` (what `npm run build` does) | `false` | **absent** (dead-code eliminated) |
| `npx vite build --mode development` | `false` | absent |
| `NODE_ENV=development npx vite build --mode development` | `true` | **present** |

(`grep -c BENCH_RESULT dist/assets/*.js` → `0`, `0`, `1`.) Solid has no `DEV` guard, so its
hook survives a plain `npm run build:solid`.

**Consequence: a straight production-vs-production gate is impossible without changing the
guard.** Both frontends are therefore built in *development mode* for the comparison run,
which keeps the two sides symmetric in build mode. See §6 for the bias this introduces and
how to read around it — read §6 before interpreting any number.

If the orchestrator prefers a true production-vs-production gate, the one-line change is to
relax the guard in `src-next/viewport/ReadOnlyViewer.tsx` to
`(import.meta.env.DEV || import.meta.env.VITE_BENCH === '1')` and build with
`VITE_BENCH=1 npm run build`. That is outside P5's scope (the plan pins the `DEV` guard)
but is trivially applicable and removes §6 entirely.

---

## 1. Fixture

Deterministic 1,000,000-line logcat file (~0.9 s, gitignored `bench/`):

```powershell
node scripts/gen-logcat.mjs --lines 1000000 --out bench/logcat-1m.log
```

The same file is the viewer fixture (opened from disk) and the fake-adb replay source.

## 2. Build both frontends

```powershell
$env:NODE_ENV = "development"
npx vite build --mode development                              # -> dist/
npx vite build --mode development --config vite.solid.config.ts # -> dist-solid/
Remove-Item Env:NODE_ENV
```

Sanity-check both bundles carry the harness before launching anything:

```powershell
Select-String -Path dist\assets\*.js       -Pattern BENCH_RESULT -SimpleMatch -Quiet
Select-String -Path dist-solid\assets\*.js -Pattern BENCH_RESULT -SimpleMatch -Quiet
```

Both must print `True`. If the React one prints `False`, `NODE_ENV` did not reach the build.

Also build Solid's **true production** bundle for the §5 absolute-threshold pass:

```powershell
npm run build:solid     # -> dist-solid/ (production; overwrites the dev-mode one)
```

Build it *after* the dev-mode comparison run, or into a copy — the two share `dist-solid/`.

## 3. Launch each variant against its built dist

Tauri's CLI runs its **own built-in static server** when `build.devUrl` is unset and
`build.frontendDist` points at a directory (`@tauri-apps/cli/config.schema.json`, `devUrl`:
*"If you don't have a dev server or don't want to use one, ignore this option and use
`frontendDist` and point to a web assets directory, and Tauri CLI will run its built-in dev
server"*). `devUrl` is typed `["string","null"]`, so an overlay can null it out; `--config`
deep-merges into `src-tauri/tauri.conf.json`.

Two overlays are checked in:

```powershell
npx tauri dev --config scripts/bench/react.bench.conf.json   # React, from dist/
npx tauri dev --config scripts/bench/solid.bench.conf.json   # Solid, from dist-solid/
```

Each sets `devUrl: null`, `frontendDist` and an empty `beforeDevCommand` so no Vite dev
server starts and no rebuild is triggered. **Not verified by an agent** — P5 was not
permitted to run `tauri`/cargo. If `devUrl: null` fails to clear the inherited value, use
the fallback below and note which method produced the numbers.

**Fallback — Vite dev servers (use only if the overlays above fail).** Start
`npm run dev:react` (React, :1420) and `npm run dev` (Solid, :1421) and point Tauri at them
with an overlay whose `devUrl` carries the query directly, e.g.
`{"build":{"devUrl":"http://localhost:1420/?bench=1","beforeDevCommand":""}}`. HMR stays
on (Vite has no `--no-hmr` flag and `server.hmr` lives in configs P5 does not own); it adds
one idle websocket to *both* sides equally, so the comparison stays symmetric — but this is
a dev-server run, not a built-dist run, so say so in the results.

## 4. Enable the harness and take the file-mode numbers

1. Open devtools in the app window: **Ctrl+Shift+I** (available in debug/dev runs).
2. The harness only installs with `?bench=1`. A Tauri-served page has no address bar, so
   set it from the console — this reloads the page:

   ```js
   location.replace(location.pathname + '?bench=1')
   ```

3. Open `bench/logcat-1m.log` through the app's normal open-file flow and wait for the
   viewer to settle (no skeleton rows in the window).
   Row height must be the default 22 px on both sides: the React viewer hardcodes it,
   the Solid viewer reads `--viewer-row-h`. Do not set a custom row height or density
   for a gate run.
4. Confirm the harness is live and that time-to-first-painted-row was captured:

   ```js
   __bench            // -> { markLinePage, run, sweep, streamWindow, heap, metrics }
   ```

5. Run the file-mode pass (first-painted-row + scroll sweep + heap, no passive window):

   ```js
   await __bench.run({ streamSeconds: 0 })
   ```

   **This takes roughly 3 minutes.** The sweep is 200-line steps, one per rAF, 0 → end → 0:
   at 1M lines × 22 px that is ~5,000 steps each way ≈ 10,000 frames ≈ 166 s at 60 Hz.
   Keep the window focused and in the foreground for the whole run — a backgrounded WebView
   throttles `requestAnimationFrame` and every frame delta becomes meaningless.

6. Copy the `BENCH_RESULT {...}` console line (or `JSON.stringify(__bench.metrics())`) into
   `bench/react-file.json` / `bench/solid-file.json`.

## 5. Streaming window and heap

In the **same PowerShell session that will launch the app** (see
`scripts/fake-adb/README.md` for the full contract):

```powershell
$env:PATH = "$PWD\scripts\fake-adb;$env:PATH"
Get-Command adb        # must print scripts\fake-adb\adb.cmd, not platform-tools\adb.exe
```

Then, per variant:

1. Launch as in §3 from that session, apply `?bench=1` as in §4.
2. Start an ADB stream from the UI. The picker lists `emulator-5554` / `Pixel_6_API_34` —
   that confirms the shim, not a real device. Lines arrive at 100 / 50 ms.
3. Let tail mode settle (a few seconds), then take the 60 s passive window:

   ```js
   await __bench.streamWindow(60)
   ```

   It drives nothing — it only watches rAF deltas and long tasks while the stream runs.
4. Leave the stream running for **5 minutes total**, then:

   ```js
   __bench.heap()     // null if performance.memory is unavailable — see below
   ```

   Take a `heap()` reading right after the stream starts as well; heap *growth* is
   `after5min.usedJSHeapSize − atStart.usedJSHeapSize`.

   `performance.memory` is behind a flag in WebView2. If `heap()` returns `null`, launch
   with it enabled and re-take the two readings:

   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--enable-precise-memory-info"
   ```

   Cross-check either way with the `log-tapper.exe` + `msedgewebview2.exe` working set:

   ```powershell
   Get-Process log-tapper, msedgewebview2 | Select-Object Name, Id, @{n='RSS_MB';e={[math]::Round($_.WorkingSet64/1MB,1)}}
   ```

5. Save as `bench/react-stream.json` / `bench/solid-stream.json`.

Finally, repeat §4 step 5 (`run({ streamSeconds: 0 })`) once against Solid's **true
production** build for the §7 absolute thresholds, and save it as `bench/solid-prod.json`.

## 6. Fairness caveat — read before judging

Both sides run their **development** bundle in the comparison run (§0). That is symmetric
in build mode but not symmetric in cost:

- React's development `react-dom` carries per-render dev-only work the production build
  does not.
- `src-next/main.tsx` wraps the app in `<React.StrictMode>`, which **double-invokes render
  bodies and effects in a development build** and is a no-op in production. This is the
  single largest handicap. To remove it for the bench run, temporarily delete the
  `<React.StrictMode>` wrapper in `src-next/main.tsx`, rebuild, and **revert the edit
  afterwards** (local, uncommitted). Record in the results whether StrictMode was on.
- Solid's development build carries far less overhead than React's, so the dev-mode gate
  **flatters Solid**.

Reading rule:

- **Solid loses a metric → decisive fail.** React was handicapped and still won.
- **Solid wins a metric → the margin is inflated.** Do not quote the ratio as the
  production ratio. Judge pass-bar (b) (the absolute thresholds) from `bench/solid-prod.json`,
  which is a genuine production build.

Other measurement notes:

- `longTasks` come from `PerformanceObserver({entryTypes:['longtask']})`, which by
  definition only reports tasks **> 50 ms** — so `longTasks.count === 0` *is* the
  "zero long tasks > 50 ms" criterion. `longTasks.supported: false` means the browser has
  no such entry type and the zeros mean nothing.
- `busyPct` is `longTasks.totalMs / windowMs` — a **lower bound** on main-thread busy%,
  since work under 50 ms is invisible to the observer.
- `dropped` counts frames whose delta exceeded 20 ms; `droppedPct` is over observed frames.
- All durations are `performance.now()` ms rounded to 0.01.

## 7. Pass bar (verbatim from plan §C)

> Pass bar: (a) Solid ≤ React on every metric, no regression > 5 %; (b) absolutes: scroll
> p95 ≤ 16.7 ms and max ≤ 33 ms, zero long tasks > 50 ms over the 60 s streaming run, first
> painted row < 300 ms after `LinePage`, heap growth ≤ React + 15 % over 5 min. (b) failing
> while (a) passes is a conditional pass reported to the user; (a) failing fails the gate →
> React 19 + compiler fallback (`src-solid` removed, tokens/bench/backend kept).

## 8. Results table template

Fill both columns from the saved JSON. `scripts/bench-report.mjs` prints this table and the
pass/fail verdict automatically:

```powershell
node scripts/bench-report.mjs bench/react-file.json bench/solid-file.json `
  --react-stream bench/react-stream.json --solid-stream bench/solid-stream.json `
  --react-heap-growth <bytes> --solid-heap-growth <bytes>
```

| Metric | Source | React | Solid | Δ | Bar (b) | Verdict |
|---|---|---|---|---|---|---|
| First painted row (ms) | `firstPaintedRowMs` | | | | < 300 ms | |
| Scroll frame p50 (ms) | `sweep.p50` | | | | — | |
| Scroll frame p95 (ms) | `sweep.p95` | | | | ≤ 16.7 ms | |
| Scroll frame max (ms) | `sweep.max` | | | | ≤ 33 ms | |
| Sweep long tasks (count) | `sweep.longTasks.count` | | | | — | |
| Sweep long task max (ms) | `sweep.longTasks.maxMs` | | | | — | |
| Stream dropped frames (%) | `stream.droppedPct` | | | | — | |
| Stream frame p95 (ms) | `stream.p95` | | | | — | |
| Stream long tasks (count) | `stream.longTasks.count` | | | | 0 | |
| Stream busy (%) | `stream.busyPct` | | | | — | |
| Heap after 5 min (MB) | `heap.usedJSHeapSize` | | | | — | |
| Heap growth over 5 min (MB) | computed | | | | ≤ React + 15 % | |
| WebView2 RSS (MB) | `Get-Process` | | | | — | |

Record alongside the table: launch method (§3 overlay or §3 fallback), build mode, whether
`<React.StrictMode>` was active, whether `performance.memory` was available, and the exact
fixture (`bench/logcat-1m.log`, 1,000,000 lines).

## 9. Harness API reference

`window.__bench` (installed only with `?bench=1`; React additionally requires
`import.meta.env.DEV`):

| Member | What it does |
|---|---|
| `run({ stepLines?, streamSeconds? })` | First-painted-row + sweep + optional passive window + heap, as one JSON object. Logs it with the `BENCH_RESULT ` prefix. `stepLines` defaults to 200, `streamSeconds` to 60 — **pass `streamSeconds: 0` for the file-mode pass.** |
| `sweep(stepLines?)` | Just the scripted 0 → end → 0 scroll sweep. |
| `streamWindow(seconds?)` | Just the passive observation window (default 60 s). |
| `heap()` | `performance.memory` snapshot, or `null`. |
| `metrics()` | The last `run()` result. |
| `markLinePage()` | Called by the viewer when the first `LinePage` resolves; the harness then measures to the first rAF at which a row element exists. Not for manual use. |
