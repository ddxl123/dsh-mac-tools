# Monitor tab — Host/Client contract (State + fan control)

> Scope: a new **运行状态 / Status** tab in the Mac Tools panel that replicates the
> macOS App Store app **State** (宁波上官科技): real-time CPU / memory / disk /
> network / battery / uptime monitoring with charts, temperature & fan sensors,
> a process ranking, threshold alerts — plus **fan speed control** in the spirit
> of **Macs Fan Control** (auto / custom RPM / sensor curve / presets).
>
> This document is the binding interface between the Host half (`src/*.js`) and
> the browser half (`client/index.js`). Both halves are written in parallel;
> read this file before coding and do not change the wire shapes unilaterally —
> if a change is needed, message the Lead, who owns this document.

## 1. Verified machine facts (probed on this Mac)

- Mac mini M4 (`Mac16,10`), macOS 26.3.1, arm64, **1 fan** (`FNum` = 1).
- SMC is reachable through the public IOKit `AppleSMC` user client:
  `IOServiceOpen(mach_task_self, type 0)` + `IOConnectCallStructMethod(selector 2)`
  with the classic 80-byte `SMCKeyData_t` (`key`, `vers`, `pLimitData`,
  `keyInfo`, `result`, `status`, `data8`, `data32`, `bytes[32]`; offsets:
  key 0, keyInfo 28, data8 42, data32 44, bytes 48).
- **Reads work without root.** `#KEY` reports 1352 keys; enumerating all of them
  and reading every temperature key takes ~16 ms, so the native sampler may
  enumerate once at startup and then read a fixed key list per tick.
- **Writes require root** (`IOConnectCallStructMethod` write returns
  `0xE00002C1` = `kIOReturnNotPrivileged` for a normal user). This is why fan
  control needs a privileged helper, exactly like Macs Fan Control's
  `/Library/PrivilegedHelperTools/com.crystalidea.macsfancontrol.smcwrite`.
- Fan keys on this Mac: `FNum` (ui8, count), `F0Ac` (flt, actual RPM),
  `F0Tg` (flt, target RPM), `F0Mn` (flt, min), `F0Mx` (flt, max),
  `F0Md` (ui8, **0 = system auto, 1 = forced**). Macs Fan Control was observed
  writing `F0Md=1` + `F0Tg` while controlling and `F0Md=0` when back to auto, so
  the write protocol is: `F0Md=1`, then `F0Tg=<rpm>`; restore with `F0Md=0`.
- Floating-point SMC values on this Apple Silicon machine are **little-endian**
  IEEE-754 (`flt ` type, 4 bytes). Intel Macs use big-endian. The Swift helper
  must detect per value: decode both ways and keep the one in a plausible range
  (RPM −1…20000, °C −40…200); this is the only chip-dependent decode rule.
- Temperature key families observed (`flt`, °C): `Tp0*`/`Tp1*`/`Tp3*` (CPU
  performance cluster, 90 °C under load), `Te0*` (CPU efficiency cluster),
  `Tg0*` (GPU), `TH0*` (SSD/NVMe, ~40 °C), `Tm0*` (memory), `Ta0*`
  (board/ambient-ish), `TW0P` (Wi-Fi), `TB*` (battery, absent on a Mac mini),
  plus `TP*`, `TR*`, `Ts*`, `TV*`, `Tz*` (zeros) and other minor keys.
  Only offer a summary group when at least one real reading exists.
  `Ta0p` (the board/intake sensor) feeds the `ambient` summary group; it sits
  inside the chassis and therefore reads warmer than the room. Its unpopulated
  siblings (`Ta00`, `Ta04`, …) read 0 and must not create a group.
- `IOReport` is used **only** for power/energy (the `Energy Model` group: per
  cluster `CPU Energy` / `GPU` / `ANE` / `DRAM` counters, read through
  `/usr/lib/libIOReport.dylib`, no root). Temperatures and fan speeds stay
  SMC-only; HID sensor APIs are still not used.
- The Energy Model group has 175 channels; the four power blocks are cumulative
  energy counters in mJ (`GPU Energy` is an nJ duplicate of `GPU` — match the
  exact names so energy is never counted twice). Power = Δenergy / Δt with a
  monotonic clock; a missing library (Intel Macs) drops the `power` key instead
  of failing the sampler.

## 2. Architecture

New Host modules (each owns its file; do not edit files outside your scope):

| File | Owner | Purpose |
| --- | --- | --- |
| `assets/state.swift` | Lead | long-running SMC sampler; one JSON line per sample |
| `assets/fan-daemon.swift` | Lead | root privileged helper; Unix socket; writes fan keys |
| `src/swift.js` | Lead | generic `swiftc` compile-once cache |
| `src/smc.js` | Lead | spawn/restart the sampler, cache the latest sample |
| `src/fans.js` | Lead | fan control state machine, install/uninstall, curve math |
| `src/monitor.js` | Lead | 1 s ticker, ring buffers, snapshot assembly, alerts/fan wiring |
| `src/energy.js` | Lead | persisted daily energy ledger (`monitor/energy.json`), local-date bucketing and range queries |
| `src/metrics.js` | **metrics-host** | pure parsers + software-metric collection |
| `src/processes.js` | **metrics-host** | `ps` parsing, listing, kill |
| `src/alerts.js` | **metrics-host** | threshold evaluation with cooldown + settings |
| `client/index.js` | **monitor-ui** | new tab UI (sole writer) |
| `src/ops.js`, `src/config.js`, `src/index.js`, `package.json`, README, locales, `test/manifest.test.js` | Lead | integration + docs |

The panel talks to the Host **only** through the existing
`POST /api/dsh-mac-tools` route: `{ endpoint, payload }` → `{ ok, value }` /
`{ ok: false, error: { code, message, details } }`. No new HTTP routes, no
images, no network.

One shared 1 s sampling loop lives in `src/monitor.js`: it collects software
metrics (via `src/metrics.js`), merges the latest SMC sample (via `src/smc.js`),
evaluates alerts (via `src/alerts.js`), drives the fan curve (via `src/fans.js`)
and keeps a 60-entry ring buffer for the charts. The `monitor` endpoint returns
the cached snapshot; it never blocks on sampling.

## 3. Endpoints

All numbers are finite numbers unless stated otherwise. Timestamps are ISO 8601
strings. Fractions are **0…1**; percentages are **0…100**; sizes are bytes.

### 3.1 `monitor` → full snapshot

Polled by the visible tab (default every 1 s; the panel's interval selector may
use 1 / 2 / 5 s). No payload.

```jsonc
{
  "version": "0.3.0",
  "sampledAt": "2026-10-23T11:12:13.000Z",
  "capabilities": {
    "platform": "darwin",              // "darwin" | "other"
    "sensors": { "supported": true, "reason": null },   // reason: null | "starting" | "swift-missing" | "smc-unavailable" | "compile-failed" | "unsupported-platform"
    "fanControl": { "supported": true, "reason": null },// supported = a fan exists and the platform is macOS
    "battery": false,
    "processes": true
  },
  "sample": {
    "at": "2026-10-23T11:12:13.000Z",
    "host": {
      "hostname": "mac-mini.local",
      "modelName": "Mac mini",
      "modelIdentifier": "Mac16,10",
      "cpuModel": "Apple M4",
      "arch": "arm64",
      "osName": "macOS",
      "osVersion": "26.3.1",
      "cpuCores": 10,
      "performanceCores": 4,           // null when unknown
      "efficiencyCores": 6,            // null when unknown
      "uptimeSeconds": 12345
    },
    "cpu": {
      "usagePercent": 18.2,
      "userPercent": 11.1,
      "systemPercent": 5.2,
      "idlePercent": 81.8,
      "loadAverage": [1.2, 1.5, 1.4],
      "perCorePercent": [12.3, 4.5, 51.0, 0.0, 3.2, 6.1, 0.0, 0.0, 2.0, 0.0],
      "temperatureCelsius": 73.2       // max CPU cluster sensor; null when SMC unavailable
    },
    "memory": {
      "totalBytes": 34359738368,
      "usedBytes": 21642608640,
      "availableBytes": 12717129728,
      "usedPercent": 62.9,
      "appBytes": 0, "wiredBytes": 0, "compressedBytes": 0, "cachedBytes": 0,
      "swapUsedBytes": 0,
      "pressure": "normal"             // "normal" | "warning" | "critical" | null
    },
    "disk": {                           // APFS note: freeBytes is df's writable "Available"; free+used may be < total (shared container), and usedPercent = used/total
      "name": "Macintosh HD",
      "mount": "/System/Volumes/Data",
      "totalBytes": 994662584320,
      "usedBytes": 168000000000,
      "freeBytes": 826662584320,
      "usedPercent": 16.9
    },
    "network": {
      "interface": "en0",
      "localIp": "192.168.50.212",
      "receivedBytesPerSecond": 512,
      "sentBytesPerSecond": 0,
      "receivedTotalBytes": 123456789,
      "sentTotalBytes": 98765432
    },
    "battery": null,                    // or { percent, charging, pluggedIn, timeRemainingMinutes, healthPercent, cycleCount }; health/cycles may be null (pmset does not carry them)
    "sensors": {
      "available": true,
      "reason": null,
      "groups": {                       // null when no reading in that family
        "cpuPerformance": 90.6,
        "cpuEfficiency": 66.5,
        "gpu": 59.2,
        "ssd": 44.5,
        "memory": 57.2,
        "wifi": 33.7,
        "battery": null,
        "ambient": null
      },
      "readings": [                     // every readable temperature key; the panel shows these in a collapsible list
        { "key": "Tp01", "celsius": 73.2 },
        { "key": "TH0x", "celsius": 40.6 }
      ]
    },
    "fans": {
      "available": true,
      "reason": null,
      "items": [
        { "index": 0, "actualRpm": 2220, "targetRpm": 2221, "minRpm": 1000, "maxRpm": 4900, "mode": "forced" } // "auto" | "forced" | "unknown"
      ]
    },
    "power": {                          // SoC power from IOReport; available=false when the helper has no IOReport
      "available": true,
      "cpuW": 13.7,                     // CPU cluster (P + E cores)
      "gpuW": 3.6,
      "aneW": 0.0,
      "dramW": 2.5,
      "socW": 19.8,                     // cpuW + gpuW + aneW + dramW
      "energyWh": 0.0421,               // energy accumulated since `since`, 4 decimals
      "since": "2026-10-23T11:00:00.000Z" // null until the first power sample
    }
  },
  "history": {                          // ring buffer, oldest → newest, max 60 entries; drives the sparklines
    "capacity": 60,
    "cpu":               [ { "t": 1761220333000, "value": 18.2 } ],
    "memory":            [ { "t": 1761220333000, "value": 62.9 } ],
    "networkDown":       [ { "t": 1761220333000, "value": 512 } ],
    "networkUp":         [ { "t": 1761220333000, "value": 0 } ],
    "cpuTemperature":    [ { "t": 1761220333000, "value": 73.2 } ],
    "power":             [ { "t": 1761220333000, "value": 19.8 } ],
    "fanRpm":            [ { "t": 1761220333000, "value": 2220 } ] // fan 0 actual RPM
  },
  "energy": {                           // persisted daily energy ledger (local dates)
    "todayWh": 12.3,                    // today's accumulated energy, 4 decimals
    "totalWh": 456.7,                   // all retained days, 4 decimals
    "days": 42,                         // retained days with data
    "since": "2026-10-01",              // first retained local date; null when empty
    "pricePerKwh": 0.56,                // 元/度, persisted operator setting (default 0.5)
    "costToday": 0.0069,                // 元, todayWh / 1000 × pricePerKwh, 4 decimals
    "costTotal": 0.2558                 // 元, totalWh / 1000 × pricePerKwh, 4 decimals
  },
  "alerts": {
    "settings": {
      "enabled": true,
      "cpuPercent": 90,
      "temperatureCelsius": 95,
      "memoryPercent": 90,
      "cooldownSeconds": 300,
      "notify": true
    },
    "events": [                         // newest first, max 20; cleared on plugin reload
      { "id": "a-1", "at": "2026-10-23T11:10:00.000Z", "metric": "temperature",
        "value": 96.2, "threshold": 95 }
    ]
  },
  "fanControl": {
    "state": "not-installed",           // "unavailable" | "not-installed" | "installing" | "ready" | "error"
    "reason": null,                     // "swift-missing" | "no-fans" | "unsupported-platform" | "install-failed" | "cancelled" | "daemon-unreachable" | "not-installed" | null
    "message": null,                    // short English diagnostic (for logs); the panel localizes by reason
    "installed": false,                 // helper files exist on disk
    "running": false,                   // daemon socket answered recently
    "otherControllers": [               // other fan controllers detected (informational warning)
      { "name": "Macs Fan Control", "pid": 1035 }
    ],
    "mode": "auto",                     // "auto" | "manual" | "curve"
    "manualRpm": 2500,
    "curve": { "sensor": "cpuPerformance", "points": [ { "celsius": 40, "rpm": 1000 }, { "celsius": 60, "rpm": 2400 }, { "celsius": 75, "rpm": 3600 }, { "celsius": 90, "rpm": 4900 } ] },
    "sensorOptions": ["cpuPerformance", "cpuEfficiency", "gpu", "ssd"],  // curve sensor ids; only supported ones
    "appliedRpm": null,                 // target the daemon last applied; null when auto
    "lastAppliedAt": null,
    "minRpm": 1000,
    "maxRpm": 4900,
    "presets": [                        // built-ins carry an id the panel localizes; custom carry a user name
      { "id": "auto",        "name": "auto",        "builtin": true, "mode": "auto" },
      { "id": "quiet",       "name": "quiet",       "builtin": true, "mode": "manual", "rpm": 1000 },
      { "id": "balanced",    "name": "balanced",    "builtin": true, "mode": "manual", "rpm": 2200 },
      { "id": "performance", "name": "performance", "builtin": true, "mode": "manual", "rpm": 3400 },
      { "id": "max",         "name": "max",         "builtin": true, "mode": "manual", "rpm": 4900 },
      { "id": "p-prof",      "name": "剪辑模式",     "builtin": false, "mode": "curve", "curve": { "sensor": "cpuPerformance", "points": [ /* … */ ] } }
    ]
  }
}
```

`history.cpuTemperature` always exists but may hold `null` values when SMC is
unavailable (skip points with `value === null` when drawing).

### 3.2 `monitorProcesses` → process ranking

Payload: `{ "sort": "cpu", "order": "desc" }` where `sort` is one of `"cpu"`
(default), `"memory"`, `"rss"`, `"name"` or `"pid"`, and `order` is `"asc"` or
`"desc"` (omitted → the key's natural direction: cpu/memory/rss descending,
name/pid ascending). Unknown keys fall back to `cpu` + its default direction.
The panel sends an explicit direction so a second click on the same column
header reverses it.

```jsonc
{
  "sampledAt": "…",
  "sort": "cpu",
  "order": "desc",
  "count": 15,
  "processes": [
    { "pid": 1035, "name": "Macs Fan Control", "cpuPercent": 12.3,
      "memoryPercent": 1.2, "rssBytes": 132512512, "user": "linlong", "killable": true }
  ]
}
```

The panel polls this only while the Processes section is expanded. `name` is
the executable basename (trimmed to 64 chars). `killable` is computed by the
Host (`user === os.userInfo().username`, `pid > 1`, `pid !== Host process.pid`);
the panel disables the kill action when it is false. The Host repeats the same
checks in `monitorKill`, so a stale `killable: true` row still refuses safely.

### 3.3 `monitorKill` → terminate one process

Payload: `{ "pid": 1234 }` → `{ "pid": 1234, "name": "Xcode", "signal": "SIGTERM" }`.

Errors (endpoint rejects with these `code`s):

- `kill_invalid_pid` — pid is not a positive integer, or 1, or the Host's own pid.
- `kill_not_found` — no such process.
- `kill_denied` — `EPERM`/`EACCES`.

Use `process.kill(pid, 'SIGTERM')`; do not escalate.

### 3.4 `monitorAlertSave` → persist threshold settings

Payload: any subset of `{ enabled, cpuPercent, temperatureCelsius, memoryPercent,
cooldownSeconds, notify }`. Values are clamped: percent 1…100, temperature
40…120, cooldown 0…3600. Returns the full normalized `alerts` block
(`{ settings, events }`). Settings persist in the plugin state directory and
survive restarts.

### 3.5 `monitorAlertTest` → fire one test notification

No payload → `{ "notified": true }` (best effort: `true` even when the system
notification permission later suppresses it; `false` only when the notifier
itself is unavailable, i.e. not macOS).

### 3.6 `fanInstall` / `fanUninstall`

No payload. Both are **blocking** calls (up to 180 s): they compile the helper
once with `swiftc` and run an installer script through
`osascript -e 'do shell script "…" with administrator privileges'`, which shows
the standard macOS administrator dialog **once**. They return the
`fanControl` block from §3.1:

```jsonc
{ "state": "ready", "installed": true, "running": true, "reason": null, /* … same shape … */ }
```

On a cancelled password dialog return `state: "error"`, `reason: "cancelled"`.
On a non-macOS platform return `state: "unavailable"`,
`reason: "unsupported-platform"`. The panel shows a "waiting for authorization"
state while the promise is pending and re-reads `monitor` afterwards.

### 3.7 `fanApply` → take control (or restore auto)

Payload, exactly one of:

```jsonc
{ "mode": "auto" }
{ "mode": "manual", "rpm": 2500 }
{ "mode": "curve", "sensor": "cpuPerformance", "points": [ { "celsius": 40, "rpm": 1000 }, … ] }
```

`rpm` is clamped to the fan's `[minRpm, maxRpm]`. In `manual` mode the Host
re-applies the target every 2 s; in `curve` mode it computes the target from the
chosen sensor every 2 s through the smoothing/hysteresis/slew-rate governor
described in §5 (so `fanControl.appliedRpm` changes only when the smoothed
temperature justifies it). Returns the updated `fanControl` block.

Panel mapping (semantic, not wire): the panel's **自动** control sends
`mode:"curve"` (automatic control *by the temperature curve*) — it never sends
the bare `mode:"auto"`, which is reserved for the explicit 恢复系统自动 action.
`fanControl.mode` therefore reads `"curve"` while 自动 is active, `"manual"` for
手动, and `"auto"` only after the fan was handed back to the SMC (the panel
labels that state 系统自动). Errors:
`fan_not_ready` (not installed / daemon unreachable), `fan_apply_failed`
(daemon refused the write; `details.reason` carries the daemon reason).

### 3.8 `fanPreset` → save or delete a custom preset

Payload: `{ "op": "save", "name": "剪辑", "mode": "manual" | "curve", "rpm"?, "sensor"?, "points"? }`
or `{ "op": "delete", "id": "p-abcd1234" }`.
Returns `{ "presets": [ … ] }` (same shape as §3.1). Applying a preset is
`fanApply` with the preset's mode/rpm/curve; built-in preset ids are fixed
(`auto`, `quiet`, `balanced`, `performance`, `max`) and cannot be deleted.
Presets persist in the plugin state directory.

### 3.9 `monitorEnergy` → daily energy for a date range

Payload: `{ "from": "2026-10-30", "to": "2026-11-05" }` (local dates,
`YYYY-MM-DD`). Both fields are optional: `to` defaults to today and `from`
defaults to `to − 6 days`. Dates must be real calendar dates, `from ≤ to`, and
the range must not exceed 366 days (otherwise `invalid_request`).

```jsonc
{
  "from": "2026-10-30",
  "to": "2026-11-05",
  "days": [                          // oldest → newest; every day of the range, wh 0 when no data
    { "date": "2026-10-30", "wh": 8.1 },
    { "date": "2026-10-31", "wh": 9.4 }
  ],
  "totalWh": 56.7,                   // sum over the range
  "averageWh": 8.1,                  // totalWh / number of days in the range
  "pricePerKwh": 0.56,               // 元/度 in force for this answer
  "totalCost": 0.0318,               // 元, totalWh / 1000 × pricePerKwh, 4 decimals
  "averageCost": 0.0045              // 元, averageWh / 1000 × pricePerKwh, 4 decimals
}
```

The ledger is persisted at `<state>/monitor/energy.json` (local date → Wh,
400-day retention) and only accumulates while the plugin is loaded; it
survives plugin reloads and DSH restarts. `snapshot.energy` is the cheap
summary the 1 s `monitor` poll carries; the range query is separate so a
custom range does not bloat every snapshot.

### 3.10 `energyPriceSave` → persist the electricity price

Payload: `{ "pricePerKwh": 0.56 }` — 元 per kWh. Must be a finite number in
`[0, 100]` (otherwise `invalid_request` with `field: "pricePerKwh"`). Returns
the full `energy` snapshot block after persisting (same shape as §3.1
`snapshot.energy`). The setting lives in the energy ledger file and survives
plugin reloads and DSH restarts; the default is `0.5` 元/度.

## 4. Host module interfaces (written by `metrics-host`)

`src/metrics.js` — pure where possible, `run` injectable
(`runProcess` from `./capture.js`, signature
`run(command, args, { timeoutMs })` → `{ stdout, stderr }`, throws on failure):

```js
export function computeCpuPercentages(previous, current) // os.cpus() snapshots → { usagePercent, userPercent, systemPercent, idlePercent, perCorePercent } | null
export function parseVmStat(text, totalBytes)            // → memory shape of §3.1 minus pressure, or null
export function parseSwapUsage(text, totalBytes)         // `sysctl vm.swapusage` → swapUsedBytes | 0
export function parseNetstat(text)                       // `netstat -ibn` → [{ interface, receivedBytes, sentBytes }]
export function parseDf(text)                            // `df -kP <mount>` → { totalBytes, usedBytes, freeBytes } | null
export function parseBattery(text)                       // `pmset -g batt` → battery shape | null
export function parseHostFacts()                         // os.* + sysctl hw.model/proc brand → host shape
export async function collectSoftwareMetrics({ previous, run }) // → { at, host, cpu, memory, disk, network, battery } (no sensors/fans)
```

`collectSoftwareMetrics` must degrade per field (missing battery on a Mac mini,
refused `df`, etc.) and never throw for an individual failed source. Disk
target: read the APFS data volume (`/System/Volumes/Data`, falling back to
`/`) and take its name from `diskutil info -plist <device>` when that is cheap;
`name` may be `"Macintosh HD"` as a fallback. Network rate is computed from the
delta of two consecutive `netstat` samples (first call may report 0 rates).

`src/processes.js`:

```js
export function parseProcessList(text)                  // `ps -Ao pid=,pcpu=,pmem=,rss=,user=,comm=` → rows
export async function listProcesses({ sort = 'cpu', limit = 15, run })  // → §3.2 value without sampledAt
export async function killProcess(pid, { run })         // → { pid, name, signal } ; throws Error with .code = kill_invalid_pid | kill_not_found | kill_denied
```

`src/alerts.js`:

```js
export const ALERT_DEFAULTS = { enabled: true, cpuPercent: 90, temperatureCelsius: 95, memoryPercent: 90, cooldownSeconds: 300, notify: true }
export function normalizeAlertSettings(raw)             // → ALERT_DEFAULTS-merged, clamped settings
export class AlertMonitor {
  constructor({ settings, notify = () => false, now = () => Date.now(), statePath, warn })
  evaluate(sample)          // → events fired this tick (0..n); each { id, at, metric: "cpu"|"temperature"|"memory", value, threshold }
  snapshot()                // → { settings, events } (events newest first, max 20)
  save(patch)               // → normalized settings; persists to statePath when given
}
```

`evaluate` compares the **current** `sample.cpu.usagePercent`,
`sample.cpu.temperatureCelsius`, `sample.memory.usedPercent` against the
thresholds and fires at most one event per metric per cooldown window. It calls
`notify(event)` when `settings.notify` is true; the Host's notifier shows a
macOS notification. The event list keeps firing history for the panel (the
panel localizes the text).

## 5. Client tab spec (written by `monitor-ui`)

File: `client/index.js` only (plus `test/client.test.js`). Keep every existing
tab working. Read `docs/CLIENT-CONTRACT.md` first — the same hard constraints
apply (no imports besides `react`, no JSX, one injected stylesheet, `dshMacTools…`
class prefix, theme tokens only for chrome, zh/en dictionaries complete).

- `'monitor'` is the **first tab and the panel's default landing page**
  (`TABS = ['monitor', 'screenshot', 'files', 'calculator', 'transfer']`, the
  store starts with `tab: 'monitor'`); the old `'system'` tab is gone (its
  unique facts merged into this tab, see below). zh label `运行状态`, en label
  `Status`. Snapshot state lives in the existing module-level store
  (`state.tab`, etc.) with a new `monitor` slice.
- Poll `monitor` with `host.post('monitor', {})` only while the tab is visible;
  dedupe in-flight requests, abort on unmount/tab switch, pause with the panel's
  visibility handling. Default interval 1 s, selectable 1 / 2 / 5 s; a Pause
  toggle stops polling (charts freeze). `monitorProcesses` polls every 3 s only
  while the Processes section is expanded.
- Layout: a **left sub-page rail** plus the selected sub-page on the right (a
  two-column shell; below 760 px the rail becomes a horizontal scrollable row).
  The rail is a vertical button list — 概览 / 传感器 / 能耗 / 风扇 / 进程 / 告警 /
  系统 — with the active entry highlighted and `aria-current="page"`. Only the
  selected sub-page renders, so the tab is no longer one long scroll. Mapping:
  概览 → the global toolbar + overview cards (items 1–2); 传感器 → items 3 + 4;
  能耗 → item 5; 系统 → item 6; 风扇 → item 7; 进程 → item 8 (selecting it
  opens the ranking and starts its 3 s poll, leaving it stops the poll);
  告警 → item 9. The stale-error notice stays global above the shell.
- Sections (top → bottom inside a sub-page), State-inspired but in the panel's
  flat card style:
  1. **Toolbar** (global, above the shell): sample time, interval selector,
     pause/resume, manual refresh, small availability badges.
  2. **Overview cards** (responsive two-column grid; memory/disk/battery/
     network/uptime live here):
     - CPU: chip name, big temperature, usage area sparkline (history.cpu),
       legend 用户/系统/闲置 percentages, per-core mini bars.
     - Memory: available/total, usage bar with app/wired/compressed/cached
       breakdown, pressure badge.
     - Disk: volume name, available/total, usage bar.
     - Network: local IP, ↓/↑ rates with a two-line sparkline
       (history.networkDown/Up).
     - Power (only when `sample.power.available`): big SoC wattage
       (`sample.power.socW`), a sparkline of history.power, a CPU/GPU/DRAM/ANE
       breakdown, and the accumulated energy (`energyWh` since `since`).
     - Fan (only when `sample.fans.items` is non-empty): the compact control —
       live RPM, an RPM slider committed on release (`fanApply` manual), and the
       自动 / 全速 quick actions. 自动 applies the temperature curve (the Host's
       `curve` mode with the reported curve/sensor), never the SMC's own auto. When fan control is not ready the card shows
       the current RPM plus a link to the 风扇 sub-page instead of duplicating
       the install flow.
     - Battery card only when `sample.battery` is non-null (percent, charging,
       remaining, health).
     - A footer line with uptime and host model.
  3. **温度传感器** section: summary chips for the non-null groups (CPU 性能核 /
     CPU 能效核 / GPU / SSD / 内存 / Wi-Fi), then a collapsible "全部传感器"
     list (key + °C, grouped by key prefix family, sorted by temperature desc).
     Show the SMC reason when `sensors.available` is false.
  4. **功耗与散热** section (renders only when `sample.power.available`):
     - Readouts computed from the paired history rings: 热阻 =
       (CPU 温度 − 环境温度) / CPU 功耗 in °C/W and 风扇效率 = 风扇转速 /
       SoC 功耗 in RPM/W; each shows an em dash when no usable pair exists.
     - Two small scatter charts built from the same history indices (null
       points skipped): 功耗 → CPU 温度 (°C) and 功耗 → 风扇转速 (RPM), each
       with a least-squares trend line and axis range labels.
     - When the power block is unavailable, show the localized
       `monitor.power.unavailable` hint instead of the charts.
  5. **能耗统计** section (after 功耗与散热):
     - Range selector (segmented): 今天 / 近 7 天 / 近 30 天 / 自定义. Custom
       mode reveals two native `<input type="date">` fields (from/to) plus an
       应用 button; the applied range drives the query.
     - Headline: the range total in 度 (kWh = wh / 1000, three decimals) and a
       sub-line 今日 X 度 · 累计 Y 度 from `snapshot.energy`, plus the estimated
       cost (≈ ¥X.XX at the persisted 元/度 price).
     - Price editor: a numeric input bound to `snapshot.energy.pricePerKwh`
       (元/度, step 0.01) with a 保存 button calling `energyPriceSave`; the
       committed value refreshes the cost lines without a full reload.
     - Aggregation selector: 按天 / 按周 / 按月. Defaults by range length (day
       up to 31 days, week up to 120, month beyond); weeks start on Monday and
       buckets are summed client-side from the daily `monitorEnergy` answer.
     - Bar chart: one bar per bucket (SVG), y = kWh, bucket labels under the
       ends, and a `title` tooltip per bar with the bucket label, kWh and cost.
       Buckets without data render as zero.
     - The panel queries `monitorEnergy` for the selected range while the tab is
       visible (on range change and every 30 s); loading/error/empty states are
       localized inline, and an unavailable power block shows the same hint as
       the 功耗与散热 section.
  6. **系统信息** section (merged from the former separate System tab, which is
     removed): system/hardware facts (`sample.host`: OS version + arch,
     hostname, model identifier, chip, total/P/E cores, uptime), runtime facts
     (`version`, `snapshot.host.value.hostPid`, `sampledAt`, save folder from
     `snapshot.host.value.saveDirectory`, current polling interval/pause), and
     the Host capability list (`snapshot.host.value.capabilities`: screenshot,
     hideApp, pin, history, transfer, monitor, fanControl → 可用/不可用).
     Memory/disk/battery/network stay in the overview cards, not duplicated
     here. Renders only once `monitor.value` exists; degrades to 未知 when the
     `status` answer has not arrived yet.
  7. **风扇控制** section:
     - `state === "not-installed"`: explanation + **启用风扇控制** button; the
       copy must disclose what will be installed (a root helper in
       `/Library/Application Support/DSH Mac Tools/` plus a LaunchDaemon, used
       only to write the fan speed, removable again from this panel) and that
       macOS asks for the administrator password once. While the call is
       pending show a waiting/authorizing state.
     - `state === "ready"`: per-fan actual/target/min/max row; mode segmented
       control 自动 / 手动 (自动 drives the temperature curve; the SMC's own
       automatic control is the 恢复系统自动 action); manual slider (step 10) with a numeric
       readout **committed on release** (debounced ~250 ms), curve editor (see
       below), preset chip row (built-ins + custom; save current / delete
       custom), "恢复系统自动" button, and a footer showing whether the setting
       is being held. When `otherControllers` is non-empty show an inline warning
       that another controller (e.g. Macs Fan Control) is running and the two
       will fight over the fan.
     - `state === "installing"` / `"error"` / `"unavailable"`: status card with
       reason-specific message and a retry/uninstall action as appropriate.
     - Curve editor: SVG chart, points (`{celsius, rpm}`) joined by straight
       segments; drag a point vertically (rpm) and horizontally (celsius, kept
       strictly between neighbours), click empty space to add a point, a delete
       action per selected point, and a reset-to-default. Keep 2…8 points.
       Offer the sensor select (`fanControl.sensorOptions`, localized names).
       Commits via `fanApply` with `mode: "curve"`.
     - Curve mode is stabilized on the Host: the chosen sensor is smoothed
       (8 s EMA), target changes below an 80 RPM dead-band are not written, and
       real changes are slew-rate limited (450 RPM/s up, 120 RPM/s down). The
       panel does not need to do anything for this; do not re-derive targets
       client-side.
     - An uninstall button (danger styling, confirm inline) that restores auto
       control and removes the root helper.
  8. **进程排行** section: **clickable column headers** sort by 进程名 / PID /
     CPU / 内存 / RSS (a second click on the active column reverses the
     direction; resource columns start descending, name/pid ascending), top ~12
     rows with PID, CPU%, memory%, RSS, and a kill action guarded by a two-step
     inline confirm (first click arms "确认结束?", second click within 3 s
     kills; errors map to localized messages). Mark the Host's own processes as
     not killable.
  9. **告警** section: enabled switch, three numeric fields (CPU %, 温度 °C,
     内存 %), cooldown field (秒), notify switch, 保存 + 测试通知 buttons, and
     the recent events list (localized time, metric name, value/threshold).
- All request failures go through the existing `describeFailure`-style
  normalization and render a localized inline error (never a toast-only dead
  end). While the first `monitor` answer is pending show one skeleton card.
- Charts: one small reusable sparkline element built with `React.createElement`
  and an inline `<svg viewBox>`; use theme tokens for stroke/fill (the accent
  token plus fixed palette colours for the second network series are fine) and
  `vector-effect="non-scaling-stroke"`. Respect `prefers-reduced-motion` (no
  transitions on the SVG).
- **Every chart carries a timeline.** Sparklines render a start / middle / end
  clock row from their history ring's `t` values; the energy bar chart labels
  the first, middle and last bucket dates; the correlation scatters print the
  sample window (`monitor.power.scatter.timeRange`). A chart without its time
  context is a contract violation.
- Numbers format through `Intl.NumberFormat`/locale-aware helpers already used
  elsewhere in the file; sizes as `GB/MB`, rates as `KB/s`, temperatures as
  `72.3 °C`.

## 6. Degradation matrix (must hold)

| Situation | Behaviour |
| --- | --- |
| non-macOS | whole tab renders an "unsupported platform" card; no polling |
| `swiftc` missing | software metrics still work; sensors + fan control show `swift-missing` |
| SMC unavailable / AppleSMC open fails | software metrics work; sensor/fan cards show the reason; alerts for temperature disabled |
| no fan (MacBook Air) | fan card says "no fan"; `fanControl.supported = false` |
| no battery (desktop) | battery card omitted |
| IOReport unavailable (or non-Apple-Silicon) | power card and 功耗与散热 section hidden; 能耗统计 shows the unavailable hint; temperature/fan cards unaffected |
| energy ledger missing or corrupt | `snapshot.energy` reports zeros and 能耗统计 shows the empty state; the monitor keeps sampling |
| helper not installed | fan card shows the install CTA; monitors still work |
| daemon unreachable after install | `state: "error"`, reason `daemon-unreachable`, retry + reinstall actions |
| user cancels admin dialog | `state: "error"`, reason `cancelled`, CTA stays available |
| plugin unload | fan is restored to system auto before the Host exits |

## 7. Testing

- `npm run check` must pass (it runs `node --check` on every module plus
  `node --test test/`).
- Each new module gets focused `node --test` tests; parsers are tested on
  recorded command output (no root, no network). Native helpers are exercised by
  a live probe only when available (`process.platform === 'darwin'` and `swiftc`
  exists), and tests must skip cleanly otherwise.
- The client half keeps the existing `test/client.test.js` wiring checks in
  place and extends them for the new tab (registered tab, zh/en key parity for
  the new keys, no disallowed imports/globals).
- Do not run `sudo`, do not install/remove system components, do not start any
  server or open a browser during development. The Lead runs the one
  administrator-authorized fan test on this machine after the code is complete.
