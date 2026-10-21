# Mac Tools for DeepSeek Harness

[English](README.md) | [中文](README.zh.md)

A local macOS toolbox in **one** DeepSeek Harness plugin:

- **Screenshot (QQ-style)** — capture any application with the native macOS
  region/window picker, then crop and annotate in a real editor: arrows,
  rectangles, ellipses, freehand pen, text, mosaic and highlighter, with undo,
  redo, copy to the clipboard and save to disk.
- **Calculator** — a full calculator panel plus an exact expression engine that
  the agent can call.
- **Clipboard** — read and write the macOS text clipboard from the panel or the
  agent.
- **System information** — macOS version, CPU, memory, disk, battery and
  uptime, in a panel card grid.

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
reliable way to get both halves on the same version.

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

```yaml
- id: mac-tools
  config:
    saveDirectory: ~/Desktop/Screenshots
    maxShots: 30
```

## How it is built

- **Native helpers** (`assets/`): `hotkey.swift` listens for the system-wide
  shortcut, `pin.swift` shows a pinned screenshot as a floating AppKit window.
  Both are compiled once with `swiftc` and cached in the temporary directory.
- **Host half** (`src/`): registers the authenticated `/api/dsh-mac-tools`
  route on Connection's `/api` channel, owns the temporary capture registry,
  runs `/usr/sbin/screencapture` for capture and `/usr/bin/osascript` for the
  window list and image clipboard. No agent tools are registered.
- **Client half** (`client/index.js`): one plain-React bundle loaded by
  `window.__ModuleLoader__`. It registers the rail entry and the `main` panel,
  renders the three tabs, and talks to the Host only through the route above.
- The capture engine is a thin wrapper over the system utility a person already
  granted Screen Recording to; region/window selection, cancellation and window
  picking are native macOS behavior, not reimplemented.

```
POST /api/dsh-mac-tools   { "endpoint": "...", "payload": { ... } }
GET  /api/dsh-mac-tools?shot=<id>   → image/png
```

Endpoints: `status`, `windows`, `capture`, `cancelCapture`, `copy`, `save`,
`calc`, `clipboard`, `system`, `reveal`. Answers are
`{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.

## Development

```
node --check src/index.js && node --test test/
```

The host half is dependency-free apart from the `@deepseek-ai/schemastery`
config schema that ships with dsh. The client half requires only `react`.

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
