# Mac Tools for DeepSeek Harness

[English](README.md) | [中文](README.zh.md)

A local macOS toolbox in **one** DeepSeek Harness plugin:

- **Screenshot (QQ-style)** — capture any application with the native macOS
  region/window picker, then crop and annotate in a real editor: arrows,
  rectangles, ellipses, freehand pen, text, mosaic and highlighter, with undo,
  redo, copy to the clipboard and save to disk.
- **Calculator** — a full calculator panel plus an exact expression engine that
  the agent can call.
- **Phone transfer** — scan a QR code with a phone on the same Wi-Fi and send
  text, files and photos to the Mac (or pull screenshots and files back), all
  through the phone's browser. No app install, nothing leaves the local network.
- **Clipboard** — read and write the macOS text clipboard from the panel or the
  agent.
- **System information** — macOS version, CPU, memory, disk, battery and
  uptime, in a panel card grid.
- **Status (运行状态)** — a real-time dashboard in the spirit of the App Store
  app **State**: CPU/memory/disk/network/battery charts, SMC temperatures and
  fans, a process ranking and threshold alerts — plus fan-speed control in the
  spirit of **Macs Fan Control** (auto / manual RPM / temperature curve /
  presets) through a one-time-authorized root helper.

Everything runs on the local machine. The plugin is **panel-only**: it adds the
**Mac Tools** entry in the left rail and registers **no model-facing tools**.

## Install

The plugin is a normal DSH bundle. From a checkout of this directory:

```
plugin_manager install_bundle  target: /absolute/path/to/dsh-mac-tools
```

or with the CLI:

```
dsh plugin --profile desktop add /absolute/path/to/dsh-mac-tools
```

A local directory install links the checkout. Reload the Web page after
installation; the **Mac Tools** entry appears in the left rail. If the Host half
was already running when you installed, a restart of DeepSeek Harness is the
reliable way to get both halves on the same version. In **Creator mode** (HMR
enabled) no restart is needed: toggling the `mac-tools` row off and on in the
Plugins page recomposes the profile and reloads the linked Host files in place.

### Permissions

Screen capture needs **System Settings → Privacy & Security → Screen
Recording → DeepSeek Harness**. Without it macOS silently returns a picture of
the wallpaper (or refuses window captures); the panel then reports the
`permission` failure code with the path to grant it.

No Accessibility permission is required: region/window selection is macOS's own
native selection UI, and only the clipboard/pasteboard is touched otherwise.

## The panel

Open it from the left rail, or press **⌥⌘M**. **⇧⌘A** starts an interactive
capture and opens the panel with the editor ready.

**⌃⌥A** (configurable) is a **system-wide** screenshot shortcut: it works while
any other application has focus. It opens macOS's native region/window selector,
then **pins the result to the screen, in the same place it was captured,**
as an always-on-top floating window,
copies it to the clipboard, saves it to the screenshot directory and plays the
Glass sound. (Set `pinAfterGlobalCapture: false` to skip the pinned window.) It needs no extra permission; its small native helper is
compiled once with the Xcode Command Line Tools (already present on developer
Macs).

The shortcut can be **customized right in the panel**: under the capture buttons,
press **修改 / Change**, then press the new combination (Control/Option/Command
plus one key; Esc cancels). The choice is stored in the profile's plugin state
(`<profile home>/dsh-mac-tools/hotkey.json`), survives restarts, and
**恢复默认 / Reset to default** returns to the configured `globalHotkey`. The
in-panel quick-capture shortcut (⇧⌘A by default) is a normal Harness shortcut and
can be rebound under **Settings → Shortcuts**.

### Screenshot tab

- **区域 / 窗口截图** — the native picker appears, the screen dims, drag a
  region; press **Space** to switch to clicking a window, **Esc** to cancel.
- **全屏截图**, **窗口截图** (click a window), **3 秒后全屏** (timed capture),
  and **选择应用窗口** (a searchable list of every visible app window, with the
  frontmost one marked — click one to capture it).
- **Screenshot history**: every capture — from the panel or the global
  shortcut — is saved durably and listed under the editor, with thumbnails.
  Click one to re-open it in the editor, or pin / copy / delete it directly.
- **Pinned windows can be annotated right there**: double-click a pinned
  screenshot (or press **A**, or right-click → 标注) to show a small toolbar on
  the pin itself — pen, arrow, rectangle, ellipse, highlighter, colour, width,
  undo, clear and done. Copy/save from that menu includes the annotations. To
  use the full panel editor instead, right-click → **Edit in panel…**.
- **「截图时隐藏 DSH」** (on by default): while a screen capture runs the
  Harness window is hidden and then restored, so it does not cover the target.
  The toggle sits next to the capture buttons and can be turned off. The same
  preference drives the **global shortcut** capture, which has no page to ask —
  the Host remembers it for the session.
- The editor supports **crop**, **arrow**, **rectangle**, **ellipse**, **pen**,
  **text**, **mosaic** and **highlighter**, with six colors, three stroke
  widths, undo/redo/reset, **copy** (PNG to clipboard), **save** (to the save
  directory, with reveal-in-Finder) and **pin** (贴图): place the edited image
  as an always-on-top floating window **exactly over the screen area the capture
  came from** (where you selected it). It can then be dragged, zoomed with the
  scroll wheel, copied, saved, faded (opacity menu) and closed — right-click it
  for the menu, Esc closes it, ⌘C copies it.
- Shortcuts inside the editor: `⌘Z` undo, `⇧⌘Z` redo, `Enter` apply crop,
  `Esc` cancel crop then close the screenshot.

### Calculator tab

A display plus keypad with history. Evaluation uses the Host's engine, so the
same expression gives the same result in the panel and through the tool.
Supports `+ - * / % ^`, parentheses, unary signs, implicit multiplication
(`2(3+4)`), percent (`50%`), constants `pi`/`e`/`tau`, and the functions
`sqrt, cbrt, abs, round, floor, ceil, trunc, sign, exp, ln, log, log2, sin,
cos, tan, asin, acos, atan, atan2, pow, hypot, min, max, mod`. Trigonometry is
in degrees by default.

### System tab

macOS version, architecture, hostname, CPU model and cores, memory with a usage
bar, root disk capacity, battery (when present) and uptime. Refreshes every ten
seconds while visible; the same facts are available through the tool.

### Status tab (运行状态)

A real-time dashboard (in the spirit of the App Store app **State**) plus fan
speed control (in the spirit of **Macs Fan Control**). Everything is sampled
locally by the Host; nothing leaves the machine.

- **Overview cards** — CPU usage with the user/system/idle legend, per-core
  bars and a two-minute area chart, plus the chip's current temperature;
  memory (available/total, app/wired/compressed/cached breakdown and the macOS
  pressure level); the APFS data volume; network throughput with a two-line
  chart; battery (when present); uptime. The interval selector offers 1 / 2 /
  5 s polling and a pause toggle.
- **Temperature sensors** — CPU performance/efficiency cluster, GPU, SSD,
  memory and Wi-Fi maxima read from the SMC, plus a collapsible list of every
  readable sensor key. Fan speeds, targets and the SMC's own minimum/maximum
  sit next to them. No extra permission is needed for reading.
- **Fan control** — automatic, a manual RPM slider clamped to the fan's own SMC
  limits, or a temperature curve (choose the sensor, drag 2–8 points, linear
  interpolation). Built-in presets (**auto / quiet / balanced / performance /
  max**) plus saved custom presets, and **恢复系统自动** hands the fan back at
  any time. The first use asks for the administrator password **once**: the
  panel installs a small root helper
  (`/Library/Application Support/DSH Mac Tools/fan/fan-daemon`) and a
  LaunchDaemon (`local.dsh.mac-tools.fan`). The helper accepts only fan
  commands from the installing user, clamps every target to the SMC limits,
  re-applies the target while a mode is held, and restores automatic control
  when the mode changes, the Host exits, the socket disconnects or 12 s pass
  without a command. **卸载风扇控制** in the same card restores automatic
  control and deletes the helper and the LaunchDaemon. Fan control is only
  offered on Macs that have a fan (a MacBook Air shows the monitor without it).
  Two things always keep the last word: macOS thermal management may raise the
  fan above the requested target under sustained load (verified on this Mac at
  >100 °C), and another running fan controller (e.g. Macs Fan Control) will
  overwrite the target between writes — the card warns when one is detected,
  and quitting it hands control back to this panel.
- **Process ranking** — the top processes by CPU or memory with a two-step
  inline kill confirmation. The Host refuses `pid` 1, its own process and
  processes it does not own.
- **Threshold alerts** — CPU %, temperature °C and memory % thresholds with a
  cooldown and an optional macOS notification; the settings persist under the
  plugin state directory (`~/.dsh/dsh-mac-tools/monitor/alerts.json`) and the
  recent events stay in the card. **测试通知** fires one notification so the
  macOS permission can be checked.

### Phone tab

A LAN-only bridge between the Mac and a phone browser. Press **开启手机互传**;
the Host starts a temporary HTTP listener, shows a **QR code** (and the URL), and
counts down the session. Scan the code with the phone's system camera (or type
the URL) and the phone opens a small web page — no app, no account, no cloud.

- **Phone → Mac**: send text (lands in the panel inbox, with one-click copy to
  the macOS clipboard and optional auto-copy), pick files/photos, or take a
  photo with the camera and upload it. Uploads show progress and are saved to
  the transfer directory (`~/Downloads/DSH 手机互传` by default), so the agent
  can read and process them like any other file.
- **Mac → Phone**: type text, choose any file with the native picker, or tap
  **发送到手机** on a recent screenshot; the phone page lists them for preview,
  copy or download. Screenshots are served straight from the history.
- **Security**: one random token per session, 30-minute expiry, the listener
  only exists while the session is open, and the server rejects foreign `Host`
  headers and malformed file names. Nothing is exposed to the internet.
  Downloads are sent as `attachment` + `application/octet-stream` (never as
  renderable pages), so Android/iOS browsers and their download managers save
  them natively instead of opening them in a tab.
- **Notes**: the Mac and the phone must be on the same Wi-Fi network (guest
  networks with AP isolation will not work), the first start may ask macOS to
  allow incoming connections for DeepSeek Harness, and a phone VPN can block
  LAN access. macOS may also ask for Local Network permission on recent
  releases. The Mac should stay awake during a transfer.
- **Troubleshooting**: if a phone upload stays at 0% or a download does
  nothing, reopen the page once and retry; the phone page now reports browser
  errors to `<plugin state>/transfer/diagnostics.log` (next to the plugin's
  other state, under `~/.dsh/dsh-mac-tools/transfer/`), together with every
  upload start/finish and download request, so the failing step is visible
  without remote debugging.

## Configuration

The bundle row accepts these keys in `cordis.patch.yml` (or a later patch
layer); every key has a default.

| Key | Default | Meaning |
|---|---|---|
| `saveDirectory` | `~/Pictures/DSH Mac Tools` | Where captures are saved, with `~` expanded. The panel's save action and the tool both write here. |
| `maxShots` | `20` | How many captures stay temporarily available in the panel before the oldest is pruned. Saved files are never pruned. |
| `interactiveTimeoutMs` | `180000` | How long the native selection may wait for the operator. |
| `hideAppDuringCapture` | `true` | Hide the DeepSeek Harness window for a moment while a screen capture runs (only when it is frontmost) and restore it afterwards. The panel has a per-capture toggle. |
| `globalHotkey` | `ctrl+alt+a` | Default system-wide screenshot shortcut, usable while any app has focus. The panel can override it at runtime (stored in the plugin state file); leave empty to start with no global shortcut. |
| `globalHotkeySound` | `true` | Play the Glass sound after a global-hotkey capture. |
| `pinAfterGlobalCapture` | `true` | Pin a global-hotkey capture to the screen (the panel editor always has an explicit pin button). |
| `historyLimit` | `60` | How many screenshots the panel history keeps; older captures are deleted. |
| `transferPort` | `8791` | Preferred port for the temporary phone-transfer listener; the next 9 ports are tried when it is taken. |
| `transferDirectory` | `~/Downloads/DSH 手机互传` | Where files sent by the phone are saved, with `~` expanded. |
| `transferSessionMinutes` | `30` | How long one phone-transfer session stays open before the QR code expires. |
| `transferMaxFileMB` | `512` | Largest single file a phone may upload, in megabytes. |
| `transferAutoCopyText` | `false` | Copy text received from the phone to the macOS clipboard automatically. |
| `monitorSampleMs` | `1000` | Host-side sampling cadence for the Status tab, in milliseconds (500–10000). Software metrics are collected at most every 2 s; the panel polls on top of this. |
| `alertCpuPercent` | `90` | First-run CPU alert threshold in percent. The panel edits it at runtime and the persisted choice wins over this default. |
| `alertTemperatureCelsius` | `95` | First-run temperature alert threshold in °C, taken from the SMC sensor groups. |
| `alertMemoryPercent` | `90` | First-run memory alert threshold in percent. |
| `alertCooldownSeconds` | `300` | Minimum time between two alerts of the same metric, in seconds. |
| `alertNotify` | `true` | Show a macOS notification when an alert fires. |

```yaml
- id: mac-tools
  config:
    saveDirectory: ~/Desktop/Screenshots
    maxShots: 30
```

## How it is built

- **Native helpers** (`assets/`): `hotkey.swift` listens for the system-wide
  shortcut, `pin.swift` shows a pinned screenshot as a floating AppKit window,
  and `qrcode.swift` renders the phone-transfer QR code with CoreImage. All are
  compiled once with `swiftc` and cached in the temporary directory.
  `smc-core.swift` is the shared, read-only IOKit `AppleSMC` transport;
  `state.swift` is the long-running sampler that prints one JSON line per
  sample (fans + every readable temperature key); `fan-daemon.swift` is the
  privileged helper installed by the fan card — a Unix-socket JSON endpoint
  that writes `F0Md`/`F0Tg` only, clamped to the SMC limits, with a 12 s
  watchdog that restores automatic control.
- **Host half** (`src/`): registers the authenticated `/api/dsh-mac-tools`
  route on Connection's `/api` channel, owns the temporary capture registry,
  runs `/usr/sbin/screencapture` for capture and `/usr/bin/osascript` for the
  window list, the image clipboard and the file picker. The Status tab is one
  sampling loop (`src/monitor.js`) over `src/metrics.js` (CPU/memory/disk/
  network/battery), `src/smc.js` (the sampler child), `src/alerts.js`
  (thresholds) and `src/fans.js` (the fan controller and its socket protocol).
  The phone-transfer
  listener (`src/transfer.js`) is a separate, on-demand `node:http` server bound
  to the LAN only while a session is active; it serves the phone page and the
  upload/download API, and keeps its inbox/outbox index in the plugin state
  directory. No agent tools are registered.
- **Client half** (`client/index.js`): one plain-React bundle loaded by
  `window.__ModuleLoader__`. It registers the rail entry and the `main` panel,
  renders the five tabs, and talks to the Host only through the route above.
- The capture engine is a thin wrapper over the system utility a person already
  granted Screen Recording to; region/window selection, cancellation and window
  picking are native macOS behavior, not reimplemented.

```
POST /api/dsh-mac-tools   { "endpoint": "...", "payload": { ... } }
GET  /api/dsh-mac-tools?shot=<id>    → image/png (temporary capture)
GET  /api/dsh-mac-tools?history=<id> → image/png (durable history capture)
GET  /api/dsh-mac-tools?inbox=<id>   → bytes of a file the phone sent
```

The `?inbox=` preview keeps only inert raster images (`png`, `jpeg`, `gif`,
`webp`, `avif`, `bmp`) inline; every other received file is answered as an
`application/octet-stream` attachment, so a phone-supplied HTML or SVG file can
never execute in the Web UI's origin.

Endpoints: `status`, `windows`, `capture`, `cancelCapture`, `copy`, `save`,
`calc`, `clipboard`, `system`, `reveal`, the phone-transfer group
`transferStatus`, `transferStart`, `transferStop`, `transferInbox`,
`transferOutbox`, the status-monitor group `monitor`, `monitorProcesses`,
`monitorKill`, `monitorAlertSave`, `monitorAlertTest`, and the fan group
`fanInstall`, `fanUninstall`, `fanApply`, `fanPreset`. Answers are
`{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.

The phone talks to its own temporary server under
`http://<mac-lan-ip>:<port>/t/<token>/` (page, `api/state`, `api/text`,
`api/upload`, `api/items/<id>`); that listener is not the Harness API and
carries no Harness session.

## Development

```
npm run check     # node --check every module + node --test test/
```

The host half is dependency-free apart from the `@deepseek-ai/schemastery`
config schema that ships with dsh. The client half requires only `react`.

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
