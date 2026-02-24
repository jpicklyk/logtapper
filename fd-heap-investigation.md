# FD / Heap Investigation — dumpstate.txt (Jan 5, 01-05 13:02 boot)

## Device Profile

- **RAM**: 4 GB (confirmed by ChimeraStrategy: `ramSizeGb: 4`)
- **OS**: Android 14, Samsung One UI (ART runtime)
- **Log source**: `dumpstate.txt` (bugreport), 1,082,474 lines
- **Boot time captured**: `01-05 13:02:00` through `~01-05 13:21:00`
- **Previous boot also captured** in bugreport history section (PID 1505, up to `12:43–13:01`)

---

## Executive Summary

Two distinct problems are present, sharing a time window but **not sharing a root cause**:

1. **Chronic FD leak in system_server** — 840+ file descriptors are opened during boot and never released. This persists across both captured boots. Samsung silently raises `RLIMIT_NOFILE` above 1024 to suppress `EMFILE` errors.

2. **Acute heap pressure during boot** — caused by a recursive WTF exception storm (Knox/UCM service ordering bug) concurrent with the normal 4 GB boot-storm. Resolves within ~90 seconds of boot.

The EBADF errors observed in Samsung Device Health Manager (`sdhms`) are a **consequence** of the FD churn, not an independent leak.

---

## Chronological Timeline

```
13:02:08     system_server (PID 1611) starts. FD count: 122. Heap: ~6/512 MB.
             LMKD connects. Samsung lmkd hook disabled (PSI fallback).

13:02:08–19  Samsung system services register en masse.
             FD count: 122 → 965 in 11 seconds (+843 FDs).
             These FDs are never released — chronic leak begins.

13:02:10     Memory pressure begins.
             SystemUI starts receiving onTrimMemory(20 = RUNNING_LOW) continuously.

13:02:10.6   ── RECURSIVE WTF STORM BEGINS ──
             Knox/UCM service init fails (device_policy not ready) → Log.wtf()
             → handleApplicationWtfInner (thread 1812)
             → addErrorToDropBox() → dropbox service not ready
             → ServiceNotFoundException → Log.wtf() again → loop
             ~530 iterations over 1.35 seconds, consuming ~10,100 log lines.
             Each iteration allocates a full Java exception + stack trace.

13:02:11.9   ── WTF STORM ENDS ── (dropbox service becomes available)
             Normal system_server boot resumes on main thread.

13:02:13     system_server GC: 63 MB / 87 MB used. 1.45s GC pause.

13:02:14.7   system_server explicit GC: 68 MB / 92 MB. 25% free. 1.11s pause.
             ← HEAP STRESS PEAK

13:02:15.0   ── PROCESS KILL STORM BEGINS ──
             ActivityManager starts killing "empty #17" cached processes.

13:02:15.6   system_server explicit GC: 64 MB / 88 MB. 27% free. 896ms pause.

13:02:16     HoneySpace reports: "low memory device true"

13:02:18.9   Gallery receives onTrimMemory(40 = RUNNING_CRITICAL), heap at 16 MB.

13:02:19     FD count hits 1024 (Linux default RLIMIT_NOFILE).
             Samsung raises RLIMIT_NOFILE beyond 1024 (no EMFILE errors).

13:02:20.5   honeyboard (Samsung pen input) NATIVE CRASH during onTrimMemory handler.

13:02:22–26  OneDrive killed (113 MB RSS), Tachyon killed (94 MB RSS),
             Settings killed (86 MB RSS). ~49 processes killed total.

13:02:24     com.sec.android.sdhms (PID 4061) hits EBADF ×2 during XML parsing
             in a BroadcastReceiver. FD was closed/recycled mid-parse.

13:02:36–40  Second wave of kills: webview sandboxes, GMS services, adservices.

13:03:19     FD count: 1100. Samsung RLIMIT raised, no EMFILE.

13:03:20–28  System-wide forced explicit GC across 46+ processes.
             Memory slowly recovers.

13:03:20+    Cached memory recovers to 255 MB. Boot storm subsides.

13:04–13:21  system_server FDs plateau at 1060–1090. Never recovers.
             Heap holds at 88–91 MB with steady GC background pressure.
             WaitTime in Watchdog: up to 762ms (GC blocking threads).

13:16:19     Final stable snapshot: cached 349 MB, free 86 MB — normal operation.
             FD count: 1084. Still elevated.
```

---

## Issue 1 — Chronic FD Leak in system_server

### Evidence

Samsung's Watchdog service logs FD counts for PID 1611 every 30 seconds. 97 data points were found across this log.

**Current boot (PID 1611):**

| Time | Sync # | Heap (MB) | FD Count | Notes |
|------|--------|-----------|----------|-------|
| 13:02:08 | 1 | 6 / 512 | **122** | Fresh start |
| 13:02:19 | 2 | 78 / 86 | **965** | +843 in 11 seconds |
| 13:02:49 | 3 | 82 / 89 | **1024** | Hit default Linux limit |
| 13:03:19 | 4 | 89 / 100 | **1100** | Samsung raised RLIMIT_NOFILE |
| 13:04–13:10 | 5–19 | 73–86 / 88 | **1060–1072** | Plateau, never recovers |
| 13:11–13:21 | 20–41 | 68–86 / 91 | **1060–1090** | Slow creep, WaitTime: 762ms |

**Previous boot (PID 1505, from bugreport history):**

| Time | Sync # | FD Count | Notes |
|------|--------|----------|-------|
| 09:29:04 | 682 | 1054 | Already elevated after long uptime |
| 09:43:52 | 688 | **1152** | Spike |
| 11:13:27 | 699 | **1161** | Highest in entire log |
| 12:43–13:01 | 701–737 | 1054–1103 | Stable high plateau |

### Analysis

- 843 FDs are opened in 11 seconds during boot and **never closed**
- A healthy system_server typically settles at 400–600 FDs post-boot
- The previous boot shows the same plateau pattern — this is **not a transient boot artifact**, it is a systemic leak in this Samsung build
- Samsung raises `RLIMIT_NOFILE` beyond 1024 to prevent `EMFILE` errors — this masks the leak but does not fix it
- No `FdThreshold` warnings, no `CloseGuard` or `StrictMode` FD violation reports — the leak is not being detected by Android's built-in tooling
- The FD plateau at ~1060–1090 correlates with the heap plateau at 88–91 MB: unclosed FD objects (FileInputStream, Socket, etc.) hold Java references that prevent GC from reclaiming heap

---

## Issue 2 — Recursive WTF Storm (Boot, Acute)

### Root Cause

`ActivityManagerService.addErrorToDropBox()` calls `Context.getSystemService("dropbox")` during early boot, before `DropBoxManagerService` has published itself. This throws `ServiceNotFoundException`, which is itself treated as a WTF condition, re-entering `addErrorToDropBox()`, creating an infinite loop.

### Trigger Chain

```
startOtherServices() initializes UniversalCredentialManagerService (Knox)
  → needs EnterpriseDeviceManager.getInstance()
  → needs "device_policy" service (not yet published)
  → ServiceNotFoundException logged → Log.wtf() called

Log.wtf() → handleApplicationWtfInner() [thread 1812, AMS ServiceThread]
  → addErrorToDropBox()
  → Context.getSystemService("dropbox")
  → "dropbox" service not yet published
  → ServiceNotFoundException thrown
  → exception handler calls Log.wtf() [recursive]
  → handleApplicationWtfInner() → addErrorToDropBox() → ...
```

### Statistics

| Metric | Value |
|--------|-------|
| Start | Line 61832 — `01-05 13:02:10.618` |
| End | Line ~71950 — `01-05 13:02:11.969` |
| Duration | **~1.35 seconds** |
| Lines consumed | **~10,100** |
| Approximate iterations | **~530** |
| Thread | 1812 (AMS ServiceThread) |
| Main thread blocked? | No — boot continues on thread 1611 |

### Heap Impact

Each iteration allocates:
- `ServiceNotFoundException` object + message string
- Full stack trace (20+ frames)
- `ServiceManager.ServiceNotFoundException` wrapper

At ~530 iterations, this creates thousands of short-lived objects that saturate the young generation, triggering concurrent GC. Combined with the normal boot-storm allocations, this pushed system_server to 25% heap headroom and 1.45-second GC pauses.

### Confirmation

`system_server_wtf` dropbox tag appears in later `incidentd` dumps (lines 175365, 213127, 1072267), confirming the WTF events were eventually recorded once the dropbox service became available.

---

## Issue 3 — EBADF in sdhms (Consequence of FD Churn)

### Process Identity

| Field | Value |
|-------|-------|
| PID | 4061 |
| UID | 1000 (system) |
| Package | `com.sec.android.sdhms` |
| Name | Samsung Device Health Manager Service |
| Role | Battery stats, thermal overheat control, power anomaly tracking, app usage |
| Registered receivers | 81 BroadcastReceivers |
| ContentProviders | FASProvider, BatteryStatsDBProvider, SmartManagerProvider |

### Error Detail

Two EBADF events at `13:02:24.539` and `13:02:24.601` (lines 132758, 133022):

```
java.io.IOException: read failed: EBADF (Bad file descriptor)
  at libcore.io.Linux.readBytes (Native Method)
  at libcore.io.IoBridge.read (IoBridge.java:604)
  at java.io.FileInputStream.read
  at java.io.BufferedInputStream.fill
  at KXmlParser.setInput
  at DocumentBuilderImpl.parse
  at DocumentBuilder.parse
  → [obfuscated Samsung handler chain]
  → q.f.onReceive  ← BroadcastReceiver
  → S1.x.handleMessage ← Handler message loop
```

### Analysis

The process is in a `BroadcastReceiver.onReceive()` callback handling boot-time battery/power configuration. It opens a `FileInputStream` for XML parsing via `DocumentBuilder.parse()`. The underlying FD is closed or recycled before the parse completes — a use-after-close race condition.

**Why EBADF appears at 13:02:24**: system_server's FD table is at ~965–1024 at this moment, churning rapidly. When a FD number is recycled by the kernel for a new file, any component holding the old numeric FD gets EBADF on its next I/O operation.

No `CloseGuard` or `StrictMode` reports are generated because the FD is explicitly closed too early (not leaked/never-closed), which the built-in detectors do not catch.

**Secondary EBADF — PID 2478 (`com.sec.imsservice`) at `13:17:22`:**

```
java.io.IOException: write failed: EBADF (Bad file descriptor)
  via FastPrintWriter → IMSLog.dump → ImsServiceSwitchBase.dump → SettingsProvider.dump
  → ActivityThread.handleDumpProvider
```

A dumpstate pipe FD was closed prematurely during IMS log dumping. Unrelated to the boot-time FD storm.

---

## Issue 4 — SQLite Failures in Radio Daemon (Independent)

All 18 `SQLiteCantOpenDatabaseException` occurrences are from **PID 2321** (radio, RIL daemon):

- **Path**: `/data/vendor/secradio/sem_database_0.db`
- **Error**: `SQLITE_CANTOPEN_ENOENT[1806]` — "Directory /data/vendor/secradio doesn't exist"
- **Retries**: At 13:03:27, 13:16:37, 13:20:46 (periodic retry, ~13-minute intervals then ~4 minutes)

This is **not FD exhaustion**. The directory simply does not exist in the filesystem. It is a Samsung vendor configuration issue — an init script or factory provisioning step is missing.

---

## Issue 5 — Other Independent FD Errors

**SmartThings/OneConnect (PID 6660, `com.samsung.android.oneconnect`):**
- 28 `IPv6 IPV6_JOIN_GROUP failed: Bad file descriptor` errors clustered at 13:03:28
- UDP multicast socket is being torn down and recreated during network init; stale socket FD referenced before teardown completes

**QC2V4l2Driver (PID 1133):**
- 15 `Invalid device driver fd:-1` errors during early boot
- Qualcomm video4linux HAL failed to open device nodes — HAL initialization issue, not FD exhaustion

**sscrpcd (PID 771, Qualcomm ADSP RPC daemon):**
- 50+ `remote_handle_open failed for adsp_default_listener` errors looping every ~25ms from `08:23 20:45:47` through `01:05 13:02:04`
- Completely unrelated — the ADSP secure computation daemon cannot connect to its listener service during boot. Qualcomm-specific initialization ordering issue.

---

## Heap Pressure Summary

| Time | Event | system_server heap | Free % | GC duration |
|------|-------|--------------------|--------|-------------|
| 13:02:01 | Background GC | 55 / 79 MB | 30% | 160ms |
| 13:02:10 | Background GC | 37 / 61 MB | 38% | 115ms |
| 13:02:13 | Background GC | 63 / 87 MB | 27% | **1.45s** |
| 13:02:14 | **Explicit GC** | **68 / 92 MB** | **25%** | **1.11s** |
| 13:02:15 | **Explicit GC** | 64 / 88 MB | 27% | 896ms |
| 13:02:27 | Background GC | **71 / 95 MB** | **25%** | 976ms |
| 13:02:32 | Background GC | 66 / 90 MB | 26% | 676ms |

**Process kills by ActivityManager (49+ total, "empty #17" category):**

| Time window | Notable kills (RSS) |
|-------------|---------------------|
| 13:02:15–16 | cellbroadcastreceiver, rampart, calendar |
| 13:02:17–18 | mdm, messaging, Settings |
| 13:02:19–22 | com.microsoft.skydrive **113 MB**, com.google.android.apps.tachyon **94 MB**, com.android.settings **86 MB**, gallery3d, photos |
| 13:02:36–40 | webview sandboxes ×2, adservices, GMS services |

**onTrimMemory signals:**

| Time | Recipient | Level |
|------|-----------|-------|
| 13:02:10 onward | SystemUI (PID 2372) | 20 = RUNNING_LOW (continuous) |
| 13:02:18 | FaceService | 20 = RUNNING_LOW |
| 13:02:18.9 | Gallery | **40 = RUNNING_CRITICAL** |
| 13:02:20.5 | honeyboard | 20 = RUNNING_LOW → **native crash** |

**am_meminfo recovery:**

| Time | Cached | Free |
|------|--------|------|
| 13:03:20 | 255 MB | 94 MB |
| 13:16:19 | 349 MB | 86 MB — normal operation |

---

## Root Cause Map

```
CHRONIC (persists across reboots, never self-heals):
  system_server FD leak: ~840 FDs opened during boot, never released
  │
  ├─ Consequence: Samsung raises RLIMIT_NOFILE (masks EMFILE errors)
  ├─ Consequence: heap plateau at 88–91 MB (FD objects hold Java refs)
  ├─ Consequence: Watchdog WaitTime up to 762ms (GC blocking main thread)
  └─ Consequence: EBADF in sdhms (PID 4061) — FD recycled mid-parse

ACUTE (boot window only, 13:02:10–13:03:20):
  Recursive WTF storm (Knox/UCM → dropbox service ordering race)
  │
  ├─ 530 exception allocations → heap spike to 25% free
  ├─ GC pauses to 1.45 seconds
  ├─ Two forced explicit GCs
  └─ Concurrent with normal 4 GB boot-storm (49+ process kills)
       └─ onTrimMemory(RUNNING_CRITICAL) + honeyboard native crash

INDEPENDENT:
  SQLite CANTOPEN in radio PID 2321: /data/vendor/secradio/ directory missing
  sscrpcd ADSP failures:             Qualcomm DSP boot ordering
  SmartThings IPV6_JOIN_GROUP EBADF: socket teardown race at 13:03:28
  QC2V4l2Driver fd:-1:               Qualcomm video HAL device node missing
```

---

## Recommended Fixes

### P0 — Audit and fix system_server FD leak

Find which subsystem opens ~840 FDs during boot and never closes them. Likely candidates:
- Binder service registrations holding `/dev/binder` FDs
- Samsung HAL client connections (each HAL open keeps a socket or device FD)
- Watchdog file monitors or `FileObserver` instances never unregistered
- Dex/OAT file mappings not closed after class loading

**Approach**: Take a `ls -la /proc/1611/fd | wc -l` snapshot at boot+5s, then boot+60s, and diff. Group by fd target type to find the category of FDs accumulating.

### P1 — Fix addErrorToDropBox() service ordering guard

```java
// Current (broken):
IDropBoxManagerService dropBox =
    ServiceManager.getService(Context.DROPBOX_SERVICE); // throws if not ready

// Fix option A — null check:
IDropBoxManagerService dropBox =
    IDropBoxManagerService.Stub.asInterface(
        ServiceManager.checkService(Context.DROPBOX_SERVICE)); // returns null if not ready
if (dropBox == null) return; // defer or drop

// Fix option B — boot phase gate:
if (mSystemServiceManager.isBootCompleted()) {
    addErrorToDropBox(...);
}
```

Or ensure `DropBoxManagerService` is published before any service that can call `addErrorToDropBox()`.

### P2 — Fix sdhms XML parsing FD lifecycle

```java
// Broken pattern in com.sec.android.sdhms:
FileInputStream fis = new FileInputStream(configFile);
// ... fis stored somewhere, closed elsewhere ...
documentBuilder.parse(fis); // EBADF if fis already closed

// Fix:
try (FileInputStream fis = new FileInputStream(configFile)) {
    documentBuilder.parse(fis);
} // always closed here, no race possible
```

Audit all BroadcastReceiver handlers in sdhms for file/stream lifetimes not scoped to the receiver's execution.

### P3 — Create /data/vendor/secradio/ in init

Add to the appropriate `init.rc` or vendor init script:

```
mkdir /data/vendor/secradio 0770 radio radio
```

Stops the radio daemon's periodic SQLite retry loop.

### P4 — Fix honeyboard onTrimMemory native crash

The Samsung pen input service (`honeyboard`) crashes in native code during memory trimming. Add a null-check or try/catch guard around the native memory release path in `onTrimMemory()`.

---

## Investigation Methodology

This investigation was conducted using the LogTapper MCP bridge against session `default` (dumpstate.txt, 1,082,474 lines). Four parallel agents were deployed:

| Agent | Focus |
|-------|-------|
| **crash-hunter** | Originating crash/trigger for the addErrorToDropBox loop |
| **pid-hunter** | Identity and EBADF root cause of PID 4061 |
| **heap-analyst** | GC timeline, lmkd kills, onTrimMemory events |
| **fd-scanner** | Watchdog FD telemetry, CloseGuard, SQLite failures, EBADF inventory |

Key MCP queries used: `logtapper_query` with `strategy=uniform` (full-log scan), `strategy=around` (local context), and `strategy=recent`. Pipeline results from `logtapper_get_pipeline_results` provided the exception count breakdown (1,104 total: 394 ServiceNotFoundException, 125 ErrnoException, 92 FileNotFoundException).
