# 手机互传（方案 A）实现契约

局域网网页 + 二维码：Mac 插件按需起一个临时 HTTP 服务，手机扫码用浏览器打开，双向传文本、文件、图片。
本文件是 Host 服务、手机网页、面板 UI 三部分并行实现的唯一契约；三部分不得各自发明 API。

## 1. 文件所有权

| 角色 | 写入范围 |
|---|---|
| 服务端实现者 | `src/transfer.js`、`src/transfer-qr.js`、`assets/qrcode.swift`、`test/transfer.test.js`、`test/transfer-qr.test.js` |
| 手机网页实现者 | `src/transfer-page.js`、`test/transfer-page.test.js` |
| 面板 UI 实现者 | `client/index.js`、`test/client.test.js` |
| Lead（集成） | `src/config.js`、`src/ops.js`、`src/index.js`、`src/route.js`、`package.json`、`cordis.patch.yml`、`locale/*.json`、`README*.md`、`test/manifest.test.js`、`test/ops.test.js`、`test/route.test.js`、本文件 |

不要修改别人的文件。不要运行 `plugin_manager`，不要重启 DSH。

## 2. 配置项（Lead 在 `src/config.js` 实现，服务端通过构造参数接收）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `transferPort` | number | `8791` | 首选端口；被占用时顺延最多 9 个 |
| `transferDirectory` | string | `''` → `~/Downloads/DSH 手机互传` | 手机发来的文件落盘目录 |
| `transferSessionMinutes` | number | `30` | 一次互传会话的有效期（分钟） |
| `transferMaxFileMB` | number | `512` | 单个上传文件上限（MB） |
| `transferAutoCopyText` | boolean | `false` | 收到手机文本时自动写入 macOS 剪贴板 |

## 3. `src/transfer.js` — TransferServer

ESM，只依赖 Node 内置模块（`node:http`、`node:fs`、`node:os`、`node:path`、`node:crypto`、`node:child_process`）。
不 import 本项目其它模块（`ops.js` / `capture.js` 都不 import），依赖全部由构造函数注入。

```js
export class TransferError extends Error {
  // code: 'unsupported' | 'port_unavailable' | 'invalid_request' | 'too_large'
  //     | 'not_found' | 'io_error' | 'not_active'
  constructor(code, message, details = {})
}

export class TransferServer {
  constructor({
    directory,            // string，必填，接收文件目录（绝对路径）
    stateDirectory,       // string，必填，index.json 所在目录（绝对路径）
    port = 8791,          // 0 = 随机端口（测试用）
    bindHost = '0.0.0.0',
    sessionMinutes = 30,
    maxFileBytes = 512 * 1024 * 1024,
    autoCopyText = false,
    hostName = os.hostname(),
    page = undefined,     // string | () => string|Promise<string>，手机页；集成层传 renderTransferPage。缺省用内置最小回退页
    qr = undefined,       // async (text) => base64 PNG；失败可 throw
    notify = undefined,   // async ({title, body}) => void，尽力而为
    copyText = undefined, // async (text) => void，尽力而为
    history = undefined,  // HistoryStore（addHistory 用；可空）
    keepAwake = true,     // darwin 下会话期间 spawn caffeinate，stop 时 kill
    warn = () => {},
  })
}
```

### 3.1 生命周期

- `async start()`：若已 active 直接返回当前 status（幂等，不换 token）。
  1. 生成 `token = randomBytes(18).toString('base64url')`。
  2. `http.createServer(handler).listen(port, bindHost)`；`port !== 0` 且 `EADDRINUSE` 时依次尝试 `port+1 … port+9`，全失败抛 `TransferError('port_unavailable', ...)`。
  3. 计算 URL 列表（见 3.2），对首个 URL 调 `qr(url)`；QR 失败**不算启动失败**：`qrPngBase64 = null`，`qrError = message`。
  4. 设置 `startedAt`/`expiresAt`（ISO 字符串），`setTimeout(stop, sessionMinutes*60_000).unref()`。
  5. `keepAwake && process.platform === 'darwin'` 时 `spawn('/usr/bin/caffeinate', ['-i', '-s'], {stdio:'ignore'})`，失败忽略；stop 时 kill。
  6. 返回 `status()`。
- `stop()`：关闭 server（`closeAllConnections?.()`）、清计时器、kill caffeinate、token 失效。可重复调用。
- `dispose()`：`stop()` + 不再接受调用（集成层在插件卸载时调用）。
- `status()`：见 3.3。

### 3.2 URL 计算

`os.networkInterfaces()` 取 IPv4、非 internal、名字不以 `utun`/`awdl`/`llw`/`bridge`/`lo` 开头的地址；
`en0`/`en1` 的地址排在最前。主机名若不以 `.local` 结尾则补 `.local`。URL 形如：

```
http://192.168.1.47:8791/t/<token>/
http://linlongdeMac-mini-7.local:8791/t/<token>/
```

去重；首个 IPv4 URL 为 `url`（QR 用它）。没有任何局域网地址时仍可启动（绑定 loopback 可达），
`url` 退回 `http://127.0.0.1:<port>/t/<token>/`，并在 `warnings` 里写一条说明（英文，面板自行本地化或原样显示）。

### 3.3 `status()` 返回（JSON 可序列化）

```js
{
  active: boolean,
  directory: string,
  maxFileMB: number,
  sessionMinutes: number,
  autoCopyText: boolean,
  inboxCount: number,
  outboxCount: number,
  // active 为 true 时：
  url: string | null,
  urls: string[],
  port: number | null,
  token: string | null,
  qrPngBase64: string | null,   // 纯 base64，无 data: 前缀
  qrError: string | null,
  startedAt: string | null,     // ISO
  expiresAt: string | null,     // ISO
  warnings: string[],
}
```

inactive 时 `url/urls/port/token/qrPngBase64/qrError/startedAt/expiresAt` 为 `null`/`[]`，`warnings: []`。

### 3.4 条目形状

inbox（手机 → Mac，面板用）：

```js
{
  id: 'i-<16hex>',
  kind: 'text' | 'file',
  name: string,            // text: `text-YYYYMMDD-HHMMSS.txt`；file: 净化后的文件名
  size: number,            // bytes
  mime: string,            // text: 'text/plain'
  createdAt: string,       // ISO
  previewable: boolean,    // kind === 'file' && mime.startsWith('image/')
  text?: string,           // 仅 kind === 'text'
  path?: string,           // 仅 kind === 'file'，绝对路径
}
```

outbox（Mac → 手机）：

```js
{
  id: 'o-<16hex>',
  kind: 'text' | 'file' | 'history',
  name: string,            // text: `text-...txt`；history: `screenshot-YYYYMMDD-HHMMSS.png`；file: basename
  size: number,
  mime: string,
  createdAt: string,
  previewable: boolean,
  text?: string,           // text
  path?: string,           // file（绝对路径）
  historyId?: string,      // history
}
```

排序：新→旧。持久化到 `<stateDirectory>/index.json`（0600，tmp+rename 原子写）：
`{ version: 1, inbox: [...], outbox: [...] }`。加载时丢掉 `path` 已不存在的 file 条目；text 条目始终保留。
text 条目最多各 200 条，超出丢最旧；file 条目不做自动删除（文件在用户目录里）。
inbox 的 file 落盘到 `directory`，文件名净化规则：basename、去掉 `/\:*?"<>|` 与控制字符、去首尾点/空格、限 120 字符；
重名追加 ` (1)`、` (2)`；保留原扩展名。上传先写 `.<name>.part-<hex>` 再 rename。

### 3.5 公开方法（`src/ops.js` 调用）

```js
async start() -> status
stop() -> void
status() -> status
listInbox() -> { items: inboxItem[], count }
listOutbox() -> { items: outboxItem[], count }
clearInbox() -> { cleared: number }            // 删除 inbox 文件 + 记录
deleteInbox(id) -> { deleted: boolean, id }
copyInboxText(id) -> { copied: true, bytes }   // 非 text 条目抛 invalid_request
revealInbox(id) -> { revealed: true, path }    // 非 file 条目抛 invalid_request
clearOutbox() -> { cleared: number }           // 只删记录，不删原文件
removeOutbox(id) -> { removed: boolean, id }
addText(text) -> { item: outboxItem }          // 上限 64 KiB UTF-8
addFile(path) -> { item: outboxItem }          // 路径必须存在且是普通文件
addHistory(historyId) -> { item: outboxItem }  // 需要 history 注入，否则 unsupported
readInboxFile(id) -> { buffer: Buffer, mime: string, name: string }  // 面板预览用；上限 32 MiB
dispose() -> void
```

错误一律 `TransferError`；`not_found` 用于未知 id / 文件消失。

### 3.6 HTTP 服务（手机侧）

只接受 `GET` / `POST`；其它 405。所有响应带：
`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。
**不要**发任何 CORS 头。

路径解析：`/t/<token>/...`；token 用 `timingSafeEqual` 常量时间比较，不匹配返回 **404**（不泄露原因）。
Host 头校验：允许集合 = 各局域网 IP:port、`<hostname>.local:port`、`localhost:port`、`127.0.0.1:port`；
Host 缺失或不在集合内 → **403**（防 DNS rebinding）。同一 IP 60 秒内 token 失败 > 20 次 → **429**。

| 方法/路径 | 行为 |
|---|---|
| `GET /t/<token>` | 302 → `/t/<token>/` |
| `GET /t/<token>/` | 手机页 HTML（`text/html; charset=utf-8`），CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| `GET /t/<token>/api/state` | `{ device: { name }, now: ISO, expiresAt: ISO, inboxCount, outbox: { items: publicOutboxItem[], count } }`；`publicOutboxItem` 去掉 `path` |
| `POST /t/<token>/api/text` | body `application/json` `{ text }`（64 KiB 上限）→ `{ item: publicInboxItem }`；触发 notify / autoCopyText |
| `POST /t/<token>/api/upload?name=<encodeURIComponent(name)>` | 原始字节流（`application/octet-stream` 或任意 content-type）→ `{ item: publicInboxItem }`；超过 `maxFileBytes` → 413 且删除半成品；空 body → 400 |
| `GET /t/<token>/api/items/<id>` | 下载/预览 outbox 条目：text → `text/plain; charset=utf-8` attachment；history → `history.read()` bytes；file → 流式读取。`image/*` 用 `inline`（手机可预览/长按保存），其余 `attachment; filename*=UTF-8''...`；未知 id → 404 |
| 其它 | 404 |

`publicInboxItem` = inboxItem（手机只看到自己刚发的，含 `path` 无妨；但不要暴露 state 以外的目录信息）。
`publicOutboxItem` = outboxItem 去掉 `path`。

上传/文本成功后：`notify({ title: 'Received from phone', body: name })`（尽力而为，异常吞掉）；
`autoCopyText` 为 true 时对文本调 `copyText(text)`（异常吞掉）。

### 3.7 `src/transfer-qr.js`

```js
export function resolveSwiftc() -> string | undefined
export function qrSourcePath() -> string   // fileURLToPath(new URL('../assets/qrcode.swift', import.meta.url))
export async function generateQrPng(text, {
  sourcePath = qrSourcePath(),
  cacheDirectory = join(tmpdir(), 'dsh-mac-tools-qrcode'),
  swiftc = resolveSwiftc(),
  run = undefined,        // 可注入：async (cmd,args,opts) => {stdout,...}
  timeoutMs = 25000,
  size = 512,
} = {}) -> Promise<string>  // base64 PNG，无 data: 前缀
```

实现：按源码 sha256 前 16 位缓存二进制到 `cacheDirectory/qrcode-<arch>-<hash>`；`swiftc -O <src> -o <bin>`；
执行 `<bin> <text> <size>`，stdout 即 base64（去掉首尾空白）。错误带 `code`：`swift-missing` / `compile-failed` / `qr-failed`。
`assets/qrcode.swift`：CoreImage `CIQRCodeGenerator`（纠错级别 M）→ 缩放到 `size` → `NSBitmapImageRep` PNG → stdout base64；
参数不足 exit 2，失败 exit 非 0 并在 stderr 写原因。

### 3.8 服务端测试（`test/transfer.test.js`、`test/transfer-qr.test.js`）

`node:test` + `node:assert/strict`，不联网、不依赖 swiftc：
- `start()`（`port:0`、`bindHost:'127.0.0.1'`、`qr: async () => 'QR'`、`keepAwake:false`）→ active、token、url、port。
- 页面：正确 token 200 且 `text/html`；错误 token 404；Host 头伪造（用 `http.request` 发 `Host: evil.example`）403。
- 文本：POST → inbox 出现、`autoCopyText:true` 时 copyText 被调用、notify 被调用。
- 上传：raw bytes → 文件落盘、名字净化（`../..%2Fevil.png` → 安全 basename）、重名加后缀；超限 413 且无残留；空 body 400。
- outbox：`addText` / `addHistory`（假 history 对象）/ `addFile`，`GET /api/items/<id>` 返回正确 bytes/content-type；未知 id 404。
- 删除/清空/持久化：新实例能读回 index；file 消失的条目被丢弃。
- `stop()` 后 token 404；重复 start 幂等；`dispose()` 不抛。
- `test/transfer-qr.test.js` 只测注入 `run` 的缓存/参数逻辑（不真的跑 swiftc）。

## 4. `src/transfer-page.js` — 手机网页

```js
export function renderTransferPage() -> string   // 完整 HTML 文档
```

要求：
- 纯静态 HTML，不接收参数、不拼任何用户数据；token 由页面 JS 从 `location.pathname` 的 `/t/([A-Za-z0-9_-]+)/?` 提取。
- 内联 CSS + JS，**不引用任何外部资源**（无 CDN、无字体、无图片 URL）；CSP 允许 inline。
- `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`；移动优先，深色/浅色跟随 `prefers-color-scheme`；输入框 16px 防 iOS 缩放；安全区 padding。
- 顶部：设备名（来自 `api/state.device.name`）、剩余时间倒计时（`expiresAt`）、在线状态点。
- 两个分段：「发给 Mac」/「从 Mac 接收」。
  - 发给 Mac：textarea + 发送按钮（⌘/Ctrl+Enter）；`<input type="file" multiple>` 选文件/相册；
    `<input type="file" accept="image/*" capture="environment">` 拍照直传；上传队列逐条进度（**XHR** `upload.onprogress`）与成功/失败状态。
  - 从 Mac 接收：轮询 `api/state`（2 秒；`document.hidden` 时暂停）渲染 outbox 列表：
    文本条目显示文本 + 复制按钮（`navigator.clipboard.writeText` 失败时用 `document.execCommand('copy')` 兜底）；
    文件/截图条目显示名字、大小、下载链接 `api/items/<id>`（图片直接 `<img>` 预览 + 下载链接）。
  - 手动刷新按钮、空状态、错误提示（`aria-live`）。
- 所有用户文本用 `textContent`/`createTextNode` 渲染，**禁止 innerHTML 拼接用户数据**；不写 `document.write`。
- 上传用 `XMLHttpRequest`（`POST api/upload?name=...`，body 为 File，`Content-Type` 用文件 type 或 octet-stream）。
- 文本发送 `fetch('api/text', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({text})})`。
- 页面文案中英双语，按 `navigator.language` 选择（`zh*` → 中文，其余英文）；所有字符串集中在一个小字典里。
- 顶部/底部提示：文件只在局域网内传输、会话到期时间、遇到连不上时检查同一 Wi-Fi / 防火墙。
- 测试 `test/transfer-page.test.js`：`renderTransferPage()` 返回 `<!doctype html>`；含 viewport、file input、`capture="environment"`、`XMLHttpRequest`、`api/state`、`api/text`、`api/upload`、`api/items/`、`execCommand`；不含 `https://`/`http://` 外部 URL、`<script src=`、`innerHTML`。

## 5. `src/ops.js` — 面板 ops（Lead 实现，客户端按此调用）

统一信封不变：`POST /api/dsh-mac-tools` `{ endpoint, payload }` → `{ ok, value }` / `{ ok, error: { code, message, details } }`。

| endpoint | payload | value |
|---|---|---|
| `transferStatus` | `{}` | `status()`（3.3） |
| `transferStart` | `{}` | `status()`（可能较慢：首次 QR 编译 Swift） |
| `transferStop` | `{}` | `status()` |
| `transferInbox` | `{ action?: 'refresh'\|'clear'\|'delete'\|'copyText'\|'reveal', id? }` | 见下 |
| `transferOutbox` | `{ action: 'refresh'\|'clear'\|'remove'\|'addText'\|'addFile'\|'addHistory', id?, text? }` | 见下 |

- `transferInbox refresh` → `{ items, count }`；`clear` → `{ cleared }`；`delete` → `{ deleted, id }`；
  `copyText` → `{ copied: true, bytes }`；`reveal` → `{ revealed: true, path }`。
- `transferOutbox refresh` → `{ items, count }`；`clear` → `{ cleared }`；`remove` → `{ removed, id }`；
  `addText` → `{ item }`；`addHistory` → `{ item }`；
  `addFile` → 打开 macOS 原生多选文件框（osascript），`{ cancelled: boolean, items: outboxItem[] }`
  （取消时 `cancelled:true, items:[]`，不是错误）。
- 错误码：`unsupported`（非 macOS / 未注入）、`not_found`、`invalid_request`、`too_large`、`io_error`、`port_unavailable`。
- `status` op 的 `capabilities` 增加 `transfer: boolean`。
- 面板预览：`GET /api/dsh-mac-tools?inbox=<id>` 返回 inbox 文件字节（route.js 扩展，Lead 实现）；
  客户端 URL：`${API_PATH}?inbox=${encodeURIComponent(item.id)}&t=${Date.parse(item.createdAt)}`。

## 6. `client/index.js` — 面板「手机互传」tab（UI 实现者）

- `TABS` 增加 `'transfer'`（顺序：screenshot, calculator, system, transfer），字典加 `tab.transfer`（zh「手机互传」/ en「Phone」）。
- 面板保持现有架构：store + `useStoreSnapshot` + `React.createElement`，不新增 require、不写 JSX、不碰 `document.body`。
- 组件 `TransferTab({ store, snapshot, t, active })`，仅 `active` 时轮询，清理 timer/AbortController。
- store 增加 `transfer` 切片与动作（内部命名自由，但要调用上表 ops）：

```js
transfer: {
  status: 'idle' | 'loading' | 'starting' | 'active' | 'stopping' | 'error',
  session: null | status对象,        // 3.3 的完整 status（active 时）
  inbox: { status, items: [], count: 0, error: null },
  outbox: { status, items: [], count: 0, error: null },
  textDraft: '',
  sendingText: false,
  addingFile: false,
  toast: null | { kind: 'ok' | 'error', text: string },
  error: null | { code, message, details },
}
```

动作：`loadTransferStatus`、`startTransfer`、`stopTransfer`、`refreshTransferInbox`、`refreshTransferOutbox`、
`deleteTransferInboxItem`、`clearTransferInbox`、`copyTransferText`、`revealTransferInboxItem`、
`setTransferTextDraft`、`sendTransferText`、`sendTransferFile`、`sendHistoryToPhone`、
`removeTransferOutboxItem`、`clearTransferOutbox`、`dismissTransferToast`。

UI：
1. 顶部卡片：未开启时说明 + 「开启手机互传」；开启中 spinner；已开启时二维码（`data:image/png;base64,`）、
   主 URL 文本 + 复制按钮、局域网地址列表、剩余时间倒计时、`停止互传`、警告/`qrError` 提示。
2. 两栏（窄屏堆叠）：左「手机发来的内容」（inbox），右「发送到手机」（outbox）。
   - inbox 行：文本预览 + 复制；图片 56px 缩略图（`?inbox=` URL）；文件名/大小/时间；`在 Finder 中显示`、`删除`。
   - outbox：文本输入 + 发送；「选择文件…」；「最近截图」6 张缩略图，每张一个「发送到手机」；outbox 列表（类型徽标、名字、大小、移除）。
   - 卡片头：数量、刷新、清空（清空前二次确认，沿用现有 confirm 模式）。
3. 底部 toast（aria-live polite）：已发送 / 已复制 / 失败；3 秒自动消失。
4. 空状态、错误状态（复用 `hostErrorText` 风格）、加载骨架。
5. 文案全部进 zh/en 字典（新增键两边必须一致），`tab.transfer` 加入 `test/client.test.js` 的 required 列表。
6. 样式加进现有 `css` 模板，类名前缀 `dshMacToolsTransfer…`，chrome 颜色只用 `--dsw-*` token。
7. 轮询：tab active 时 `loadTransferStatus` 2s、inbox/outbox 4s、倒计时本地 1s；inactive/卸载时全部清理。
8. 验证：`node --check client/index.js`、`node --test test/client.test.js` 必须通过。

## 7. 集成（Lead）

- `src/index.js`：创建 `TransferServer`（目录、state 目录、端口、时长、大小、autoCopy、history、notify=`captureModule.showNotification`、
  copyText=`captureModule.copyTextToClipboard`、qr=`generateQrPng`），传给 `createOps({ transfer })`，`ctx.effect` dispose。
- `src/route.js`：`GET` 支持 `?inbox=<id>`，通过注入的 `readInboxFile` 返回字节（content-type 用条目 mime）。
- `package.json`：`check` 脚本加入 `src/transfer.js`、`src/transfer-qr.js`、`src/transfer-page.js`。
- `cordis.patch.yml`、`README*.md`、`locale/*.json` 更新。
- 全量 `npm run check`（node --check + node --test）必须通过。

## 8. 通用约定

- ESM、JSDoc 注释、`node:test`；不新增第三方依赖；不写绝对用户路径。
- 错误对象带稳定 `code`；失败不抛未捕获异常。
- 所有时间字段用 ISO 字符串；大小用 bytes 数字。
- 不要把 token 写日志；不要暴露 `directory` 之外的文件。

## 9. 审计修订（2026-10-23，v0.2.1）

实现完成后，服务端 / 手机网页 / 面板 UI 三路独立审计并做了真实 HTTP + 真实 QR 端到端验证。以下条款在此收紧或补充，其余条款不变。

### 9.1 服务端（`src/transfer.js`、`src/transfer-qr.js`、`assets/qrcode.swift`）

- **会话代际**：`stop()` / `dispose()` 会让一个仍在 `listen()` 或生成 QR 的 `start()` 作废（单调 `sessionGeneration`）；作废的启动会关闭已绑定的 listener 并返回 inactive，不会复活会话，也不会泄漏 expiryTimer / caffeinate。
- **请求超时**：监听成功后 `server.requestTimeout = sessionMinutes*60_000 + 60_000`，避免 Node 默认 300 s 掐断慢速大文件上传；会话到期与 `stop()` 的 `closeAllConnections()` 仍是硬边界。
- **并发上传**：临时文件通过 `linkSync` 原子独占占名（`EEXIST` 换名重试，最多 1000 次）；不支持硬链接的卷回退 `renameSync`。同名并发上传不会互相覆盖。
- **流式下载**：`GET /api/items/<id>` 改用 `stream.pipeline`，手机中断连接会销毁 ReadStream，不再泄漏 fd。
- **QR 缓存**：`swiftc` 先编译到私有临时文件，校验非空后原子 rename；编译失败/超时不会留下可被后续误用的坏二进制。`assets/qrcode.swift` 改为整数倍缩放 + ≥4 模块静区。
- **`previewable`**：只有 png/jpeg/gif/webp/avif/bmp 为 true（SVG/TIFF/HEIC 不再参与面板 `<img>` 预览）；旧 index 载入时按 mime 重算。
- **轮询体积**：`listInbox()` / `listOutbox()` / `GET /api/state` 的 text 条目最多内联 `TEXT_PREVIEW_CHARS = 512` 个 **码点**（不切断代理对），超出时附 `textTruncated: true`；完整文本仍通过 `GET /api/items/<id>` 和 `copyInboxText()` 获取，index 持久化数据不变。
- **其他**：端口顺延不会越过 65535（越界统一报 `port_unavailable`）；`caffeinate` 带 `-w <host pid>`，Host 崩溃后自动退出；index.json 损坏会告警一次后按空列表恢复。

### 9.2 手机网页（`src/transfer-page.js`）

- 所有请求（含 `api/state` 轮询）带 12 s `AbortController` 超时；超时后释放 `pollBusy` 并自动恢复，不再永久卡在「连接中」。
- 文本发送成功只在 textarea 内容仍是发送原文时清空；`Ctrl/⌘+Enter` 忽略 IME 组合态。
- 上传失败行内提供「重试」（仅网络错误 / 5xx / 429）；会话过期时 pending 队列进入终态，倒计时停止。
- 两个 live region 常驻无障碍树并纵向堆叠（不再重叠/漏播报）；过期提示只播报一次。
- 文本预览超过 512 码点时显示省略号；复制按钮按需 GET `api/items/<id>` 取全文后复制，取回失败明确报错，绝不静默复制截断内容。

### 9.3 面板（`client/index.js`）

- 状态轮询与 start/stop 使用代际守卫：首次启动 QR 编译慢时不会闪「二维码不可用」，stopping 不被旧轮询翻回 active；列表轮询代际守卫避免旧响应复活已删除条目或隐藏刚发送条目。
- 发送文本在途时不清空新输入；start/stop 失败补 3 s toast；错误卡不再被每个轮询周期重置为骨架。
- 倒计时拆为叶子组件，避免整个 tab 每秒重渲染。

### 9.4 面板路由（`src/route.js`）

- `GET /api/dsh-mac-tools?inbox=<id>` 只对安全栅格图（png/jpeg/gif/webp/avif/bmp）内联返回；`text/html`、`image/svg+xml` 等一律 `application/octet-stream` + `attachment; filename*=UTF-8''…`，并附 `Content-Security-Policy: default-src 'none'; sandbox`。手机上传的 HTML/SVG 无法在 Web UI 源上执行。

### 9.5 集成（`src/index.js`）

- `TransferServer` 构造失败（接收目录不可写、状态损坏等）只关闭互传 tab，不再让整个插件行加载失败。

### 9.6 本轮验证基线

- `node --test test/`：**213 项全绿**（新增互传相关回归 60+ 项）。
- 独立 E2E（不入库，生产接法 `TransferServer` + `renderTransferPage` + 真实 `swiftc` QR）：**41/41 检查通过**，覆盖页面/CSP、文本、上传净化与并发、下载完整字节、伪造 Host/错 token/限流、停启竞态、超限清理、持久化重载与 429。
- QR 可扫验证：CoreImage 生成的 PNG 用系统 `CIDetector` 解码，内容与 `status().url` **完全一致**（本机示例 `http://192.168.1.47:8791/t/<token>/`）。
- 安装：Creator mode（HMR 启用）下通过插件页把 `mac-tools` 行关掉再打开即可原地重载链接的 Host 代码，无需重启 Harness。

## 10. 真机联调修订（2026-10-23，v0.2.2）

Android 真机联调（第三方浏览器）暴露了两个只在真实手机上出现的问题，本节修订 `§3.6` 的下载语义并补充诊断与兼容处理。

### 10.1 下载语义（修订 §3.6）

`GET /t/<token>/api/items/<id>` 默认是**下载**，不再是"图片 inline、其它 attachment"：

- `Content-Disposition: attachment; filename="<ASCII 回退名>"; filename*=UTF-8''<编码名>`
  —— 同时给出旧的 `filename` 回退，供忽略 RFC 5987 的下载管理器使用。
- `Content-Type: application/octet-stream`（下载语义；原始 MIME 不再参与浏览器渲染决策）。
- `?inline=1` 请求内联预览，只对安全栅格图（png/jpeg/gif/webp/avif/bmp）生效；手机网页的 `<img>` 缩略图用它。其它类型即使带 `inline=1` 也按下载返回。

原因：Android 第三方浏览器/下载管理器经常忽略 `Content-Disposition: inline` 上的 `download` 属性，点"下载"表现为没反应或报错；强制 attachment + octet-stream 后再由页面用 Blob 兜底，才能可靠保存。

### 10.2 新增 `POST /t/<token>/api/diag`

手机无法远程调试，页面把未捕获异常、上传超时/停滞、下载失败等以 JSON（≤16 KiB，超限 413）上报：

```json
{ "kind": "page-error", "message": "…", "source": "/t/<token>/", "line": null, "detail": "…" }
```

服务端追加一行 JSON 到 `<stateDirectory>/diagnostics.log`（0600，超过 256 KiB 时轮转为 `.log.1`），返回 204。该日志同时记录 `upload-start` / `upload-done` / `upload-failed` 以及 `item` 下载请求（含 UA、远端地址、大小），用于定位“上传卡在 0%”这类只在手机侧出现的问题。URL 中的 token 不写入日志。

### 10.3 浏览器兼容加固

- 监听：`keepAliveTimeout = 65 s`、`headersTimeout = 66 s`。Node 默认 5 s keep-alive 与 2 s 轮询叠加时，部分 Android 浏览器会在“服务器刚好关闭旧连接”的时刻发出新请求并长时间无进展；延长空闲连接后消失。
- 手机页上传：XHR 增加 180 s 硬超时 + 30 s 无进度看门狗；停滞/`onerror`/`ontimeout` 时自动 abort 并用 **fetch 发送同一文件**兜底（fetch 在同类浏览器上可用性明显更高），失败才标记可重试错误；队列不会永久卡在 0%。
- 手机页下载：服务端强迫 `attachment` + `application/octet-stream`，页面只渲染普通下载链接、不拦截点击（保留浏览器的原生下载管理器与用户手势），并对图片缩略图改用 `?inline=1`。
- 手机页全局 `error` / `unhandledrejection` 上报到 `api/diag`，便于以后同类问题直接看日志。

### 10.4 验证

- `node --test test/`：全绿；新增断言覆盖 attachment/octet-stream、`inline=1`、`/api/diag` 落盘、keep-alive 超时、上传兜底与看门狗。
- 真机复测由用户执行（本机无法模拟 Android 第三方浏览器）。
