/**
 * Human-readable descriptions for Android bugreport/dumpstate sections.
 *
 * Sections are identified by the name extracted from `------ SECTION NAME ------` headers.
 * getSectionDescription() tries exact match first, then prefix rules for families
 * like SHOW MAP, DUMPSYS, CHECKIN, UFS, PSI, etc.
 */

const EXACT: Record<string, string> = {
  // ── Memory ────────────────────────────────────────────────────────────────
  'MEMORY INFO':
    'Physical memory breakdown (/proc/meminfo) — total, free, cached, buffers, and swap usage.',
  'VIRTUAL MEMORY STATS':
    'Kernel virtual memory statistics (/proc/vmstat) — page faults, swaps, I/O wait, and reclaim events.',
  'VMALLOC INFO':
    'Kernel vmalloc allocations (/proc/vmallocinfo) — non-contiguous virtual memory regions allocated by drivers.',
  'SLAB INFO':
    'Kernel slab allocator cache statistics (/proc/slabinfo) — object counts, sizes, and reuse ratios per cache.',
  'ZONEINFO':
    'Per-NUMA-zone memory statistics (/proc/zoneinfo) — free page counts by memory zone and migratetype.',
  'PAGETYPEINFO':
    'Memory fragmentation info (/proc/pagetypeinfo) — free pages grouped by type (Unmovable, Movable, Reclaimable) and buddy order.',
  'BUDDYINFO':
    'Buddy allocator free-page counts (/proc/buddyinfo) — contiguous free memory blocks by order; indicates external fragmentation.',
  'SWAP INFO': 'Swap device usage (/proc/swaps) — active swap partitions/files, size, and utilisation.',
  SWAPPINESS:
    'Current vm.swappiness value — controls how aggressively the kernel swaps to disk (0 = prefer keeping pages in RAM).',
  'ZRAM WRITEBACK_LIMIT':
    'ZRAM writeback size cap — maximum amount of compressed memory the kernel is allowed to write to the backing block device.',
  'ZRAM BD_STAT':
    'ZRAM backing device I/O counters — pages read back from and written to the writeback storage.',
  'ZRAM MM_STAT':
    'ZRAM memory statistics — original data size, compressed size, memory used, and swap in/out counters.',
  'SMAPS OF ALL PROCESSES':
    'Detailed virtual memory maps for every process (smaps) — VSS, RSS, PSS, USS, and dirty page breakdown per mapping.',
  PROCRANK:
    'Process memory ranking by PSS — sorted list of all processes showing who consumes the most physical memory.',
  LIBRANK:
    'Shared-library memory ranking — shows each .so file\'s total PSS contribution across all processes that load it.',
  'UMR(UNIFIED MEMORY RECLAIMER) INFO':
    'Samsung Unified Memory Reclaimer diagnostics — tracks memory pressure events and proactive reclaim activity.',
  'PAGEBOOST INFO':
    'Samsung PageBoost diagnostics — proactive memory prefetch statistics for reducing cold-start latency.',

  // ── CPU / Process ──────────────────────────────────────────────────────────
  'CPU INFO':
    'CPU usage by process at capture time (top -n 1) — quickly identifies which processes are consuming the most CPU.',
  'PROCESSES AND THREADS':
    'Full process and thread list (ps -AT) — all PIDs and TIDs with CPU state, scheduling policy, and priority.',
  IOTOP:
    'I/O usage ranked by process — shows which processes are generating the most disk read/write activity.',
  UPTIME:
    'System uptime and load averages (/proc/uptime) — time since last boot and 1-min / 5-min / 15-min CPU load.',
  'KERNEL CPUFREQ':
    'Current CPU clock frequency per core — useful for detecting thermal throttling or governor misbehaviour.',

  // ── Log buffers ────────────────────────────────────────────────────────────
  'SYSTEM LOG':
    'Android logcat system buffer — primary log from framework services (ActivityManager, PackageManager, WindowManager, etc.).',
  'EVENT LOG':
    'Android logcat events buffer — structured binary events emitted by system_server (activity lifecycle, battery, etc.).',
  'RADIO LOG':
    'Android logcat radio buffer — telephony and modem events (RIL requests, SIM state, network registration).',
  'STATS LOG':
    'Android logcat stats buffer — metrics and statistics events used by the StatsD collection pipeline.',
  'KERNEL LOG':
    'Linux kernel ring buffer (dmesg) — driver messages, hardware interrupts, kernel warnings, and OOM events.',
  'LAST KMSG':
    'Kernel log from the previous boot (pstore / last_kmsg) — critical for analysing kernel panics, WDT resets, and reboots.',
  'LAST LOGCAT':
    'Logcat output captured during the previous boot — helps trace events leading up to an unexpected restart.',
  'SYSTEM LOG AFTER DONE':
    'Logcat tail captured after dumpstate finishes — captures any system activity that occurred during collection.',
  'LOG STATISTICS':
    'Logcat buffer statistics — line counts, rate, and overflow-drop counts per log buffer (main/system/radio/events).',

  // ── Network ────────────────────────────────────────────────────────────────
  'NETWORK INTERFACES':
    'Network interface list and configuration (ip link / ifconfig) — MAC address, MTU, flags, and state.',
  'NETWORK DEV INFO':
    'Per-interface TX/RX counters (/proc/net/dev) — bytes, packets, errors, and drops since boot.',
  'ARP CACHE':
    'ARP table entries (/proc/net/arp) — IP-to-MAC mappings for hosts on the local network.',
  NETSTAT:
    'Active socket connections (netstat) — listening ports, established connections, and socket states.',
  'DETAILED SOCKET STATE':
    'Detailed per-socket information (ss -eapn) — send/receive queue sizes, TCP state, socket options, and owning process.',
  'IP RULES':
    'IPv4 policy routing rules (ip rule) — priority-ordered list that selects which routing table is consulted for each packet.',
  'IP RULES v6':
    'IPv6 policy routing rules (ip -6 rule) — same as IP RULES but for IPv6 traffic.',
  'ROUTE TABLE IPv4':
    'IPv4 kernel routing table (ip route) — how the device forwards outbound IPv4 packets.',
  'ROUTE TABLE IPv6':
    'IPv6 kernel routing table (ip -6 route) — how the device forwards outbound IPv6 packets.',
  RT_TABLES:
    'Routing policy table name-to-ID map (/etc/iproute2/rt_tables) — human-readable aliases for routing table IDs.',
  'IPv4 ADDRESSES':
    'Assigned IPv4 addresses (ip -4 addr) — addresses, prefix lengths, and interface bindings.',
  'IPv6 ADDRESSES':
    'Assigned IPv6 addresses (ip -6 addr) — link-local, ULA, and global addresses per interface.',
  'IPv6 ND CACHE':
    'IPv6 neighbour discovery cache (ip -6 neigh) — IPv6 equivalent of ARP; maps addresses to MAC entries.',
  'MULTICAST ADDRESSES':
    'Joined multicast group memberships (ip maddr) — active multicast subscriptions per interface.',
  'SNMP INFO':
    'SNMP MIB-II counters (/proc/net/snmp) — TCP, UDP, IP, and ICMP error and traffic statistics.',
  'SNMP NETSTAT':
    'Extended SNMP network statistics (/proc/net/netstat) — additional TCP and IP counters beyond standard SNMP.',
  'SNMP6 INFO':
    'IPv6 SNMP MIB-II counters (/proc/net/snmp6) — IPv6 traffic and error statistics.',
  'SOFTNET STAT':
    'Per-CPU software network statistics (/proc/net/softnet_stat) — packet processing counters, throttle events, and drop counts.',
  'XFRM STATS': 'IPsec transform statistics — packet counts for encryption, decryption, and policy lookups.',
  'IP XFRM POLICY':
    'IPsec security policy database — rules that specify which traffic should be encrypted and with which SA.',
  IPTABLES:
    'IPv4 netfilter firewall rules (filter table) — ACCEPT/DROP/REJECT rules for INPUT, OUTPUT, and FORWARD chains.',
  'IPTABLES MANGLE':
    'IPv4 netfilter mangle table — rules that modify packet headers (TTL, TOS, marks) before routing.',
  'IPTABLES NAT':
    'IPv4 netfilter NAT table — network address translation rules (MASQUERADE, DNAT, SNAT).',
  'IPTABLES RAW':
    'IPv4 netfilter raw table — rules that run before connection tracking; used to exempt packets from conntrack.',
  IP6TABLES:
    'IPv6 netfilter firewall rules (filter table) — ACCEPT/DROP/REJECT rules for IPv6 chains.',
  'IP6TABLES MANGLE':
    'IPv6 netfilter mangle table — packet header modification rules for IPv6 traffic.',
  'IP6TABLES RAW':
    'IPv6 netfilter raw table — pre-conntrack rules for IPv6 traffic.',
  'TC FILTER EGRESS':
    'Traffic control egress classifiers (tc filter) — packet classification rules applied as packets leave an interface.',
  'TC FILTER INGRESS':
    'Traffic control ingress classifiers (tc filter) — packet classification rules applied as packets arrive on an interface.',
  'TC QDISC':
    'Traffic control queueing disciplines (tc qdisc) — bandwidth shaping and scheduling policies per interface.',
  'SERVICE HIGH connectivity':
    'Android ConnectivityService state dump — active network agents, default network, VPN state, and DNS config.',

  // ── Binder IPC ─────────────────────────────────────────────────────────────
  'BINDER FAILED TRANSACTION LOG':
    'Recent failed binder IPC transactions — shows dropped or rejected calls, useful for diagnosing IPC errors.',
  'BINDER TRANSACTION LOG':
    'Log of the most recent binder IPC transactions — call history with source/destination PID and code.',
  'BINDER TRANSACTIONS':
    'Currently in-flight binder transactions — identifies any IPC calls that are blocked or awaiting a reply.',
  'BINDER STATS':
    'Binder IPC driver statistics — total transaction counts, BC/BR command frequencies, and object counts.',
  'BINDER STATE':
    'Current binder thread pool state per process — thread counts, waiting threads, and pending work.',

  // ── Filesystem / Storage ───────────────────────────────────────────────────
  'FILESYSTEMS & FREE SPACE':
    'Mounted filesystem disk usage (df -h) — used and available space for every partition.',
  'FILESYSTEMS & FREE INODE':
    'Mounted filesystem inode usage (df -i) — used and free inode counts; a full inode table prevents new files even with free space.',
  'MOUNT POINT DUMP':
    'All mounted filesystems with full mount options (/proc/mounts) — useful for verifying partition flags (ro/rw, noexec, etc.).',
  'LIST OF OPEN FILES':
    'Open file descriptors by process (lsof) — reveals file handle leaks and which processes hold specific files or sockets.',
  'DEVICE-MAPPER':
    'Device-mapper table entries (dmsetup table) — shows dm-verity, dm-linear, and ZRAM backing-device mappings.',
  'STORAGED IO INFO':
    'Android StorageD per-process I/O statistics — cumulative read/write bytes per UID as tracked by storaged.',
  'DUMP BLOCK STAT':
    'Block device I/O statistics (/sys/block/.../stat) — sector read/write counts, queue wait times, and I/O in progress.',
  'FILESYSTEM DEBUG INFO.':
    'Samsung filesystem debug state — internal filesystem health and consistency check output.',
  'STORAGE BUFFER (/proc/fslog/stlog)':
    'Samsung storage log buffer — low-level storage events captured by the kernel fslog driver.',
  LPDUMP:
    'Logical partition (super) layout (lpdump) — Android dynamic partition metadata: partition names, sizes, and group membership.',

  // ── UFS storage ─────────────────────────────────────────────────────────────
  'UFS PART NUMBER': 'UFS flash chip part number — identifies the specific NAND component.',
  'UFS REV': 'UFS specification revision — protocol version supported by the flash chip.',
  'UFS VENDOR': 'UFS flash chip manufacturer ID.',
  'UFS LT': 'UFS lifetime estimation — wear indicator for the flash storage (0x01 = normal, 0x0B = near end of life).',
  'UFS FLT': 'UFS fault log — hardware fault events recorded by the flash controller.',
  'UFS ERR SUMMARY':
    'UFS error summary — counts of UFS command errors, transport errors, and fatal events.',
  'UFS ERR SUM': 'UFS error count summary — abbreviated version of UFS ERR SUMMARY.',
  'UFS FATAL CNT': 'UFS fatal error count — number of unrecoverable UFS errors since last reset.',
  'UFS OP CNT': 'UFS operation count — total read/write/erase operations since manufacture.',
  'UFS QUERY CNT': 'UFS query command count — NOP, attribute read/write, and descriptor query counts.',
  'UFS UIC CMD CNT': 'UFS UIC (UniPro Interconnect) command count — MIPI UniPro layer command statistics.',
  'UFS UIC ERR CNT': 'UFS UIC error count — UniPro link-layer errors; high values suggest PHY or connector issues.',
  'UFS UTP CNT':
    'UFS UTP (UFS Transport Protocol) transaction count — total transfer requests submitted to the host controller.',
  'UFS SENSE ERR CNT': 'UFS SCSI sense error count — number of error responses carrying SCSI sense data.',
  'UFS CMD LOG': 'UFS command log — last N UFS/SCSI commands with timestamps, LBA, and completion status.',
  'UFS ELI': 'UFS Exception Log Index — firmware exception events logged by the UFS device.',
  'UFS IC': 'UFS internal clock diagnostics.',
  'UFS SHI': 'UFS Samsung Hardware Information — OEM-specific flash health and configuration fields.',

  // ── Battery ────────────────────────────────────────────────────────────────
  'BATTERY LOG':
    'Android battery statistics history — charge/discharge cycles, screen-on time, wakelocks held, and power consumers.',
  'BATTERY LPM RECORD':
    'Low Power Mode entry/exit history — timestamps and trigger reasons for each LPM transition.',
  'POWER OFF RESET REASON':
    'Reason for the last power-off or hardware reset — distinguishes user-initiated shutdown from crash/watchdog/thermal resets.',

  // ── Build / System ─────────────────────────────────────────────────────────
  'SYSTEM PROPERTIES':
    'All Android system properties (getprop) — build fingerprint, feature flags, ro.*, persist.*, and runtime configuration.',
  'UPDATED APEX LIST':
    'APEX modules that override factory defaults — shows which runtime Android modules have been updated via the Play Store.',
  'PRODUCT BUILD-TIME RELEASE FLAGS':
    'Build-time aconfig feature flags from the product partition — static feature switches baked in at build time.',
  'SYSTEM BUILD-TIME RELEASE FLAGS':
    'Build-time aconfig feature flags from the system partition — static feature switches in the core OS image.',
  'SYSTEM_EXT BUILD-TIME RELEASE FLAGS':
    'Build-time aconfig feature flags from the system_ext partition — OEM-specific static feature switches.',
  'ACONFIG FLAGS':
    'Runtime aconfig feature flag values — current A/B feature flag state; may differ from build-time defaults if server-pushed.',
  'SDK EXTENSIONS':
    'SDK extension level versions — which optional API extension sets are present on this device.',
  PRINTENV:
    'Environment variables visible to the dumpstate process — PATH, LD_LIBRARY_PATH, and other shell/process settings.',
  LSMOD: 'Loaded kernel modules (lsmod) — dynamically loaded device drivers and kernel extensions.',
  'MODULES INFO':
    'Detailed kernel module information (modinfo) — module sizes, dependencies, parameters, and source file paths.',
  'HARDWARE HALS':
    'Installed Android HAL (Hardware Abstraction Layer) implementations — which hardware interfaces are provided and by which binaries.',

  // ── App / Service ──────────────────────────────────────────────────────────
  'APP ACTIVITIES':
    'ActivityManager state for running and recent activities — task stacks, activity records, and lifecycle state.',
  'APP PROVIDERS PLATFORM':
    'Content provider registrations from platform packages — authorities, read/write permissions, and bound processes.',
  'APP PROVIDERS NON-PLATFORM':
    'Content provider registrations from non-platform (vendor/OEM) packages.',
  'APP PROVIDERS SEC_MEDIA':
    'Content provider registrations from Samsung media packages.',
  'APP SERVICES PLATFORM':
    'Bound and started service registrations from platform packages — service records, connections, and bindings.',
  'APP SERVICES NON-PLATFORM':
    'Service registrations from non-platform (vendor/OEM) packages.',
  'APP SERVICES SEC_MEDIA':
    'Service registrations from Samsung media packages.',
  'ANR FILES':
    'ANR (Application Not Responding) trace files — thread dumps captured at the moment an ANR was declared. Critical for diagnosing UI hangs.',
  'DROPBOX SYSTEM APP CRASHES':
    'Recent app crash reports stored in Dropbox — Java/native crash logs from third-party and system apps.',
  'DROPBOX SYSTEM SERVER CRASHES':
    'Recent system_server crash and restart reports — indicates OS instability if frequent.',
  'DROPBOX SYSTEM WATCHDOG CRASHES':
    'Android watchdog-triggered system_server kills — the watchdog fires when a critical lock is held too long.',
  'CHECKIN BATTERYSTATS':
    'Compact machine-readable battery stats for upload/analytics — checkin format used by the Android CI pipeline.',
  'CHECKIN NETSTATS':
    'Compact machine-readable network usage statistics — per-UID/interface byte and packet counts.',
  'CHECKIN PACKAGE':
    'Compact package list in checkin format — installed package names, versions, and installer origins.',
  'CHECKIN PROCSTATS':
    'Compact process memory-over-time statistics — PSS samples per process state for system health monitoring.',
  'CHECKIN USAGESTATS':
    'Compact app usage time statistics — foreground/background time per app in checkin format.',
  STATSDSTATS:
    'StatsD metrics daemon diagnostics — collection pipeline health, atom counts, and queue statistics.',
  'VM TRACES JUST NOW':
    'Java VM thread stack traces captured at this moment — shows exactly what every managed thread is doing; essential for diagnosing hangs.',
  'ONE UI HOME ACTIVITY DUMP':
    'Samsung One UI launcher internal state — home screen pages, widget layout, and activity back stack.',

  // ── Debug / Diagnostic ─────────────────────────────────────────────────────
  BUGREPORT_PROCDUMP:
    'Process core dump or diagnostic snapshot embedded in the bugreport — used by OEM diagnostics tools.',
  'DUMPSTATE BOARD BEFORE':
    'OEM/SoC-specific diagnostics collected before the standard dumpstate sections — vendor-defined hardware state.',
  'DUMPSTATE BOARD AFTER':
    'OEM/SoC-specific diagnostics collected after all standard sections — vendor post-collection data.',
  'DUMPSYS CRITICAL':
    'Critical Android service dumps that must complete quickly — telephony, battery, and other time-sensitive services.',
  'DUMPSYS HIGH':
    'High-priority Android service dumps — services where delay would degrade the report quality.',
  'DUMPSYS NORMAL':
    'Standard Android service dumps — all remaining services not covered by CRITICAL or HIGH priority.',
  'SERIALIZE PERFETTO TRACE':
    'Perfetto system trace serialized into the bugreport — a detailed timeline of CPU scheduling, binder calls, and memory events. Open in ui.perfetto.dev.',
  'AP RESET INFO EXTEND':
    'Samsung application processor extended reset/crash history — previous panic/watchdog/thermal reset details from firmware.',

  // ── Display ────────────────────────────────────────────────────────────────
  'DISPLAY DEBUG INFO':
    'Display subsystem debug state — resolution, refresh rate, HDR mode, brightness, and panel diagnostic counters.',
  'Displayport log':
    'DisplayPort link training and connection log — DP PHY negotiation events, link status, and HDCP handshake.',
  'Dmabuf dump':
    'DMA buffer inventory — lists all active DMA-BUF allocations by size, exporter, and attachment, useful for detecting GPU/camera memory leaks.',
  'Dmabuf per-buffer/per-exporter/per-device stats':
    'DMA-BUF usage breakdown by allocator (exporter) and consuming device — shows who is holding GPU/display/camera buffers.',

  // ── Audio ──────────────────────────────────────────────────────────────────
  'asound cards': 'ALSA sound card list (/proc/asound/cards) — registered audio devices and their driver names.',
  'sound info log':
    'Audio subsystem information log — AudioFlinger thread states, effect chains, and mix parameters.',
  'sound boot log': 'Audio subsystem log from the boot sequence — codec initialisation and audio HAL startup messages.',

  // ── NFC ────────────────────────────────────────────────────────────────────
  'NFC SYSTEM LOG':
    'NFC (Near Field Communication) system log — NFC state machine, tag detection events, and payment/HCE session activity.',

  // ── Samsung OEM ────────────────────────────────────────────────────────────
  'GMR INFO':
    'Samsung Graphics Memory Reclaimer current state — active reclaim targets, thresholds, and reclaimed pages.',
  'GMR history':
    'Samsung Graphics Memory Reclaimer event history — timeline of GPU memory pressure events and reclaim actions.',
  'GenIE Stats':
    'Samsung GenIE (on-device AI) statistics — inference counts, model load times, and resource usage for on-device AI features.',
  'SSG inflight IO':
    'Samsung Storage Gateway in-flight I/O requests — active block commands waiting for the UFS/storage controller.',
  'SSG requests info':
    'Samsung Storage Gateway queued request information — pending and recently completed storage requests.',
  'SDcard error': 'SD card error log (Samsung) — read/write errors, re-init events, and SD controller fault counters.',
  'SDcard state': 'SD card current state (Samsung) — detection status, capacity, speed class, and power mode.',
  'CD CNT': 'Card detect count (Samsung) — number of SD card insertion/removal events since boot.',
  'USB LOG':
    'USB connection and charging log (Samsung) — connector type detection, charging mode negotiation, and USB state transitions.',
  'Sec voter':
    'Samsung Secure voter diagnostic — consensus votes from subsystems for power, clock, and resource arbitration.',
  'EBPF MAP STATS':
    'eBPF (extended Berkeley Packet Filter) map usage statistics — sizes and entry counts for kernel eBPF data structures used by networking and tracing.',
  'PPNANDSWAP INFO':
    'Samsung PPNANDSWAP (Persistent Page NAND Swap) info — swap-to-flash utilisation and performance counters.',

  // ── Recovery ───────────────────────────────────────────────────────────────
  'PRINT RECOVERY HISTORY':
    'Recovery partition boot attempt history — previous recovery mode boots, factory resets, and OTA update records.',
  'PRINT RECOVERY EXTRA HISTORY':
    'Extended recovery boot history — additional OEM recovery logs beyond the standard history.',
  'PRINT RECOVERY LOG':
    'Full recovery partition log from the most recent recovery boot — useful for diagnosing failed OTA updates.',
  'PRINT RTTS HISTORY':
    'Samsung RTTS (Runtime Test and Trace System) history — OEM diagnostic trace data from previous boots.',
  'PRINT LIST OF FILE IN /data/log':
    'Directory listing of /data/log — shows which log files are present without dumping their contents.',
  'PRINT LIST OF FILE IN /data/local/traces':
    'Directory listing of /data/local/traces — lists ANR traces and other diagnostic trace files.',
  'PRINT LIST OF FILE IN /data/local/tmp':
    'Directory listing of /data/local/tmp — shows temporary files left by tools or the OS.',

  // ── Misc ───────────────────────────────────────────────────────────────────
  'mount debugfs':
    'Dumpstate internal step: mounts the kernel debugfs filesystem to enable access to debug counters.',
  'chmod debugfs':
    'Dumpstate internal step: adjusts debugfs permissions so subsequent commands can read kernel debug files.',
  'unmount debugfs':
    'Dumpstate internal step: unmounts debugfs after collection is complete to restore normal security posture.',
  'DLOG HISTORY IN /data/log/fsdbg/':
    'Samsung filesystem debug log history — historical fsdbg entries stored on-device for persistent fault tracking.',
  'UFS HISTORY IN /data/log/fsdbg':
    'UFS storage debug history — UFS driver fault and performance events persisted to the fsdbg log store.',
  'SEC DIR LIST DEBUG INFO.':
    'Samsung secure directory listing debug info — diagnostic state for secure (Knox) folder directories.',
  'SEC DIR SIZE DEBUG INFO.':
    'Samsung secure directory size debug info — size metrics for encrypted Knox/secure folder storage.',
  'TRASH DIR DEBUG INFO.':
    'Trash directory debug info — size and file count in the system trash/recycle location.',
};

/**
 * Returns a human-readable description for the given bugreport section name,
 * or undefined if no description is available.
 */
export function getSectionDescription(name: string): string | undefined {
  // Exact match
  const exact = EXACT[name];
  if (exact) return exact;

  // ── Prefix families ─────────────────────────────────────────────────────
  if (name.startsWith('SHOW MAP '))
    return 'Per-process virtual memory map (smaps) — VSS/RSS/PSS breakdown for this process or thread.';

  if (name.startsWith('DUMPSYS '))
    return `Android service state dump — internal diagnostic output from the "${name.slice(8)}" system service.`;

  if (name.startsWith('CHECKIN '))
    return `Compact machine-readable ${name.slice(8).toLowerCase()} data in checkin format, used for automated analytics.`;

  if (name.startsWith('APP ACTIVITIES'))
    return 'ActivityManager state — running and recent activities, task stacks, and lifecycle records.';

  if (name.startsWith('APP SERVICES'))
    return 'Service manager state — bound and started service records and their client bindings.';

  if (name.startsWith('APP PROVIDERS'))
    return 'Content provider registrations — authorities, permissions, and bound process info.';

  if (name.startsWith('UFS '))
    return `Universal Flash Storage diagnostic: ${name.slice(4)} — UFS controller or flash chip telemetry.`;

  if (name.startsWith('UFS HISTORY IN '))
    return `UFS storage debug history stored in ${name.slice(15)} — persisted fault and performance events.`;

  if (name.startsWith('DLOG HISTORY IN '))
    return `Samsung filesystem debug log history stored in ${name.slice(16)}.`;

  if (name.startsWith('PRINT LIST OF FILE IN '))
    return `Directory listing of ${name.slice(22)} — file names and sizes without dumping contents.`;

  if (name.startsWith('PRINT RECOVERY'))
    return 'Recovery partition history — previous recovery-mode boot attempts, OTA updates, and factory resets.';

  if (name.startsWith('PSI '))
    return `Pressure Stall Information for ${name.slice(4)} — percentage of time tasks spent waiting due to ${name.slice(4)} pressure.`;

  if (name.startsWith('DROPBOX '))
    return `Dropbox crash/watchdog reports for ${name.slice(8).toLowerCase()} — recent fault records stored by DropBoxManager.`;

  if (name.startsWith('SERVICE HIGH '))
    return `Android high-priority service dump for "${name.slice(13)}" — service internal state collected with elevated priority.`;

  if (name.startsWith('SSG '))
    return `Samsung Storage Gateway (SSG) diagnostic — ${name.slice(4).toLowerCase()} data from the SSG block-layer shim.`;

  if (name.startsWith('GMR'))
    return 'Samsung Graphics Memory Reclaimer (GMR) — manages GPU buffer eviction under memory pressure.';

  if (name.startsWith('ROUTE TABLE'))
    return `Kernel IP routing table — entries that determine how ${name.includes('IPv6') ? 'IPv6' : 'IPv4'} packets are forwarded.`;

  if (name.startsWith('IP6TABLES'))
    return `IPv6 netfilter rules${name.includes('MANGLE') ? ' (mangle table — packet header modification)' : name.includes('RAW') ? ' (raw table — pre-conntrack rules)' : ' (filter table — packet accept/drop rules)'}.`;

  if (name.startsWith('IPTABLES'))
    return `IPv4 netfilter rules${name.includes('MANGLE') ? ' (mangle table — packet header modification)' : name.includes('NAT') ? ' (NAT table — address/port translation)' : name.includes('RAW') ? ' (raw table — pre-conntrack rules)' : ' (filter table — packet accept/drop rules)'}.`;

  return undefined;
}
