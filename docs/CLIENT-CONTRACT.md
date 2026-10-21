# dsh-mac-tools — Client half contract (for the UI builder)

You are building the **browser half** of the `dsh-mac-tools` bundle: a Mac toolbox panel in the
DeepSeek Harness Web GUI. The Host half (being written in parallel by the Lead) owns screen capture,
the calculator engine, the clipboard, system info and the HTTP route. Your file is
`client/index.js` (plus `test/client.test.js`). Do not edit anything else.

## What already exists

- `package.json` already declares `dsh.client` (`platform: "web"`, `immediately` absent, inject of
  conversation/layout/sidebar packages — ordering only) and exports `./client` → `client/index.js`.
- `client/index.js` currently holds a **minimal working scaffold**: module-loader registration, styles,
  sidebar icon, main-panel registration and a `status` fetch. Replace its body with the full panel but
  keep the registration shape and ids.
- Sibling reference implementation (read it before coding, it is proven on this exact DSH version):
  `/Users/linlong/projects/long_dsh_tool/dsh-todo-list/client/index.js`
  It shows the module-loader format, slot registration, locale registration, stylesheet injection,
  `create…Client()` + `subscribe` state pattern, dialogs and theme-token CSS.
- Deeper reference for the dynamic-module conventions:
  `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md`
  and `references/practices.md` (readable with the read tool; do not read other plugins' DOM).

## Hard constraints

1. The file is one `window.__ModuleLoader__.load({ id: 'dsh-mac-tools', factory(require) { … } })` call.
   Inside `factory` the only modules you may `require` are `'react'` (and nothing else). No
   `@deepseek-ai/*` imports, no `import`/`export` statements, no JSX (use `React.createElement`).
2. `factory` must return `{ inject: ['slots', 'locale'], apply(ctx) { … } }`. Keep:
   - `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'mac-tools', locale: NS }, MacToolsPanel))`
   - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'mac-tools', order: 14, locale: NS, label: () => t('panel') }, MacToolsIcon))`
   - `ctx.effect(() => ctx.locale.register(NS, { zh, en }), …)` and `ctx.effect(() => installStyles(), …)`.
   - `const NS = 'dsh-mac-tools'`, `const PANEL_ID = 'mac-tools'`, `const API_PATH = '/api/dsh-mac-tools'`.
3. Panel component receives props: `{ t }` (locale translate bound to NS; supports `t('key', { x })`
   interpolation). Register with `locale: NS`. You may pass more via `inject: () => ({ client })`.
4. All visible UI text goes through the `zh`/`en` dictionaries (both must be complete). No English
   hardcoded in JSX except numbers/symbols/proper nouns like "Mac", "CPU".
5. CSS is one template string injected by `installStyles()` (copy the todo-list mechanism, including
   the `data-plugin-css` de-dupe). Use **only** `--dsw-alias-*` / `--dsw-*` theme tokens for UI chrome
   (backgrounds, text, borders, buttons, focus ring). The annotation palette colors are fixed artwork
   values (allowed). Prefix every class with `dshMacTools…`. Respect `prefers-reduced-motion`.
6. Never touch `document.body`, never mount a second app, no iframes, no external network calls other
   than the same-origin `/api/dsh-mac-tools` route.
7. All state that must survive tab switching lives in `React.useState`/refs in the panel component, or in
   a module-level store inside the factory (created once per factory materialization, not per render).
8. Canvas must work at the capture's **natural pixel size**: canvas backing store = natural width/height,
   CSS size = fitted display size; map pointer coordinates with the element's bounding rect. Never rely
   on `devicePixelRatio`. Export with `canvas.toDataURL('image/png')` → `base64 = dataUrl.split(',')[1]`.

## Host HTTP contract (already implemented by the Lead)

`POST /api/dsh-mac-tools`, JSON `{ endpoint, payload }`, `credentials: 'same-origin'`.
Answer: HTTP 200 `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
HTTP 404 ⇒ Host half not published (old build / restart needed). 415/400 ⇒ programming error.

`GET /api/dsh-mac-tools?shot=<shotId>` returns the raw PNG (`image/png`) — use it directly as an
`<img src>` (add `&t=${Date.now()}` to bust cache). Read pixels by drawing that image into a canvas.

### Endpoints

- `status` `{}` → `{ version, platform, saveDirectory, shotCount, interactiveBusy,
  hideAppDuringCapture, canHideApp, hostAppName,
  globalHotkey: { enabled, active, accelerator, label, reason },
  pins: number,
  historyCount: number,
  capabilities: { screenshot, calculator, clipboard, system, hideApp } }`
- `windows` `{}` → `{ windows: [{ id, app, title, x, y, w, h, frontmost }], frontmost: {app,title,id}|null }`
  (only real on-screen app windows; sorted front-to-back; may be `[]`).
- `capture` `{ mode, windowId?, app?, display?, rect?{x,y,w,h}, delaySeconds?, includeCursor?, hideApp? }`
  - `hideApp` (boolean, optional) hides the DeepSeek Harness window while a screen capture runs
    (only when it is frontmost) and restores it afterwards; the panel sends its toolbar toggle.
    The answer carries `appHidden: boolean`.
  - `mode`: `'interactive'` (native region selection with drag; space switches to window),
    `'interactive-region'` (mouse region only), `'interactive-window'` (click a window),
    `'full'` (main display), `'display'` (needs `display`, 1-based), `'window'` (needs `windowId`),
    `'app'` (needs `app`, uses that app's frontmost/largest window), `'frontmost'`, `'rect'` (needs `rect`).
  - Interactive modes **block until the operator finishes or presses Esc** (Host enforces a timeout).
  - → `{ shot: { id, path, width, height, bytes, mode, at, window? }, url }`, `url` is the GET path,
    or `{ shot, url }`; treat `value.shot` as authoritative and build the image URL yourself from `shot.id`.
  - error codes you must localize: `cancelled`, `busy`, `no_window`, `permission`, `timeout`,
    `capture_failed` (message detail may exist).
- `history` `{}` → `{ items, total, maxItems }` — durable screenshot history,
  newest first.
- `historyOpen` `{ id }` → `{ shot, url }` — copy one history capture into the
  temporary registry so the editor can open it.
- `historyDelete` `{ id }` / `historyClear` `{}` / `historyCopy` `{ id }` /
  `historyPin` `{ id }` → manage history entries.
- `pendingEditor` `{}` → `{ shot: object | null }` — a pinned window asked to be
  edited in the panel; the panel polls this and adopts the shot exactly once.
  Pinned windows also support annotation **in place** (native toolbar); that
  path does not involve the page.
- `pin` `{ shotId?, pngBase64? }` → `{ ok: true, path, count }` — show the
  image as an always-on-top floating window on the desktop (native helper).
  Pass `shotId` so the Host can place it over the original capture rectangle.
- `setHideApp` `{ enabled: boolean }` → `{ enabled }` — shares the panel's
  "hide DSH while capturing" toggle with the Host so the global-hotkey capture
  (which has no page) honors it. `status.hideAppDuringCapture` reflects it.
- `cancelCapture` `{}` → `{ cancelled: boolean }` — call from a visible "取消" button while an
  interactive capture is in flight (the button must be rendered while awaiting).
- `copy` `{ shotId?, pngBase64? }` → `{ bytes, at }` — puts the PNG on the macOS clipboard.
- `save` `{ shotId?, pngBase64? }` → `{ path, fileName, directory, bytes }`.
- `hotkey` `{}` → the global-hotkey status (same object as `status.globalHotkey`).
- `setHotkey` `{ accelerator }` → the new status; persists the user's choice. `accelerator` syntax:
  `ctrl+alt+a`, `primary+shift+s`, `alt+f5`…; error code `invalid_hotkey` (details.reason).
- `resetHotkey` `{}` → the default status; removes the user's override.
- `calc` `{ expression, angles?: 'deg'|'rad' }` → `{ expression, value, formatted, angles }`;
  error codes: `invalid_expression`, `unknown_identifier`, `unknown_function`, `divide_by_zero`,
  `domain_error`, `too_long`.
- `clipboard` `{ action: 'read'|'write', text? }` → `{ text }`.
- `system` `{}` → `{ os: { name, version, arch, hostname }, uptimeSeconds, cpu: { model, cores },
  memory: { totalBytes, freeBytes, usedPercent }, disk: { mount, totalBytes, usedBytes, freeBytes },
  battery: { percent, charging, timeRemainingMinutes }|null, capturedAt }`
- `reveal` `{ path }` → `{ revealed }` — optional "open in Finder" for a saved file.

Interactive capture is the only long request (up to minutes). Show a clear "正在选择截图区域…（按 Esc 取消）"
state, a cancel button, and use `AbortController` for other requests (abort on unmount). Do not auto-retry
a `cancelled` capture.

## Panel UX spec

Full-height panel like the todo panel (`.dshTodoPage` pattern): page → scroll container → content
`max-width: 980px; margin: 0 auto; padding: 0 clamp(24px,4vw,48px) 48px`, heading with 42px brand-mark
box + h1 + subtitle + a small Host-status pill on the right.

Tabs (role=tablist, under the heading): **截图 / 计算器 / 系统信息**. Active tab uses
`var(--dsw-alias-interactive-bg-hover)` + `label-primary`; inactive `label-tertiary`.

### Tab 1 — Screenshot (main feature, QQ-like)

Toolbar rows:
1. Primary filled button 「区域 / 窗口截图」 (mode `interactive` — the main action), then secondary
   outline buttons 「全屏截图」, 「窗口截图」(mode `interactive-window`), optionally a 3-second delayed
   full capture. While capturing: replace toolbar with the "请拖拽选择区域… Esc 取消" hint + 取消 button.
2. 「选择应用窗口」 toggles a window picker: a text input filtering by app/title and a list of windows
   (app name bold, title muted, `w×h`, frontmost badge). Clicking a row captures that window
   (`mode:'window', windowId`). Include a refresh button; empty state when no windows.
3. Editor (after a capture): a framed editor card.

Editor requirements:
- The captured image is displayed fit-to-container, with a checkered/dark canvas background. Show
  `宽×高 px` and capture mode as muted meta.
- Tool strip (icon + label buttons, active state): 裁剪, 箭头, 矩形, 椭圆, 画笔, 文字, 马赛克, 高亮.
  Plus color swatches (red `#ff3b30`, orange/yellow `#ffcc00`, blue `#0a84ff`, green `#34c759`,
  white `#ffffff`, black `#1c1c1e`) and stroke widths 细/中/粗 (3/6/10 display px, scaled to natural px).
- Undo / Redo / 还原 (clear all annotations) icon buttons, disabled when unavailable.
- Annotations: drag to commit an op on pointerup. Pen/highlight collect a polyline. Arrow has a head.
  Text: click place → an inline text input appears at that point (styled with theme tokens); Enter or
  blur commits, Esc cancels. Mosaic: drag rectangle; pixelate the underlying image in ~12×12 natural-px
  blocks (average color per block, drawn opaque; recompute from the base image when redrawing).
  Highlight: thick translucent yellow line (alpha ~0.35).
- Crop: with 裁剪 active, drag a rect → dim the outside; show 「应用裁剪」(Enter) and 「取消」(Esc)
  affordances. Applying crop flattens the current composite (image + annotations) into a new base image
  of the cropped size and clears undo history (predictable; state that in the UI copy).
- Keyboard: Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z redo, Esc cancels crop then closes the shot, Enter applies crop.
  Do not register global listeners outside the component; clean them up.
- Actions: 复制 (POST `copy` with `pngBase64`), 保存 (POST `save` with `pngBase64`), 关闭 (discard shot).
  Copy/save show a transient toast with the saved path (save) or "已复制到剪贴板" (copy). Errors show a
  localized toast; `cancelled` is not an error.
- Keep the original `shot` and build the base image once per shot (draw the `<img>` into an offscreen
  canvas at natural size). Redraw = base image + ops + in-progress preview + crop overlay.

### Tab 2 — Calculator

- Display card: editable expression input (monospace, right-aligned, placeholder "0") and a large result
  line; errors shown in `state-error-primary` with a short localized message.
- Keypad (grid): `C`, `⌫`, `(`, `)`, `7 8 9 ÷`, `4 5 6 ×`, `1 2 3 −`, `± 0 . +`, plus a full-width `=`
  and a secondary row `√` `x²` `π` `%` maybe. Buttons append tokens (`÷`→`/`, `×`→`*`, `−`→`-`,
  `x²`→`^2`, `√`→`sqrt(`, `π`→`pi`).
- Keyboard: typing edits the input; Enter evaluates; Esc clears. Evaluate only through the host `calc`
  endpoint (`angles: 'deg'`).
- History: last 10 successful evaluations rendered as rows `expression = formatted`; click a row to load
  its expression. Session-only state.
- Responsive: keypad max-width ~360px on a card, display above it.

### Tab 3 — System information

- Calls `system` on mount and on 刷新; cards for 系统 / CPU / 内存 (with bar) / 磁盘 (with bar) /
  电池 (hide when null) / 运行时间; formatted byte sizes (GB with one decimal) and uptime as
  "3 天 4 小时 5 分". Refresh every 10 s while this tab is active; stop on unmount/tab switch.
- Also show whether the Host reports screenshot capability and the `saveDirectory` value.

## Verification you must do yourself

- `node --check client/index.js` passes.
- `test/client.test.js` (node:test, no dependencies): stub `globalThis.window.__ModuleLoader__.load`,
  a fake `document` (`createElement` returning a tag-like object with `dataset`, `textContent`,
  `appendChild`/`remove` on a fake `head`), stub `require('react')` with the real React? **Do not
  require real React.** Provide a minimal `React` stub only good enough to let factory materialize:
  `createElement`, `useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`, `Fragment`. Assert:
  1. the module registers exactly once with id `dsh-mac-tools`;
  2. `factory(require)` returns `{ inject, apply }` with `inject` containing `slots` and `locale`;
  3. `apply(ctx)` calls `ctx.slots.inject` for `main` and `sidebar.panellist` and registers keys/ids
     `mac-tools`; locale registration includes both `zh` and `en`;
  4. the registered panel component is a function, and calling it inside a try/catch is NOT required;
  5. `document.head.appendChild` receives one `<style>` whose text contains `--dsw-alias-` and no
     `document.body` usage. Grep the source for forbidden tokens in the test as plain assertions
     (`require('@deepseek-ai`, `document.body`, `innerHTML =`).
- `node --test test/client.test.js` passes.
- Self-review the CSS: every color in UI chrome is a `var(--dsw-…)` token (annotation palette hex is the
  only exception); every visible string exists in both dictionaries; all listeners/timers are cleaned up.

## Ownership / process

- Write only `client/index.js` and `test/client.test.js`. Never edit `src/**`, `package.json`,
  `cordis.patch.yml`, `locale/**`, `icon.svg`, `README*`, or any profile file. Never run
  `plugin_manager` or restart anything — the Lead installs and verifies the bundle.
- When done, reply with: files written, `node --check` + `node --test` results, list of features and any
  known gaps or assumptions. If the Host contract seems inconsistent, message the Lead instead of
  inventing a different API.
