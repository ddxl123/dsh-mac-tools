# Mac 工具箱（DeepSeek Harness 插件）

[English](README.md) | [中文](README.zh.md)

一个 DeepSeek Harness 插件，装好即是一整套 **本机 Mac 工具箱**：

- **截图（类 QQ）**——用 macOS 原生区域/窗口选择框选任意应用，然后进入真正的编辑器：裁剪、箭头、矩形、椭圆、画笔、文字、马赛克、高亮，支持撤销/重做、复制到剪贴板、保存到磁盘。
- **文件**——面板里的访达式文件浏览器：左侧「位置」侧栏、可点击的面包屑路径、排序与预览窗格（图片内联、文本/代码最多 256 KB、PDF 用 Quick Look 首页缩略图）；可新建文件夹、重命名、从访达拖入文件、压缩成 zip、移到废纸篓，以及把文件发送到手机——不用切到访达。
- **计算器**——完整的计算器面板，计算走 Host 的精确表达式引擎（面板与端点共用同一个引擎，结果一致）。
- **手机互传**——手机和 Mac 连同一个 Wi-Fi，用手机相机扫二维码，就能用浏览器收发文本、文件、照片；不用装 App，文件不出局域网。
- **剪贴板**——截图、编辑后的图片和文件路径会直接写入 macOS 剪贴板（编辑器里的 ⌘C、「文件」页的复制路径）；Host 也会读取文本剪贴板用于自己的快捷流程。
- **运行状态**——类 App Store 应用 **State** 的实时监控：CPU/内存/磁盘/网络/电池曲线、系统信息、SMC 温度与风扇、进程排行、阈值告警；以及类 **Macs Fan Control** 的风扇转速控制（自动 / 手动转速 / 温度曲线 / 预设），首次启用需一次性管理员授权。原「系统信息」页已并入这里。

全部在本机完成。这是一个**纯面板插件**：只在左侧栏增加 **Mac 工具箱** 入口，**不向智能体注册任何工具**。

## 安装

这是一个普通的 DSH bundle。在任意会话里对插件目录安装即可：

```
plugin_manager  install_bundle  target: /绝对路径/dsh-mac-tools
```

或使用 CLI：

```
dsh plugin --profile desktop add /绝对路径/dsh-mac-tools
```

本地目录安装是链接方式。安装后刷新 Web 页面，左侧栏会出现 **Mac 工具箱**。如果安装时 Host 已经在运行，最稳妥的方式是重启一次 DeepSeek Harness，让两个半端版本一致。在**创造模式**（启用 HMR）下无需重启：在插件页把 `mac-tools` 行关掉再打开，会触发配置重组并原地重新加载链接的 Host 代码。

### 权限

截图需要 **系统设置 → 隐私与安全性 → 屏幕录制 → 允许 DeepSeek Harness**。没有授权时 macOS 会静默返回一张只有壁纸的图片（或拒绝窗口截图），面板会显示 `permission` 失败码并提示去哪个开关授权。

不需要辅助功能（Accessibility）权限：区域/窗口选择用的是 macOS 自带的原生选择界面；「文件」页只用普通文件读写、Quick Look 和 LaunchServices（不使用访达自动化），插件除此之外只额外读写剪贴板。首次读取桌面、文稿等受保护目录时，macOS 可能弹出它自己的文件访问授权，允许一次即可。

## 面板

从左侧栏打开，或按 **⌥⌘M**。**⇧⌘A** 直接开始一次交互截图，并打开面板进入编辑器。

**⌃⌥A**（可配置）是**系统级**截图快捷键：在任何其它应用拥有焦点时也能按。
它会拉起 macOS 原生区域/窗口选择，然后把截图**贴回原来的位置**（置顶悬浮窗，覆盖刚才框选的屏幕区域），同时复制到剪贴板、保存到截图目录，并播放 Glass 提示音（不需要自动贴图可设 `pinAfterGlobalCapture: false`）。
不需要额外权限；原生小助手首次会用 Xcode Command Line Tools 编译一次（开发者 Mac 通常已装）。

快捷键可以**在面板里直接自定义**：截图按钮下方的「全局截图快捷键」一行点 **修改**，然后按下新组合
（Control/Option/Command + 一个按键；Esc 取消）。自定义结果保存在 profile 的插件状态目录
（`<profile home>/dsh-mac-tools/hotkey.json`），重启不丢失；点 **恢复默认** 回到 `globalHotkey` 配置值。
面板内的快速截图快捷键（默认 ⇧⌘A）是 DSH 普通快捷键，可在 **设置 → 快捷键** 中改键。

### 截图页

- **区域 / 窗口截图**——屏幕变暗后拖拽框选；按 **空格** 切换到窗口点选模式，按 **Esc** 取消。
- **全屏截图**、**窗口截图**（点选一个窗口）、**3 秒后全屏**（延时截图）、**选择应用窗口**（列出所有可见应用窗口，可搜索，前台窗口有标记，点击即截取）。
- **历史截图**：每一次截图（面板截图或 ⌥A 全局截图）都会自动持久保存，并在编辑器下方以缩略图列表展示；点击可重新载入编辑器，也可直接贴图 / 复制 / 删除。
- **贴图可当场标注**：双击贴图（或按 **A**、右键「标注图片」），贴图上会浮出小工具栏——画笔 / 箭头 / 矩形 / 椭圆 / 高亮、颜色、粗细、撤销、清空、完成；在贴图上直接画，复制/保存会包含标注。想用完整面板编辑器时，右键选择「在面板中编辑」即可。
- **「截图时隐藏 DSH」**（默认开启）：屏幕截图时自动隐藏 DeepSeek Harness 窗口，截完立即恢复，避免自己的窗口挡住要截的内容；按钮就在截图工具栏上，可随时关闭。
  该开关同样作用于**全局快捷键截图**——快捷键截图没有页面可询问，所以由 Host 记住这个选择（当前 DSH 进程内有效）。
- 编辑器支持 **裁剪、箭头、矩形、椭圆、画笔、文字、马赛克、高亮**，六种颜色、三档线宽，撤销/重做/还原，**复制**（PNG 进剪贴板）、**保存**（保存到配置目录，并可在 Finder 中显示）与 **贴图**：把编辑后的图片作为**置顶悬浮窗**钉在桌面上，**位置就是截图时框选的屏幕区域**。之后可拖动、滚轮缩放、右键菜单（复制 / 保存 / 不透明度 / 关闭），Esc 关闭，⌘C 复制。
- 编辑器快捷键：`⌘Z` 撤销、`⇧⌘Z` 重做、`Enter` 应用裁剪、`Esc` 先取消裁剪再关闭截图。

### 文件页

面板里的访达式浏览器：查看、预览和管理文件，不用切到访达。

- **布局**：左侧「位置」侧栏（个人目录、桌面、文稿、下载、图片、影片、音乐、应用程序，挂载的卷及其可用空间，最近访问的文件夹）；工具栏有后退 / 前进 / 上一级、布局切换、可点击的面包屑路径、在当前文件夹内搜索、排序选择（名称 / 大小 / 修改时间 / 类型，升序或降序）、显示隐藏文件开关和刷新；中间是项目区；右侧是预览窗格。和 Mac 工具箱的其它页签一样，它占满窗口宽度——原来居中的 980 px 内容栏已经去掉。
- **三种布局**：**列表**（名称 / 大小 / 修改时间三列）、**图标**（大号彩色磁贴，图片显示缩略图）、**画廊**（大预览 + 底部胶片条）一键切换。文件夹是实心琥珀色剪影，文件是描边图标并按类型着色（图片绿、PDF 红、文本/代码蓝、音视频紫、压缩包蓝、其它灰），一眼就能区分。
- **预览**：图片直接内联显示；文本和代码文件最多显示 256 KB，超出时提示已截断；PDF 显示 Quick Look 首页缩略图；其它文件在有 Quick Look 预览时显示预览，并附带元数据——完整路径、大小、类型、修改时间。
- **选择与打开**：单击选中，⌘ 单击或 Shift 单击多选，双击文件夹进入，双击文件用默认应用打开。项目区上方**始终显示一行操作按钮**——打开、复制路径、在访达中显示、重命名、压缩为 zip、发送到手机、移到废纸篓；选中项目后按钮才会启用（重命名需要恰好选中一个）。右键菜单提供同样操作，另有新建文件夹和复制名称；发送到手机复用「手机互传」页的传输服务。
- **键盘**：`↑` / `↓` 移动选择，`Enter` 打开，`Backspace` 或 `⌘↑` 回到上一级，`Space` 切换预览，`⌘C` 复制所选路径，`⌘⌫` 把所选项目移到废纸篓。
- **拖放**：从访达把文件拖到列表上，会复制到当前文件夹。
- **安全**：读取不设限——你的账户能读的地方就能浏览；但所有写操作默认只允许在个人目录和挂载的卷（`/Volumes`）内。浏览器**从不永久删除**：「移到废纸篓」是把项目移进你自己的 `~/.Trash`，重名时按访达的方式改名；跨卷移入废纸篓会按「不支持」上报，而不是偷偷复制。不需要新权限（不需要辅助功能，也不使用访达自动化），不会新开网络监听——仍然走同一条受认证的 `/api/dsh-mac-tools` 路由。三个配置键用于初始化：`filesStartDirectory`、`filesShowHidden`、`filesFavorites`。

### 计算器页

显示屏 + 键盘 + 历史记录。计算走 Host 的引擎，面板与后端的 `calc` 端点共用同一个引擎，结果一致。支持 `+ - * / % ^`、括号、正负号、隐式乘法（`2(3+4)`）、百分号（`50%`）、常量 `pi`/`e`/`tau`，以及函数 `sqrt, cbrt, abs, round, floor, ceil, trunc, sign, exp, ln, log, log2, sin, cos, tan, asin, acos, atan, atan2, pow, hypot, min, max, mod`。三角函数默认按角度制计算。

### 手机互传页

一个只在局域网内工作的 Mac ↔ 手机中转站。点「开启手机互传」后，Host 会临时起一个 HTTP 监听，显示**二维码**（和 URL），并开始倒计时。用手机**系统相机**扫码（或手动输入 URL）即可打开一个免登录网页——不用装 App、不用账号、不走云。

- **手机 → Mac**：发文本（进面板收件箱，可一键复制到 macOS 剪贴板，也可配置自动复制）、选文件/照片，或直接拍照上传。上传带进度，文件保存到传输目录（默认 `~/Downloads/DSH 手机互传`），智能体可以像普通文件一样读取处理。
- **Mac → 手机**：输入文本发送、用系统选择框选任意文件，或在最近截图上一键「发送到手机」；手机页面会列出这些内容，可预览、复制或下载。截图直接取自历史记录。
- **安全**：每次会话一个随机 token，30 分钟过期；监听只在会话期间存在；服务端校验 Host 头、净化文件名，不向公网暴露。下载响应固定为 `attachment` + `application/octet-stream`（绝不当网页渲染），交给手机浏览器/下载管理器原生保存。
- **注意**：手机和 Mac 必须连同一个 Wi-Fi（开了 AP 隔离的访客网络不行）；第一次开启时 macOS 可能询问是否允许 DeepSeek Harness 接受传入连接；手机 VPN 可能拦截局域网访问；较新的 macOS 还可能询问本地网络权限。传输期间别让 Mac 休眠。
- **排障**：如果手机上传一直停在 0%，或点下载没反应，先把页面重新打开一次再重试；手机页会把浏览器异常、上传超时/停滞、下载失败上报到 `<插件状态目录>/transfer/diagnostics.log`（即 `~/.dsh/dsh-mac-tools/transfer/diagnostics.log`），同时记录每次上传开始/完成与下载请求，不用远程调试就能看出是哪一步失败。

## 配置

bundle 行支持以下配置（写在 `cordis.patch.yml` 或之后的 patch 层），都有默认值：

| 键 | 默认值 | 含义 |
|---|---|---|
| `saveDirectory` | `~/Pictures/DSH Mac Tools` | 截图保存目录，支持 `~` 展开。面板的“保存”和工具都写到这里。 |
| `maxShots` | `20` | 面板临时保留的截图数量，超过后淘汰最旧的；已保存文件不会被淘汰。 |
| `interactiveTimeoutMs` | `180000` | 原生选择界面等待操作者的最长时间。 |
| `hideAppDuringCapture` | `true` | 屏幕截图时短暂隐藏 DeepSeek Harness 窗口（仅当它是前台应用）并在截完后恢复；面板上有单次开关。 |
| `globalHotkey` | `ctrl+alt+a` | 系统级截图快捷键的**默认值**，任何应用在前台时都可用；面板里修改的值会覆盖它（保存到插件状态文件）；留空则初始不启用全局快捷键。 |
| `globalHotkeySound` | `true` | 全局快捷键截图成功后播放 Glass 提示音。 |
| `pinAfterGlobalCapture` | `true` | 全局快捷键截图后自动贴图到屏幕（面板编辑器里也始终有手动「贴图」按钮）。 |
| `historyLimit` | `60` | 历史截图最多保留多少张，超出后删除最旧的。 |
| `transferPort` | `8791` | 手机互传临时监听的优先端口；被占用时顺延尝试后面 9 个。 |
| `transferDirectory` | `~/Downloads/DSH 手机互传` | 手机发来的文件保存目录，支持 `~` 展开。 |
| `transferSessionMinutes` | `30` | 一次手机互传会话的有效期，到期后二维码失效、监听停止。 |
| `transferMaxFileMB` | `512` | 手机单次上传文件大小上限（MB）。 |
| `transferAutoCopyText` | `false` | 收到手机文本时自动复制到 macOS 剪贴板。 |
| `filesStartDirectory` | `''` | 「文件」页首次打开的目录，支持 `~` 展开；留空表示个人目录。 |
| `filesShowHidden` | `false` | 「文件」页是否默认显示隐藏文件（以点开头的文件）；面板上的开关可随时切换。 |
| `filesFavorites` | `[]` | 固定显示在「文件」页侧栏顶部的额外目录，支持 `~` 展开，例如 `['~/Projects', '~/Downloads']`。 |
| `monitorSampleMs` | `1000` | 「运行状态」页 Host 侧采样间隔（毫秒，500–10000）。软件指标最多每 2 秒采集一次，面板轮询频率可以更快或更慢。 |
| `alertCpuPercent` | `90` | 首次运行的 CPU 占用告警阈值（%）。面板运行时可改，持久化的选择优先于该默认值。 |
| `alertTemperatureCelsius` | `95` | 首次运行的温度告警阈值（°C，取 SMC 温度组）。 |
| `alertMemoryPercent` | `90` | 首次运行的内存占用告警阈值（%）。 |
| `alertCooldownSeconds` | `300` | 同一指标两次告警之间的最短间隔（秒）。 |
| `alertNotify` | `true` | 告警触发时是否发 macOS 通知。 |

```yaml
- id: mac-tools
  config:
    saveDirectory: ~/Desktop/Screenshots
    maxShots: 30
```

## 实现说明

- **原生小助手**（`assets/`）：`hotkey.swift` 监听系统级快捷键，`pin.swift` 把贴图显示为浮动的 AppKit 窗口，`qrcode.swift` 用 CoreImage 生成手机互传二维码；三者首次用 `swiftc` 编译并缓存到临时目录。`smc-core.swift` 是共享的只读 IOKit `AppleSMC` 传输层；`state.swift` 是常驻采样器，每个采样输出一行 JSON（风扇 + 全部可读温度键）；`fan-daemon.swift` 是风扇卡片安装的特权助手——只提供 Unix socket JSON 的 `F0Md`/`F0Tg` 写入，目标转速夹在 SMC 上下限内，并带 12 秒看门狗自动恢复系统自动控制。
- **Host 半端**（`src/`）：在 Connection 的 `/api` 通道上注册受认证的 `/api/dsh-mac-tools` 路由，维护临时截图注册表，用 `/usr/sbin/screencapture` 截图、用 `/usr/bin/osascript` 获取窗口列表、写图片剪贴板和打开文件选择框。「运行状态」页是一条采样循环（`src/monitor.js`），底层是 `src/metrics.js`（CPU/内存/磁盘/网络/电池）、`src/smc.js`（采样器子进程）、`src/alerts.js`（阈值）与 `src/fans.js`（风扇控制与 socket 协议）。手机互传监听（`src/transfer.js`）是一个独立的、按需启动的 `node:http` 服务，只在会话期间绑定局域网；它提供手机网页和上传/下载 API，收发索引存在插件状态目录。「文件」页的 Host 侧（`src/files.js`）只用 Node 内置的文件 API，不新增依赖；Quick Look 缩略图、挂载卷发现、LaunchServices 打开/在访达中显示、系统 zip 与用户废纸篓等 macOS 特性沿用插件的平台开关；它唯一的状态是插件状态目录里的最近文件夹列表和缩略图缓存。不注册任何智能体工具。
- **Client 半端**（`client/index.js`）：一个由 `window.__ModuleLoader__` 加载的纯 React bundle，注册左侧栏入口和 `main` 面板，渲染五个分页，只通过上面的路由与 Host 通信。
- 截图引擎是对系统工具的一层薄封装——区域/窗口选择、取消、窗口点选都是 macOS 原生行为，不是重新实现。

```
POST /api/dsh-mac-tools   { "endpoint": "...", "payload": { ... } }
GET  /api/dsh-mac-tools?shot=<id>    → image/png
GET  /api/dsh-mac-tools?history=<id> → image/png
GET  /api/dsh-mac-tools?inbox=<id>   → 手机发来文件的字节
GET  /api/dsh-mac-tools?file=<绝对路径>                        → 内联栅格图片
GET  /api/dsh-mac-tools?thumb=<绝对路径>&size=<64..1024>       → Quick Look PNG 缩略图
```

`?inbox=` 预览只对安全的栅格图片（`png`、`jpeg`、`gif`、`webp`、`avif`、`bmp`）内联返回；其它文件一律以 `application/octet-stream` 附件返回，手机上传的 HTML/SVG 因此不可能在 Web UI 源上执行。

「文件」页遵循同样的规则：`?file=` 只内联上述栅格类型（`nosniff`、`no-store`），其它类型一律拒绝；`?thumb=` 对 PDF、Office 文档等非栅格文件返回 Quick Look 生成的 PNG 缩略图，缓存在插件状态目录。

端点：`status`、`windows`、`capture`、`cancelCapture`、`copy`、`save`、`calc`、`clipboard`、`system`、`reveal`，手机互传的
`transferStatus`、`transferStart`、`transferStop`、`transferInbox`、`transferOutbox`，运行状态的
`monitor`、`monitorProcesses`、`monitorKill`、`monitorAlertSave`、`monitorAlertTest`，风扇控制的
`fanInstall`、`fanUninstall`、`fanApply`、`fanPreset`，以及「文件」页的
`filesPlaces`、`filesList`、`filesRead`、`filesMkdir`、`filesRename`、`filesTrash`、`filesCompress`、`filesReveal`、`filesOpen`、`filesSend`、`filesDrop`。返回
`{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

手机访问的是它自己的临时服务 `http://<Mac局域网IP>:<端口>/t/<token>/`（页面、`api/state`、`api/text`、`api/upload`、`api/items/<id>`），
那不是 Harness 的 API，也不携带 Harness 会话。

## 开发

```
npm run check     # 所有模块 node --check + node --test test/
```

Host 半端除 dsh 自带的 `@deepseek-ai/schemastery` 配置 schema 外无第三方依赖；Client 半端只需要 `react`。

## 许可证

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
