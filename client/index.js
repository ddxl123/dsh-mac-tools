/**
 * dsh-mac-tools — browser half.
 *
 * ## What it registers
 *
 *   - `sidebar.panellist` — the toolbox entry in the left rail (`id: 'mac-tools'`),
 *     which the shell opens through `layout.selectPanel(id)`.
 *   - `main` keyed by the same id — the panel page itself: a QQ-style screenshot
 *     tab (native capture, window picker, crop and annotation editor), a
 *     calculator driven by the Host's own evaluator, a live status tab (CPU /
 *     memory / disk / network / battery charts, SMC temperature sensors, the
 *     merged system-information section, fan control, process ranking and
 *     threshold alerts), and a phone-transfer tab that starts a temporary LAN
 *     page a phone can open by QR code to exchange text, files and screenshots.
 *   - two global shortcuts: `primary+alt+KeyM` toggles the panel, and
 *     `primary+shift+KeyA` starts an interactive capture and brings the panel
 *     forward with the editor already mounted.
 *
 * ## Where state lives
 *
 * The Host half owns every durable thing: the temporary shot registry, the
 * calculator engine, the clipboard, live-status snapshots and the
 * `/api/dsh-mac-tools` route. This half owns only view state — this plugin is panel-only and
 * registers no agent tools. The one instance
 * of it is created in `apply()` — a module-level store handed to the panel and
 * to the shortcut handlers — so a capture started from the keyboard reaches
 * the panel even when the panel is not on screen yet, and so edited shots and
 * calculator history survive switching between tabs and panels.
 *
 * ## Why it is a hand-written bundle
 *
 * Client halves load through `window.__ModuleLoader__` as prebuilt CJS-table
 * bundles, not Node resolution, so this file registers one factory instead of
 * exporting ESM. `react` is a platform seed the shell always installs; no other
 * module is required. Everything, the stylesheet included, lives inside the
 * factory closure because executing the bundle only registers it — the body
 * runs when the module is first materialized. A throwing component would blank
 * its slot entry, so the panel is plain `React.createElement` with no JSX and
 * no imports.
 *
 * ## Rendering rules it follows
 *
 * The panel matches the shell: Schedule-page geometry, pill tabs, flat
 * hover-tinted rows, theme tokens for every chrome color, the host locale
 * service for every visible string, `ctx.effect` cleanup for styles, and the
 * `prefers-reduced-motion` opt-out. Nothing is appended to the document outside
 * the injected stylesheet, and nothing polls in the background while its tab is
 * not visible.
 *
 * @module dsh-mac-tools/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-mac-tools',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** This package's name: the locale namespace and the slot ids' owner. */
    const NS = 'dsh-mac-tools'
    /** The panel id, shared by the rail entry, the `main` slot key and `layout`. */
    const PANEL_ID = 'mac-tools'
    /** The exact Fetch route the Host half publishes for this panel. */
    const API_PATH = '/api/dsh-mac-tools'

    /** The tab order used by the tablist and its arrow-key navigation. */
    const TABS = ['screenshot', 'calculator', 'monitor', 'transfer']
    /** How many successful evaluations the calculator remembers. */
    const CALC_HISTORY_LIMIT = 10
    /** How often the transfer tab polls the session state while visible. */
    const TRANSFER_STATUS_POLL_MS = 2000
    /** How often the transfer tab polls its two item lists while visible. */
    const TRANSFER_LIST_POLL_MS = 4000
    /** How often the transfer tab re-renders its local session countdown. */
    const TRANSFER_CLOCK_POLL_MS = 1000
    /** How long one transfer toast stays on screen. */
    const TRANSFER_TOAST_MS = 3000
    /** How many recent screenshots the outbox offers as one-tap sends. */
    const TRANSFER_RECENT_SCREENSHOTS = 6
    /** The data-URL prefix a base64 QR PNG is rendered through. */
    const TRANSFER_QR_PREFIX = 'data:image/png;base64,'
    /** How often the visible status tab polls the Host snapshot. */
    const MONITOR_POLL_MS = 1000
    /** The intervals the status toolbar offers. */
    const MONITOR_INTERVALS = [1000, 2000, 5000]
    /** How often the expanded process ranking refreshes. */
    const MONITOR_PROCESS_POLL_MS = 3000
    /** How many process rows the ranking shows (the Host may return more). */
    const MONITOR_PROCESS_LIMIT = 12
    /** Delay between releasing the fan slider and writing the new target. */
    const MONITOR_FAN_DEBOUNCE_MS = 250
    /** How long the inline kill confirmation stays armed. */
    const MONITOR_KILL_ARM_MS = 3000
    /** How long a saved/tested alert notice stays on screen. */
    const MONITOR_ALERT_NOTICE_MS = 3000
    /** The default fan curve corners, as celsius plus a min..max rpm ratio. */
    const MONITOR_FAN_CURVE_DEFAULT = [
      { celsius: 30, ratio: 0 },
      { celsius: 55, ratio: 0.35 },
      { celsius: 75, ratio: 0.7 },
      { celsius: 95, ratio: 1 },
    ]
    /** The curve editor's fixed temperature domain. */
    const MONITOR_CURVE_MIN_CELSIUS = 20
    const MONITOR_CURVE_MAX_CELSIUS = 110
    /** The curve editor's node budget, per the contract. */
    const MONITOR_CURVE_MIN_POINTS = 2
    const MONITOR_CURVE_MAX_POINTS = 8
    /** The curve editor's SVG viewBox. */
    const MONITOR_CURVE_WIDTH = 320
    const MONITOR_CURVE_HEIGHT = 140
    /**
     * Fixed chart-series colours. Chrome (cards, text, borders) stays on theme
     * tokens; these are series colours, which the contract allows for charts.
     */
    const MONITOR_SERIES_COLORS = {
      cpu: 'var(--dsw-alias-state-business-primary)',
      cpuTemperature: 'var(--dsw-alias-state-business-primary)',
      cpuUser: 'var(--dsw-alias-state-business-primary)',
      cpuSystem: 'var(--dsw-alias-state-warn-primary)',
      cpuIdle: 'var(--dsw-alias-state-idle-primary)',
      networkDown: 'var(--dsw-alias-state-business-primary)',
      networkUp: '#ff9f0a',
      memoryApp: 'var(--dsw-alias-state-business-primary)',
      memoryWired: 'var(--dsw-alias-brand-primary)',
      memoryCompressed: 'var(--dsw-alias-state-warn-primary)',
      memoryCached: 'var(--dsw-alias-state-success-primary)',
      memoryFree: 'var(--dsw-alias-bg-layer-3)',
    }
    /** Non-null temperature groups, in display order. */
    const MONITOR_SENSOR_GROUPS = [
      ['cpuPerformance', 'monitor.sensors.group.cpuPerformance'],
      ['cpuEfficiency', 'monitor.sensors.group.cpuEfficiency'],
      ['gpu', 'monitor.sensors.group.gpu'],
      ['ssd', 'monitor.sensors.group.ssd'],
      ['memory', 'monitor.sensors.group.memory'],
      ['wifi', 'monitor.sensors.group.wifi'],
      ['battery', 'monitor.sensors.group.battery'],
      ['ambient', 'monitor.sensors.group.ambient'],
    ]
    /** Sensor group id -> locale key, so option lists can be localized. */
    const MONITOR_SENSOR_GROUP_KEYS = {
      cpuPerformance: 'monitor.sensors.group.cpuPerformance',
      cpuEfficiency: 'monitor.sensors.group.cpuEfficiency',
      gpu: 'monitor.sensors.group.gpu',
      ssd: 'monitor.sensors.group.ssd',
      memory: 'monitor.sensors.group.memory',
      wifi: 'monitor.sensors.group.wifi',
      battery: 'monitor.sensors.group.battery',
      ambient: 'monitor.sensors.group.ambient',
    }
    /** SMC sensor availability reason -> locale key. */
    const MONITOR_SENSOR_REASON_KEYS = {
      'swift-missing': 'monitor.sensors.reason.swift-missing',
      'smc-unavailable': 'monitor.sensors.reason.smc-unavailable',
      'compile-failed': 'monitor.sensors.reason.compile-failed',
      'unsupported-platform': 'monitor.sensors.reason.unsupported-platform',
      starting: 'monitor.sensors.reason.starting',
    }
    /** Fan-control state reason -> locale key. */
    const MONITOR_FAN_REASON_KEYS = {
      'swift-missing': 'monitor.fan.reason.swift-missing',
      'no-fans': 'monitor.fan.reason.no-fans',
      'unsupported-platform': 'monitor.fan.reason.unsupported-platform',
      'install-failed': 'monitor.fan.reason.install-failed',
      cancelled: 'monitor.fan.reason.cancelled',
      'daemon-unreachable': 'monitor.fan.reason.daemon-unreachable',
      'not-installed': 'monitor.fan.reason.not-installed',
    }
    /** The capability rows of the merged 系统信息 section, in display order. */
    const MONITOR_SYSTEM_CAPABILITIES = [
      ['screenshot', 'monitor.system.capability.screenshot'],
      ['hideApp', 'monitor.system.capability.hideApp'],
      ['pin', 'monitor.system.capability.pin'],
      ['history', 'monitor.system.capability.history'],
      ['transfer', 'monitor.system.capability.transfer'],
      ['monitor', 'monitor.system.capability.monitor'],
      ['fanControl', 'monitor.system.capability.fanControl'],
    ]
    /** Alert event metric -> locale key. */
    const MONITOR_ALERT_METRIC_KEYS = {
      cpu: 'monitor.alerts.metric.cpu',
      temperature: 'monitor.alerts.metric.temperature',
      memory: 'monitor.alerts.metric.memory',
    }
    /** Fan mode -> locale key. */
    const MONITOR_FAN_MODE_KEYS = {
      auto: 'monitor.fan.mode.auto',
      manual: 'monitor.fan.mode.manual',
      curve: 'monitor.fan.mode.curve',
    }
    /** Per-fan SMC mode -> locale key. */
    const MONITOR_FAN_ITEM_MODE_KEYS = {
      auto: 'monitor.fan.fanState.auto',
      forced: 'monitor.fan.fanState.forced',
      unknown: 'monitor.fan.fanState.unknown',
    }
    /** The built-in preset ids, localized through `monitor.fan.preset.<id>`. */
    const MONITOR_BUILTIN_PRESETS = ['auto', 'quiet', 'balanced', 'performance', 'max']

    const zh = {
      'panel': 'Mac 工具箱',
      'title': 'Mac 工具箱',
      'subtitle': '截图与标注、计算器、运行状态监控、手机互传 —— 全部在本机完成。',
      'hostAria': 'Host 连接状态',
      'host.loading': '正在连接本地 Host…',
      'host.ready': 'Host 已连接 · v{version}',
      'host.readyHint': '保存目录：{directory}',
      'host.missing': 'Host 半端未发布（HTTP {status}）',
      'host.missingHint': '请重启 DeepSeek Harness 后再试。',
      'host.unreachable': '无法访问 Host 半端：{message}',
      'host.retry': '重新连接',
      'tabs.aria': 'Mac 工具箱分区',
      'tab.screenshot': '截图',
      'tab.calculator': '计算器',
      'tab.transfer': '手机互传',
      'common.close': '关闭',
      'common.retry': '重试',
      'common.cancel': '取消',
      'common.dismiss': '知道了',
      'capture.primary': '区域 / 窗口截图',
      'capture.full': '全屏截图',
      'capture.delayed': '3 秒后全屏',
      'capture.window': '窗口截图',
      'capture.windows': '选择应用窗口',
      'capture.windowsHide': '收起窗口列表',
      'capture.hideApp': '截图时隐藏 DSH',
      'capture.hideAppAria': '屏幕截图时隐藏 DeepSeek Harness 窗口，避免它挡住要截取的内容；截图完成后自动恢复',
      'capture.hideAppUnavailable': '当前没有运行在 DeepSeek Harness 桌面应用窗口中，无法隐藏宿主窗口',
      'capture.hint.hidden': '已隐藏 DeepSeek Harness 窗口，正在选择截图区域…',
      'capture.hotkeyActive': '全局截图快捷键 {accelerator}：在任意应用里按下即可框选，截图会自动复制到剪贴板并保存',
      'capture.hotkeyUnavailable': '全局截图快捷键暂不可用（首次使用需要 Xcode Command Line Tools 编译原生组件）',
      'capture.hotkeyRow': '全局截图快捷键',
      'capture.hotkeyRecord': '修改',
      'capture.hotkeyReset': '恢复默认',
      'capture.hotkeyRecording': '请按下新的组合键…（Esc 取消）',
      'capture.hotkeySaving': '正在保存…',
      'capture.hotkeyCustom': '自定义',
      'capture.hotkeyDefault': '默认',
      'capture.hotkeyInvalid': '快捷键需要至少一个 ⌃/⌥/⌘ 加一个按键，例如 ⌃⌥A',
      'capture.hotkeyError': '更新快捷键失败：{message}',
      'capture.hotkeyInAppHint': '面板内的快速截图快捷键可在「设置 → 快捷键」中修改',
      'history.title': '历史截图',
      'history.count': '共 {count} 张',
      'history.empty': '还没有历史截图。每次截图（包括 ⌥A 全局截图）都会自动保存在这里。',
      'history.refresh': '刷新',
      'history.clear': '清空',
      'history.clearConfirm': '确认清空？',
      'history.delete': '删除',
      'history.edit': '编辑',
      'history.pin': '贴图',
      'history.copy': '复制',
      'history.openAria': '在编辑器中打开这张截图',
      'history.error': '无法读取历史截图：{message}',
      'capture.hint.interactive': '请拖拽选择区域…（按空格切换为窗口，Esc 取消）',
      'capture.hint.region': '请拖拽选择区域…（Esc 取消）',
      'capture.hint.window': '请点击一个窗口…（Esc 取消）',
      'capture.hint.default': '正在截图…（Esc 取消）',
      'capture.cancel': '取消截图',
      'capture.cancelling': '正在取消…',
      'capture.empty': '还没有截图',
      'capture.emptyHint': '点击「区域 / 窗口截图」开始，或使用快速截图快捷键在任意页面直接框选。',
      'capture.leading': '正在唤起系统截图…',
      'mode.interactive': '区域选择',
      'mode.interactive-region': '区域选择',
      'mode.interactive-window': '窗口选择',
      'mode.full': '全屏',
      'mode.display': '显示器 {display}',
      'mode.window': '窗口',
      'mode.app': '应用窗口',
      'mode.frontmost': '前台窗口',
      'mode.rect': '区域',
      'mode.unknown': '截图',
      'capture.error.busy': '截图工具正忙，请稍候再试。',
      'capture.error.no_window': '没有找到可截图的窗口。',
      'capture.error.permission': '缺少屏幕录制权限：请在「系统设置 › 隐私与安全性 › 屏幕录制」中允许 DeepSeek Harness 后重启。',
      'capture.error.timeout': '等待选择超时，截图已取消。',
      'capture.error.capture_failed': '截图失败：{message}',
      'capture.error.generic': '截图失败（{code}）：{message}',
      'capture.error.invalid_request': '截图参数无效，请重试。',
      'windows.title': '应用窗口',
      'windows.filter': '按应用或标题筛选',
      'windows.refresh': '刷新窗口列表',
      'windows.loading': '正在读取窗口列表…',
      'windows.empty': '没有可见的应用窗口',
      'windows.emptyHint': '请先打开一个有窗口的应用，然后刷新。',
      'windows.error': '无法读取窗口列表：{message}',
      'windows.frontmost': '前台',
      'windows.count': '{count} 个窗口',
      'windows.close': '收起',
      'windows.captureAria': '截取「{app}」窗口',
      'windows.hint': '列表按前后顺序排列，点击任意窗口即可截取。',
      'editor.meta': '{width} × {height} px · {mode}',
      'editor.captureFrom': '截取自 {app} · {title}',
      'editor.capturedAt': '截取于 {time}',
      'editor.loading': '正在载入截图…',
      'editor.loadError': '无法载入截图：{message}',
      'editor.canvasAria': '截图标注画布',
      'editor.toolbarAria': '标注工具',
      'editor.undo': '撤销',
      'editor.redo': '重做',
      'editor.reset': '还原',
      'editor.copy': '复制',
      'editor.copying': '正在复制…',
      'editor.save': '保存',
      'editor.saving': '正在保存…',
      'editor.close': '关闭截图',
      'editor.copied': '已复制到剪贴板',
      'editor.saved': '已保存到 {path}',
      'editor.pin': '贴图',
      'editor.pinning': '正在贴图…',
      'editor.pinned': '已贴到屏幕上：拖动移动，滚轮缩放，右键菜单可复制 / 保存 / 透明度 / 关闭',
      'editor.reveal': '在 Finder 中显示',
      'editor.revealFailed': '无法在 Finder 中显示：{message}',
      'editor.error': '操作失败：{message}',
      'editor.error.tooLarge': '图片太大，Host 拒绝接收（上限 {megabytes} MB）。',
      'editor.error.saveFailed': '保存失败：{message}',
      'editor.error.notFound': '找不到该文件或截图。',
      'editor.error.outdated': 'Host 不支持这个操作，请更新插件或重启 DeepSeek Harness。',
      'editor.cropApply': '应用裁剪',
      'editor.cropCancel': '取消裁剪',
      'editor.cropHint': '拖拽选择要保留的区域；Enter 应用，Esc 取消。应用裁剪会合并当前标注并清空撤销记录。',
      'editor.cropSize': '{width} × {height} px',
      'editor.keyboardHint': 'Cmd/Ctrl+Z 撤销 · Shift+Cmd/Ctrl+Z 重做 · Enter 应用裁剪 · Esc 取消裁剪或关闭截图',
      'editor.textPlaceholder': '输入文字…',
      'editor.textHint': 'Enter 确认，Esc 取消',
      'editor.colorAria': '标注颜色',
      'editor.widthAria': '线条粗细',
      'tool.crop': '裁剪',
      'tool.arrow': '箭头',
      'tool.rect': '矩形',
      'tool.ellipse': '椭圆',
      'tool.pen': '画笔',
      'tool.text': '文字',
      'tool.mosaic': '马赛克',
      'tool.highlight': '高亮',
      'color.red': '红色',
      'color.orange': '橙色',
      'color.blue': '蓝色',
      'color.green': '绿色',
      'color.white': '白色',
      'color.black': '黑色',
      'width.thin': '细',
      'width.medium': '中',
      'width.thick': '粗',
      'calc.expressionAria': '计算器表达式',
      'calc.placeholder': '0',
      'calc.result': '结果',
      'calc.emptyResult': '—',
      'calc.history': '历史记录',
      'calc.historyEmpty': '还没有计算记录',
      'calc.historyHint': '点击一条记录可重新载入表达式。',
      'calc.hint': '支持四则运算、括号、幂和常用函数；角度按度计算。',
      'calc.angles': '角度制',
      'calc.keypad': '计算器键盘',
      'calc.evaluating': '计算中…',
      'calc.evaluate': '计算',
      'calc.clear': '清空',
      'calc.backspace': '退格',
      'calc.key.clear': '清空表达式',
      'calc.key.backspace': '退格',
      'calc.key.plusMinus': '改变正负号',
      'calc.key.sqrt': '平方根',
      'calc.key.square': '平方',
      'calc.key.pi': '圆周率',
      'calc.key.percent': '百分比',
      'calc.key.equals': '等于',
      'calc.error.invalid_expression': '表达式不完整或有误。',
      'calc.error.unknown_identifier': '无法识别的名称：{message}',
      'calc.error.unknown_function': '无法识别的函数：{message}',
      'calc.error.divide_by_zero': '不能除以零。',
      'calc.error.domain_error': '函数定义域错误：{message}',
      'calc.error.too_long': '表达式过长。',
      'calc.error.generic': '计算失败：{message}',
      'system.os': '系统',
      'system.uptime': '运行时间',
      'system.hostname': '主机名',
      'system.arch': '架构',
      'system.version': '版本',
      'system.cores': '{count} 核',
      'system.model': '型号标识',
      'system.coresLabel': '核心数',
      'system.uptimeValue': '已运行 {duration}',
      'system.available': '可用',
      'system.unavailable': '不可用',
      'system.saveDirectory': '保存目录',
      'system.capturedAt': '取样于 {time}',
      'system.unknown': '未知',
      'duration.day': '{n} 天',
      'duration.hour': '{n} 小时',
      'duration.minute': '{n} 分',
      'duration.second': '{n} 秒',
      'shortcut.toggle': '打开或关闭 Mac 工具箱',
      'shortcut.screenshot': '快速截图（区域 / 窗口）',
      'transfer.title': '手机互传',
      'transfer.subtitle': '在同一个 Wi-Fi 下，用手机扫码打开网页，双向发送文本、文件和截图。',
      'transfer.start': '开启手机互传',
      'transfer.starting': '正在开启…',
      'transfer.stop': '停止互传',
      'transfer.stopping': '正在停止…',
      'transfer.loading': '正在读取互传状态…',
      'transfer.refresh': '刷新',
      'transfer.active': '互传进行中',
      'transfer.qrAlt': '手机扫码打开互传页面的二维码',
      'transfer.qrFallback': '二维码不可用',
      'transfer.qrError': '二维码生成失败：{message}',
      'transfer.urlLabel': '手机访问地址',
      'transfer.copyUrl': '复制链接',
      'transfer.urlCopied': '已复制链接',
      'transfer.copyFailed': '复制失败：{message}',
      'transfer.clipboardUnavailable': '剪贴板不可用',
      'transfer.urlsTitle': '局域网地址',
      'transfer.remaining': '剩余 {duration}',
      'transfer.expired': '已过期',
      'transfer.wifiHint': '手机需要与这台 Mac 连接同一个 Wi-Fi；如果手机打不开页面，请检查 macOS 防火墙是否放行。',
      'transfer.directory': '接收目录：{directory}',
      'transfer.sessionMinutes': '会话时长 {minutes} 分钟',
      'transfer.maxFile': '单个文件上限 {megabytes} MB',
      'transfer.inbox.title': '手机发来的内容',
      'transfer.inbox.count': '{count} 项',
      'transfer.inbox.empty': '还没有收到内容。用手机扫码打开网页后，即可发送文本、文件或照片。',
      'transfer.inbox.error': '无法读取收件箱：{message}',
      'transfer.inbox.loading': '正在读取收件箱…',
      'transfer.inbox.clear': '清空',
      'transfer.inbox.clearConfirm': '确认清空？',
      'transfer.inbox.copy': '复制',
      'transfer.inbox.reveal': '在 Finder 中显示',
      'transfer.inbox.delete': '删除',
      'transfer.inbox.previewAlt': '手机发来的图片',
      'transfer.outbox.title': '发送到手机',
      'transfer.outbox.count': '{count} 项',
      'transfer.outbox.empty': '还没有要发送的内容。发送文本、文件或最近截图后，手机会自动出现。',
      'transfer.outbox.error': '无法读取发件箱：{message}',
      'transfer.outbox.loading': '正在读取发件箱…',
      'transfer.outbox.clear': '清空',
      'transfer.outbox.clearConfirm': '确认清空？',
      'transfer.outbox.remove': '移除',
      'transfer.outbox.textPlaceholder': '输入要发送到手机的文本…（⌘/Ctrl+Enter 发送）',
      'transfer.outbox.send': '发送',
      'transfer.outbox.sending': '发送中…',
      'transfer.outbox.chooseFile': '选择文件…',
      'transfer.outbox.choosingFile': '正在选择…',
      'transfer.outbox.recent': '最近截图',
      'transfer.outbox.recentEmpty': '还没有历史截图。',
      'transfer.outbox.sendHistory': '发送到手机',
      'transfer.kind.text': '文本',
      'transfer.kind.file': '文件',
      'transfer.kind.history': '截图',
      'transfer.toast.failed': '操作失败',
      'transfer.toast.sent': '已发送到手机',
      'transfer.toast.copied': '已复制文本',
      'transfer.toast.revealed': '已在 Finder 中显示',
      'transfer.toast.deleted': '已删除',
      'transfer.toast.cleared': '已清空',
      'transfer.toast.removed': '已移除',
      'transfer.toast.fileAdded': '已添加到发件箱',
      'transfer.toast.filesAdded': '已添加 {count} 个文件',
      'transfer.error.unsupported': '当前版本不支持手机互传。',
      'transfer.error.not_found': '条目不存在或文件已被移动。',
      'transfer.error.invalid_request': '请求无效，请重试。',
      'transfer.error.too_large': '内容超出大小上限。',
      'transfer.error.io_error': '读写失败：{message}',
      'transfer.error.port_unavailable': '端口被占用，无法开启互传，请稍后重试。',
      'transfer.error.not_active': '手机互传尚未开启。',
      'transfer.error.generic': '互传失败（{code}）：{message}',
      'tab.monitor': '运行状态',
      'monitor.toolbarAria': '运行状态工具栏',
      'monitor.sampledAt': '取样于 {time}',
      'monitor.paused': '已暂停',
      'monitor.pause': '暂停',
      'monitor.resume': '继续',
      'monitor.refresh': '刷新',
      'monitor.intervalAria': '刷新间隔',
      'monitor.interval.option': '{n} 秒',
      'monitor.loading': '正在读取运行状态…',
      'monitor.error.generic': '无法读取运行状态：{message}',
      'monitor.unsupported.title': '当前平台不支持运行状态',
      'monitor.unsupported.hint': '运行状态面板需要 macOS；当前 Host 报告的运行平台是 {platform}。',
      'monitor.badgesAria': '监控能力',
      'monitor.badge.sensors': '温度传感器',
      'monitor.badge.fans': '风扇控制',
      'monitor.badge.battery': '电池',
      'monitor.available': '可用',
      'monitor.unavailable': '不可用',
      'monitor.unknown': '未知',
      'monitor.separator': '、',
      'monitor.cpu.title': 'CPU',
      'monitor.cpu.cores': '{count} 核',
      'monitor.cpu.temperature': '温度',
      'monitor.cpu.noTemperature': 'SMC 温度不可用',
      'monitor.cpu.user': '用户',
      'monitor.cpu.system': '系统',
      'monitor.cpu.idle': '闲置',
      'monitor.cpu.loadAverage': '负载 {load}',
      'monitor.cpu.perCore': '每核心占用',
      'monitor.cpu.coreAria': '核心 {index}：{value}%',
      'monitor.memory.title': '内存',
      'monitor.memory.available': '可用 {available} / 共 {total}',
      'monitor.memory.usedPercent': '已用 {percent}%',
      'monitor.memory.breakdown': '内存构成',
      'monitor.memory.app': '应用',
      'monitor.memory.wired': '联动',
      'monitor.memory.compressed': '压缩',
      'monitor.memory.cached': '缓存',
      'monitor.memory.free': '空闲',
      'monitor.memory.swap': '交换分区 {size}',
      'monitor.memory.pressure': '内存压力',
      'monitor.memory.pressure.normal': '正常',
      'monitor.memory.pressure.warning': '偏高',
      'monitor.memory.pressure.critical': '紧张',
      'monitor.memory.pressure.unknown': '未知',
      'monitor.disk.title': '磁盘',
      'monitor.disk.available': '可用 {available} / 共 {total}',
      'monitor.disk.usedPercent': '已用 {percent}%',
      'monitor.disk.mount': '挂载于 {mount}',
      'monitor.network.title': '网络',
      'monitor.network.interface': '接口 {name}',
      'monitor.network.ip': '本地 IP',
      'monitor.network.down': '下载',
      'monitor.network.up': '上传',
      'monitor.network.total': '累计 ↓ {down} · ↑ {up}',
      'monitor.network.none': '未连接',
      'monitor.battery.title': '电池',
      'monitor.battery.level': '电量 {percent}%',
      'monitor.battery.charging': '正在充电',
      'monitor.battery.charged': '已充满',
      'monitor.battery.discharging': '使用电池',
      'monitor.battery.remaining': '剩余 {duration}',
      'monitor.battery.remainingUnknown': '剩余时间未知',
      'monitor.battery.health': '健康度 {percent}%',
      'monitor.battery.cycles': '循环 {count} 次',
      'monitor.footer.uptime': '已运行 {duration}',
      'monitor.footer.host': '{model} · {hostname}',
      'monitor.footer.os': '{os} {version}',
      'monitor.sensors.title': '温度传感器',
      'monitor.sensors.showAll': '全部传感器',
      'monitor.sensors.hideAll': '收起传感器',
      'monitor.sensors.count': '{count} 个读数',
      'monitor.sensors.empty': '没有可用的温度读数',
      'monitor.sensors.reason.swift-missing': '缺少 swiftc（Xcode Command Line Tools），无法读取 SMC 传感器。',
      'monitor.sensors.reason.smc-unavailable': '无法打开 AppleSMC，温度读数不可用。',
      'monitor.sensors.reason.compile-failed': '原生采样器编译失败，温度读数不可用。',
      'monitor.sensors.reason.unsupported-platform': '当前平台不支持 SMC 温度传感器。',
      'monitor.sensors.reason.starting': '温度传感器正在初始化，请稍候…',
      'monitor.sensors.reason.generic': '温度传感器不可用：{reason}',
      'monitor.sensors.group.cpuPerformance': 'CPU 性能核',
      'monitor.sensors.group.cpuEfficiency': 'CPU 能效核',
      'monitor.sensors.group.gpu': 'GPU',
      'monitor.sensors.group.ssd': 'SSD',
      'monitor.sensors.group.memory': '内存',
      'monitor.sensors.group.wifi': 'Wi-Fi',
      'monitor.sensors.group.battery': '电池',
      'monitor.sensors.group.ambient': '环境',
      'monitor.sensors.summaryAria': '温度分组摘要',
      'monitor.sensors.familyCount': '{count} 个',
      'monitor.sensors.readingAria': '{key} 温度 {value}',
      'monitor.fan.title': '风扇控制',
      'monitor.fan.installing': '正在安装风扇控制组件…',
      'monitor.fan.enable': '启用风扇控制',
      'monitor.fan.enabling': '正在等待管理员授权…',
      'monitor.fan.install.intro': '风扇转速写入需要管理员权限。启用后会安装一个仅用于写入风扇转速的特权组件：',
      'monitor.fan.install.helper': 'root 特权助手位于「/Library/Application Support/DSH Mac Tools/」。',
      'monitor.fan.install.daemon': '一个 LaunchDaemon 在后台启动该助手，只把风扇转速写入 SMC，不采集或上传任何数据。',
      'monitor.fan.install.prompt': 'macOS 只会要求输入一次管理员密码；组件可以随时在本面板中卸载。',
      'monitor.fan.notInstalledTitle': '风扇控制尚未启用',
      'monitor.fan.errorTitle': '风扇控制出错',
      'monitor.fan.uninstall': '卸载风扇控制',
      'monitor.fan.uninstallConfirm': '确认卸载？风扇将立即恢复系统自动控制。',
      'monitor.fan.uninstalling': '正在卸载…',
      'monitor.fan.uninstallHint': '卸载会删除特权助手与 LaunchDaemon，并把风扇交还系统自动控制。',
      'monitor.fan.reinstall': '重新安装',
      'monitor.fan.retry': '重试',
      'monitor.fan.reason.swift-missing': '缺少 swiftc（Xcode Command Line Tools），无法编译风扇控制组件。',
      'monitor.fan.reason.no-fans': '这台 Mac 没有检测到风扇。',
      'monitor.fan.reason.unsupported-platform': '风扇控制仅在 macOS 上可用。',
      'monitor.fan.reason.install-failed': '安装风扇控制组件失败：{message}',
      'monitor.fan.reason.cancelled': '已取消管理员授权，风扇控制未安装。',
      'monitor.fan.reason.daemon-unreachable': '特权守护进程没有响应，请重试或重新安装。',
      'monitor.fan.reason.not-installed': '风扇控制组件尚未安装。',
      'monitor.fan.reason.generic': '风扇控制不可用：{reason}',
      'monitor.fan.error.fan_not_ready': '风扇控制组件未就绪，请重试或重新安装。',
      'monitor.fan.error.fan_apply_failed': '写入风扇转速被拒绝：{message}',
      'monitor.fan.error.generic': '风扇控制失败（{code}）：{message}',
      'monitor.fan.fansAria': '风扇读数',
      'monitor.fan.fanName': '风扇 {index}',
      'monitor.fan.actual': '当前 {rpm}',
      'monitor.fan.target': '目标 {rpm}',
      'monitor.fan.range': '{min}–{max} RPM',
      'monitor.fan.fanState.auto': '系统自动',
      'monitor.fan.fanState.forced': '强制转速',
      'monitor.fan.fanState.unknown': '未知',
      'monitor.fan.mode': '模式',
      'monitor.fan.mode.auto': '自动',
      'monitor.fan.mode.manual': '手动',
      'monitor.fan.mode.curve': '温度曲线',
      'monitor.fan.manual': '手动转速',
      'monitor.fan.manualHint': '松开滑块后写入（约 250 ms 防抖）。',
      'monitor.fan.manualValue': '{rpm} RPM',
      'monitor.fan.holding': '控制保持中 · 目标 {rpm} RPM',
      'monitor.fan.autoHolding': '系统自动控制',
      'monitor.fan.appliedAt': '应用于 {time}',
      'monitor.fan.curve.title': '温度曲线',
      'monitor.fan.curve.sensor': '温度来源',
      'monitor.fan.curve.hint': '拖动节点调整温度和转速；点击空白处添加节点；至少 2 个、最多 8 个节点。',
      'monitor.fan.curve.delete': '删除节点',
      'monitor.fan.curve.reset': '重置曲线',
      'monitor.fan.curve.apply': '应用曲线',
      'monitor.fan.curve.points': '{count} 个节点',
      'monitor.fan.curve.point': '{celsius} °C → {rpm} RPM',
      'monitor.fan.presets': '预设',
      'monitor.fan.preset.auto': '自动',
      'monitor.fan.preset.quiet': '安静',
      'monitor.fan.preset.balanced': '均衡',
      'monitor.fan.preset.performance': '性能',
      'monitor.fan.preset.max': '最大',
      'monitor.fan.preset.custom': '自定义',
      'monitor.fan.preset.save': '保存当前',
      'monitor.fan.preset.saveActive': '保存当前模式为预设',
      'monitor.fan.preset.namePlaceholder': '预设名称',
      'monitor.fan.preset.delete': '删除预设「{name}」',
      'monitor.fan.preset.nameRequired': '请输入预设名称。',
      'monitor.fan.preset.invalid': '自动模式无法保存为预设，请先选择手动或温度曲线。',
      'monitor.fan.preset.saved': '预设已保存',
      'monitor.fan.restoreAuto': '恢复系统自动',
      'monitor.fan.otherControllers': '检测到其他风扇控制软件正在运行：{names}。它们会和本面板争夺风扇控制权。',
      'monitor.fan.pendingApply': '正在应用…',
      'monitor.fan.notReadyHint': '风扇控制组件未就绪，暂时无法读取或写入风扇转速。',
      'monitor.processes.title': '进程排行',
      'monitor.processes.expand': '展开进程排行',
      'monitor.processes.collapse': '收起进程排行',
      'monitor.processes.hint': '按 {sort} 排序 · 每 3 秒刷新',
      'monitor.processes.sortAria': '进程排序方式',
      'monitor.processes.sort.cpu': 'CPU',
      'monitor.processes.sort.memory': '内存',
      'monitor.processes.loading': '正在读取进程列表…',
      'monitor.processes.empty': '没有可显示的进程',
      'monitor.processes.error': '无法读取进程列表：{message}',
      'monitor.processes.pid': 'PID {pid}',
      'monitor.processes.name': '进程',
      'monitor.processes.cpu': 'CPU',
      'monitor.processes.memory': '内存',
      'monitor.processes.rss': '常驻内存',
      'monitor.processes.kill': '结束',
      'monitor.processes.killArmed': '确认结束?',
      'monitor.processes.killAria': '结束进程 {name}（PID {pid}）',
      'monitor.processes.killProtected': '不可结束',
      'monitor.processes.killing': '正在结束…',
      'monitor.processes.error.kill_invalid_pid': '无法结束这个进程（PID 无效或属于 Host 本身）。',
      'monitor.processes.error.kill_not_found': '进程已经退出。',
      'monitor.processes.error.kill_denied': '没有权限结束这个进程。',
      'monitor.processes.error.generic': '操作失败（{code}）：{message}',
      'monitor.alerts.title': '告警',
      'monitor.alerts.enabled': '启用告警',
      'monitor.alerts.cpu': 'CPU 阈值 %',
      'monitor.alerts.temperature': '温度阈值 °C',
      'monitor.alerts.memory': '内存阈值 %',
      'monitor.alerts.cooldown': '冷却时间（秒）',
      'monitor.alerts.notify': '发送系统通知',
      'monitor.alerts.save': '保存',
      'monitor.alerts.saving': '正在保存…',
      'monitor.alerts.saved': '已保存',
      'monitor.alerts.test': '测试通知',
      'monitor.alerts.testing': '正在发送…',
      'monitor.alerts.testSent': '测试通知已发送',
      'monitor.alerts.testUnavailable': '此系统不支持通知',
      'monitor.alerts.testFailed': '测试通知失败：{message}',
      'monitor.alerts.events': '最近的告警',
      'monitor.alerts.eventsEmpty': '还没有触发过告警',
      'monitor.alerts.eventRow': '达到 {value}（阈值 {threshold}）',
      'monitor.alerts.metric.cpu': 'CPU 占用',
      'monitor.alerts.metric.temperature': '温度',
      'monitor.alerts.metric.memory': '内存占用',
      'monitor.alerts.metric.unknown': '指标',
      'monitor.alerts.cooldownHint': '同一指标在冷却时间内只提醒一次。',
      'monitor.alerts.hint': '阈值由 Host 实时评估；触发后显示 macOS 通知（需要通知权限）。',
      'monitor.alerts.temperatureUnavailable': '温度传感器不可用，温度告警暂时停用。',
      'monitor.alerts.error.invalid': '请输入有效范围内的数值。',
      'monitor.alerts.error.generic': '告警操作失败（{code}）：{message}',
      'monitor.alerts.unavailable': '告警设置不可用',
      'monitor.system.title': '系统信息',
      'monitor.system.hardware': '系统与硬件',
      'monitor.system.runtime': '运行时',
      'monitor.system.capabilities': '能力',
      'monitor.system.chip': '芯片',
      'monitor.system.coresDetail': '{count}（{performance} 性能 + {efficiency} 能效）',
      'monitor.system.hostPid': 'Host 进程 ID',
      'monitor.system.sampledAt': '取样时间',
      'monitor.system.interval': '采样间隔',
      'monitor.system.polling': '轮询状态',
      'monitor.system.pollingActive': '轮询中',
      'monitor.system.capability.screenshot': '截图',
      'monitor.system.capability.hideApp': '截图时隐藏应用',
      'monitor.system.capability.pin': '贴图窗口',
      'monitor.system.capability.history': '截图历史',
      'monitor.system.capability.transfer': '手机互传',
      'monitor.system.capability.monitor': '运行状态监控',
      'monitor.system.capability.fanControl': '风扇控制',
      'monitor.system.note': '内存、磁盘、电池、CPU 与网络数据可在上方概览卡片中查看。',
    }

    const en = {
      'panel': 'Mac Tools',
      'title': 'Mac Tools',
      'subtitle': 'Screenshots and annotations, a calculator, live status monitoring and phone transfer — all local.',
      'hostAria': 'Host connection status',
      'host.loading': 'Connecting to the local Host…',
      'host.ready': 'Host connected · v{version}',
      'host.readyHint': 'Save folder: {directory}',
      'host.missing': 'The Host half is not published (HTTP {status})',
      'host.missingHint': 'Restart DeepSeek Harness and try again.',
      'host.unreachable': 'Cannot reach the Host half: {message}',
      'host.retry': 'Reconnect',
      'tabs.aria': 'Mac Tools sections',
      'tab.screenshot': 'Screenshot',
      'tab.calculator': 'Calculator',
      'tab.transfer': 'Phone',
      'common.close': 'Close',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.dismiss': 'Dismiss',
      'capture.primary': 'Region / window capture',
      'capture.full': 'Full screen',
      'capture.delayed': 'Full screen in 3 s',
      'capture.window': 'Window capture',
      'capture.windows': 'Pick an app window',
      'capture.windowsHide': 'Hide the window list',
      'capture.hideApp': 'Hide DSH while capturing',
      'capture.hideAppAria': 'Hide the DeepSeek Harness window during a screen capture so it does not cover the target; it is restored afterwards',
      'capture.hideAppUnavailable': 'Not running inside the DeepSeek Harness desktop window, so there is no host window to hide',
      'capture.hint.hidden': 'DeepSeek Harness window hidden — pick the area to capture…',
      'capture.hotkeyActive': 'Global shortcut {accelerator}: press it in any app to select a region; the screenshot is copied to the clipboard and saved',
      'capture.hotkeyUnavailable': 'The global screenshot shortcut is unavailable (its native helper needs the Xcode Command Line Tools on first use)',
      'capture.hotkeyRow': 'Global screenshot shortcut',
      'capture.hotkeyRecord': 'Change',
      'capture.hotkeyReset': 'Reset to default',
      'capture.hotkeyRecording': 'Press the new combination… (Esc cancels)',
      'capture.hotkeySaving': 'Saving…',
      'capture.hotkeyCustom': 'Custom',
      'capture.hotkeyDefault': 'Default',
      'capture.hotkeyInvalid': 'Use at least ⌃/⌥/⌘ plus one key, e.g. ⌃⌥A',
      'capture.hotkeyError': 'Could not change the shortcut: {message}',
      'capture.hotkeyInAppHint': 'The in-panel quick-capture shortcut can be changed under Settings → Shortcuts',
      'history.title': 'Screenshot history',
      'history.count': '{count} saved',
      'history.empty': 'No screenshots yet. Every capture (including the ⌥A global shortcut) is saved here automatically.',
      'history.refresh': 'Refresh',
      'history.clear': 'Clear',
      'history.clearConfirm': 'Confirm clear?',
      'history.delete': 'Delete',
      'history.edit': 'Edit',
      'history.pin': 'Pin',
      'history.copy': 'Copy',
      'history.openAria': 'Open this screenshot in the editor',
      'history.error': 'Could not read the screenshot history: {message}',
      'capture.hint.interactive': 'Drag to select a region… (Space switches to window, Esc cancels)',
      'capture.hint.region': 'Drag to select a region… (Esc cancels)',
      'capture.hint.window': 'Click a window… (Esc cancels)',
      'capture.hint.default': 'Capturing… (Esc cancels)',
      'capture.cancel': 'Cancel capture',
      'capture.cancelling': 'Cancelling…',
      'capture.empty': 'No capture yet',
      'capture.emptyHint': 'Click “Region / window capture” to start, or press the quick-capture shortcut on any page.',
      'capture.leading': 'Opening the system capture…',
      'mode.interactive': 'Region selection',
      'mode.interactive-region': 'Region selection',
      'mode.interactive-window': 'Window selection',
      'mode.full': 'Full screen',
      'mode.display': 'Display {display}',
      'mode.window': 'Window',
      'mode.app': 'App window',
      'mode.frontmost': 'Frontmost window',
      'mode.rect': 'Region',
      'mode.unknown': 'Capture',
      'capture.error.busy': 'The capture tool is busy; try again in a moment.',
      'capture.error.no_window': 'No capturable window was found.',
      'capture.error.permission': 'Screen Recording permission is missing. Allow DeepSeek Harness in System Settings › Privacy & Security › Screen Recording, then restart.',
      'capture.error.timeout': 'The selection timed out and the capture was cancelled.',
      'capture.error.capture_failed': 'Capture failed: {message}',
      'capture.error.generic': 'Capture failed ({code}): {message}',
      'capture.error.invalid_request': 'The capture request was invalid; try again.',
      'windows.title': 'App windows',
      'windows.filter': 'Filter by app or title',
      'windows.refresh': 'Refresh the window list',
      'windows.loading': 'Reading the window list…',
      'windows.empty': 'No visible app windows',
      'windows.emptyHint': 'Open an app with a window, then refresh.',
      'windows.error': 'Cannot read the window list: {message}',
      'windows.frontmost': 'Front',
      'windows.count': '{count} windows',
      'windows.close': 'Hide',
      'windows.captureAria': 'Capture the “{app}” window',
      'windows.hint': 'Sorted front to back; click a window to capture it.',
      'editor.meta': '{width} × {height} px · {mode}',
      'editor.captureFrom': 'Captured from {app} · {title}',
      'editor.capturedAt': 'Captured {time}',
      'editor.loading': 'Loading the capture…',
      'editor.loadError': 'Cannot load the capture: {message}',
      'editor.canvasAria': 'Screenshot annotation canvas',
      'editor.toolbarAria': 'Annotation tools',
      'editor.undo': 'Undo',
      'editor.redo': 'Redo',
      'editor.reset': 'Reset',
      'editor.copy': 'Copy',
      'editor.copying': 'Copying…',
      'editor.save': 'Save',
      'editor.saving': 'Saving…',
      'editor.close': 'Close the capture',
      'editor.copied': 'Copied to the clipboard',
      'editor.saved': 'Saved to {path}',
      'editor.pin': 'Pin',
      'editor.pinning': 'Pinning…',
      'editor.pinned': 'Pinned to the screen — drag to move, scroll to zoom, right-click for copy / save / opacity / close',
      'editor.reveal': 'Show in Finder',
      'editor.revealFailed': 'Cannot show it in Finder: {message}',
      'editor.error': 'The action failed: {message}',
      'editor.error.tooLarge': 'The image is too large for the Host (limit {megabytes} MB).',
      'editor.error.saveFailed': 'Saving failed: {message}',
      'editor.error.notFound': 'That file or shot was not found.',
      'editor.error.outdated': 'The Host does not support this action; update the plugin or restart DeepSeek Harness.',
      'editor.cropApply': 'Apply crop',
      'editor.cropCancel': 'Cancel crop',
      'editor.cropHint': 'Drag to choose the area to keep; Enter applies, Esc cancels. Applying flattens the annotations and clears undo history.',
      'editor.cropSize': '{width} × {height} px',
      'editor.keyboardHint': 'Cmd/Ctrl+Z undo · Shift+Cmd/Ctrl+Z redo · Enter applies the crop · Esc cancels the crop or closes the capture',
      'editor.textPlaceholder': 'Type text…',
      'editor.textHint': 'Enter to commit, Esc to cancel',
      'editor.colorAria': 'Annotation color',
      'editor.widthAria': 'Stroke width',
      'tool.crop': 'Crop',
      'tool.arrow': 'Arrow',
      'tool.rect': 'Rectangle',
      'tool.ellipse': 'Ellipse',
      'tool.pen': 'Pen',
      'tool.text': 'Text',
      'tool.mosaic': 'Mosaic',
      'tool.highlight': 'Highlight',
      'color.red': 'Red',
      'color.orange': 'Orange',
      'color.blue': 'Blue',
      'color.green': 'Green',
      'color.white': 'White',
      'color.black': 'Black',
      'width.thin': 'Thin',
      'width.medium': 'Medium',
      'width.thick': 'Thick',
      'calc.expressionAria': 'Calculator expression',
      'calc.placeholder': '0',
      'calc.result': 'Result',
      'calc.emptyResult': '—',
      'calc.history': 'History',
      'calc.historyEmpty': 'No evaluations yet',
      'calc.historyHint': 'Click an entry to load its expression again.',
      'calc.hint': 'Arithmetic, parentheses, powers and common functions; angles are in degrees.',
      'calc.angles': 'Degrees',
      'calc.keypad': 'Calculator keypad',
      'calc.evaluating': 'Evaluating…',
      'calc.evaluate': 'Evaluate',
      'calc.clear': 'Clear',
      'calc.backspace': 'Backspace',
      'calc.key.clear': 'Clear the expression',
      'calc.key.backspace': 'Backspace',
      'calc.key.plusMinus': 'Toggle the sign',
      'calc.key.sqrt': 'Square root',
      'calc.key.square': 'Square',
      'calc.key.pi': 'Pi',
      'calc.key.percent': 'Percent',
      'calc.key.equals': 'Equals',
      'calc.error.invalid_expression': 'The expression is incomplete or malformed.',
      'calc.error.unknown_identifier': 'Unknown name: {message}',
      'calc.error.unknown_function': 'Unknown function: {message}',
      'calc.error.divide_by_zero': 'Division by zero.',
      'calc.error.domain_error': 'Domain error: {message}',
      'calc.error.too_long': 'The expression is too long.',
      'calc.error.generic': 'Evaluation failed: {message}',
      'system.os': 'System',
      'system.uptime': 'Uptime',
      'system.hostname': 'Hostname',
      'system.arch': 'Architecture',
      'system.version': 'Version',
      'system.cores': '{count} cores',
      'system.model': 'Model identifier',
      'system.coresLabel': 'Cores',
      'system.uptimeValue': 'Up {duration}',
      'system.available': 'Available',
      'system.unavailable': 'Unavailable',
      'system.saveDirectory': 'Save folder',
      'system.capturedAt': 'Sampled {time}',
      'system.unknown': 'Unknown',
      'duration.day': '{n}d',
      'duration.hour': '{n}h',
      'duration.minute': '{n}m',
      'duration.second': '{n}s',
      'shortcut.toggle': 'Toggle Mac Tools',
      'shortcut.screenshot': 'Quick screenshot (region / window)',
      'transfer.title': 'Phone transfer',
      'transfer.subtitle': 'Scan the QR code with a phone on the same Wi-Fi to send text, files and screenshots both ways.',
      'transfer.start': 'Start phone transfer',
      'transfer.starting': 'Starting…',
      'transfer.stop': 'Stop transfer',
      'transfer.stopping': 'Stopping…',
      'transfer.loading': 'Reading the transfer state…',
      'transfer.refresh': 'Refresh',
      'transfer.active': 'Transfer running',
      'transfer.qrAlt': 'QR code that opens the phone-transfer page',
      'transfer.qrFallback': 'QR code unavailable',
      'transfer.qrError': 'Could not generate the QR code: {message}',
      'transfer.urlLabel': 'Phone address',
      'transfer.copyUrl': 'Copy link',
      'transfer.urlCopied': 'Link copied',
      'transfer.copyFailed': 'Copy failed: {message}',
      'transfer.clipboardUnavailable': 'the clipboard is unavailable',
      'transfer.urlsTitle': 'LAN addresses',
      'transfer.remaining': '{duration} left',
      'transfer.expired': 'Expired',
      'transfer.wifiHint': 'The phone must be on the same Wi-Fi as this Mac; if the page does not open, check the macOS firewall.',
      'transfer.directory': 'Receiving folder: {directory}',
      'transfer.sessionMinutes': 'Session: {minutes} min',
      'transfer.maxFile': 'Max file size: {megabytes} MB',
      'transfer.inbox.title': 'From your phone',
      'transfer.inbox.count': '{count} items',
      'transfer.inbox.empty': 'Nothing received yet. Scan the QR code on your phone and send text, files or photos.',
      'transfer.inbox.error': 'Cannot read the inbox: {message}',
      'transfer.inbox.loading': 'Reading the inbox…',
      'transfer.inbox.clear': 'Clear',
      'transfer.inbox.clearConfirm': 'Clear everything?',
      'transfer.inbox.copy': 'Copy',
      'transfer.inbox.reveal': 'Show in Finder',
      'transfer.inbox.delete': 'Delete',
      'transfer.inbox.previewAlt': 'Image from the phone',
      'transfer.outbox.title': 'To your phone',
      'transfer.outbox.count': '{count} items',
      'transfer.outbox.empty': 'Nothing sent yet. Send text, a file or a recent screenshot and it appears on the phone.',
      'transfer.outbox.error': 'Cannot read the outbox: {message}',
      'transfer.outbox.loading': 'Reading the outbox…',
      'transfer.outbox.clear': 'Clear',
      'transfer.outbox.clearConfirm': 'Clear everything?',
      'transfer.outbox.remove': 'Remove',
      'transfer.outbox.textPlaceholder': 'Text to send to your phone… (⌘/Ctrl+Enter to send)',
      'transfer.outbox.send': 'Send',
      'transfer.outbox.sending': 'Sending…',
      'transfer.outbox.chooseFile': 'Choose a file…',
      'transfer.outbox.choosingFile': 'Choosing…',
      'transfer.outbox.recent': 'Recent screenshots',
      'transfer.outbox.recentEmpty': 'No screenshots yet.',
      'transfer.outbox.sendHistory': 'Send to phone',
      'transfer.kind.text': 'Text',
      'transfer.kind.file': 'File',
      'transfer.kind.history': 'Screenshot',
      'transfer.toast.failed': 'Action failed',
      'transfer.toast.sent': 'Sent to your phone',
      'transfer.toast.copied': 'Text copied',
      'transfer.toast.revealed': 'Shown in Finder',
      'transfer.toast.deleted': 'Deleted',
      'transfer.toast.cleared': 'Cleared',
      'transfer.toast.removed': 'Removed',
      'transfer.toast.fileAdded': 'Added to the outbox',
      'transfer.toast.filesAdded': 'Added {count} files',
      'transfer.error.unsupported': 'Phone transfer is unavailable in this build.',
      'transfer.error.not_found': 'That item is gone or its file was moved.',
      'transfer.error.invalid_request': 'The request was invalid; try again.',
      'transfer.error.too_large': 'The item exceeds the size limit.',
      'transfer.error.io_error': 'I/O error: {message}',
      'transfer.error.port_unavailable': 'The port is unavailable, so phone transfer could not start. Try again later.',
      'transfer.error.not_active': 'Phone transfer is not running yet.',
      'transfer.error.generic': 'Phone transfer failed ({code}): {message}',
      'tab.monitor': 'Status',
      'monitor.toolbarAria': 'Status toolbar',
      'monitor.sampledAt': 'Sampled {time}',
      'monitor.paused': 'Paused',
      'monitor.pause': 'Pause',
      'monitor.resume': 'Resume',
      'monitor.refresh': 'Refresh',
      'monitor.intervalAria': 'Refresh interval',
      'monitor.interval.option': '{n} s',
      'monitor.loading': 'Reading live status…',
      'monitor.error.generic': 'Cannot read live status: {message}',
      'monitor.unsupported.title': 'Live status is not supported on this platform',
      'monitor.unsupported.hint': 'The status panel requires macOS; the Host reports the platform as {platform}.',
      'monitor.badgesAria': 'Monitoring capabilities',
      'monitor.badge.sensors': 'Sensors',
      'monitor.badge.fans': 'Fan control',
      'monitor.badge.battery': 'Battery',
      'monitor.available': 'Available',
      'monitor.unavailable': 'Unavailable',
      'monitor.unknown': 'Unknown',
      'monitor.separator': ', ',
      'monitor.cpu.title': 'CPU',
      'monitor.cpu.cores': '{count} cores',
      'monitor.cpu.temperature': 'Temperature',
      'monitor.cpu.noTemperature': 'SMC temperature unavailable',
      'monitor.cpu.user': 'User',
      'monitor.cpu.system': 'System',
      'monitor.cpu.idle': 'Idle',
      'monitor.cpu.loadAverage': 'Load {load}',
      'monitor.cpu.perCore': 'Per-core usage',
      'monitor.cpu.coreAria': 'Core {index}: {value}%',
      'monitor.memory.title': 'Memory',
      'monitor.memory.available': '{available} available of {total}',
      'monitor.memory.usedPercent': '{percent}% used',
      'monitor.memory.breakdown': 'Memory breakdown',
      'monitor.memory.app': 'App',
      'monitor.memory.wired': 'Wired',
      'monitor.memory.compressed': 'Compressed',
      'monitor.memory.cached': 'Cached',
      'monitor.memory.free': 'Free',
      'monitor.memory.swap': 'Swap {size}',
      'monitor.memory.pressure': 'Memory pressure',
      'monitor.memory.pressure.normal': 'Normal',
      'monitor.memory.pressure.warning': 'Elevated',
      'monitor.memory.pressure.critical': 'Critical',
      'monitor.memory.pressure.unknown': 'Unknown',
      'monitor.disk.title': 'Disk',
      'monitor.disk.available': '{available} available of {total}',
      'monitor.disk.usedPercent': '{percent}% used',
      'monitor.disk.mount': 'Mounted at {mount}',
      'monitor.network.title': 'Network',
      'monitor.network.interface': 'Interface {name}',
      'monitor.network.ip': 'Local IP',
      'monitor.network.down': 'Down',
      'monitor.network.up': 'Up',
      'monitor.network.total': 'Total ↓ {down} · ↑ {up}',
      'monitor.network.none': 'Not connected',
      'monitor.battery.title': 'Battery',
      'monitor.battery.level': '{percent}%',
      'monitor.battery.charging': 'Charging',
      'monitor.battery.charged': 'Fully charged',
      'monitor.battery.discharging': 'On battery',
      'monitor.battery.remaining': '{duration} remaining',
      'monitor.battery.remainingUnknown': 'Remaining time unknown',
      'monitor.battery.health': 'Health {percent}%',
      'monitor.battery.cycles': '{count} cycles',
      'monitor.footer.uptime': 'Up {duration}',
      'monitor.footer.host': '{model} · {hostname}',
      'monitor.footer.os': '{os} {version}',
      'monitor.sensors.title': 'Temperature sensors',
      'monitor.sensors.showAll': 'All sensors',
      'monitor.sensors.hideAll': 'Hide sensors',
      'monitor.sensors.count': '{count} readings',
      'monitor.sensors.empty': 'No temperature readings available',
      'monitor.sensors.reason.swift-missing': 'swiftc (Xcode Command Line Tools) is missing, so SMC sensors cannot be read.',
      'monitor.sensors.reason.smc-unavailable': 'AppleSMC could not be opened, so temperature readings are unavailable.',
      'monitor.sensors.reason.compile-failed': 'The native sampler failed to compile, so temperature readings are unavailable.',
      'monitor.sensors.reason.unsupported-platform': 'SMC temperature sensors are not supported on this platform.',
      'monitor.sensors.reason.starting': 'Temperature sensors are still starting up; check back in a moment.',
      'monitor.sensors.reason.generic': 'Temperature sensors are unavailable: {reason}',
      'monitor.sensors.group.cpuPerformance': 'CPU performance',
      'monitor.sensors.group.cpuEfficiency': 'CPU efficiency',
      'monitor.sensors.group.gpu': 'GPU',
      'monitor.sensors.group.ssd': 'SSD',
      'monitor.sensors.group.memory': 'Memory',
      'monitor.sensors.group.wifi': 'Wi-Fi',
      'monitor.sensors.group.battery': 'Battery',
      'monitor.sensors.group.ambient': 'Ambient',
      'monitor.sensors.summaryAria': 'Temperature group summary',
      'monitor.sensors.familyCount': '{count} keys',
      'monitor.sensors.readingAria': '{key} at {value}',
      'monitor.fan.title': 'Fan control',
      'monitor.fan.installing': 'Installing the fan-control helper…',
      'monitor.fan.enable': 'Enable fan control',
      'monitor.fan.enabling': 'Waiting for administrator authorization…',
      'monitor.fan.install.intro': 'Writing fan speed requires administrator rights. Enabling installs a privileged helper used only to write the fan speed:',
      'monitor.fan.install.helper': 'A root helper at “/Library/Application Support/DSH Mac Tools/”.',
      'monitor.fan.install.daemon': 'A LaunchDaemon starts that helper and only writes fan speed to the SMC; it collects nothing and uploads nothing.',
      'monitor.fan.install.prompt': 'macOS asks for the administrator password exactly once; you can uninstall it from this panel at any time.',
      'monitor.fan.notInstalledTitle': 'Fan control is not enabled',
      'monitor.fan.errorTitle': 'Fan control error',
      'monitor.fan.uninstall': 'Uninstall fan control',
      'monitor.fan.uninstallConfirm': 'Uninstall now? The fan returns to system auto control immediately.',
      'monitor.fan.uninstalling': 'Uninstalling…',
      'monitor.fan.uninstallHint': 'Uninstalling removes the privileged helper and LaunchDaemon and gives the fan back to system auto control.',
      'monitor.fan.reinstall': 'Reinstall',
      'monitor.fan.retry': 'Retry',
      'monitor.fan.reason.swift-missing': 'swiftc (Xcode Command Line Tools) is missing, so the fan-control helper cannot be compiled.',
      'monitor.fan.reason.no-fans': 'No fan was detected on this Mac.',
      'monitor.fan.reason.unsupported-platform': 'Fan control is only available on macOS.',
      'monitor.fan.reason.install-failed': 'Installing the fan-control helper failed: {message}',
      'monitor.fan.reason.cancelled': 'Administrator authorization was cancelled, so fan control was not installed.',
      'monitor.fan.reason.daemon-unreachable': 'The privileged daemon is not answering; retry or reinstall.',
      'monitor.fan.reason.not-installed': 'The fan-control helper is not installed yet.',
      'monitor.fan.reason.generic': 'Fan control is unavailable: {reason}',
      'monitor.fan.error.fan_not_ready': 'The fan-control helper is not ready; retry or reinstall.',
      'monitor.fan.error.fan_apply_failed': 'The fan-speed write was refused: {message}',
      'monitor.fan.error.generic': 'Fan control failed ({code}): {message}',
      'monitor.fan.fansAria': 'Fan readings',
      'monitor.fan.fanName': 'Fan {index}',
      'monitor.fan.actual': 'Now {rpm}',
      'monitor.fan.target': 'Target {rpm}',
      'monitor.fan.range': '{min}–{max} RPM',
      'monitor.fan.fanState.auto': 'System auto',
      'monitor.fan.fanState.forced': 'Forced',
      'monitor.fan.fanState.unknown': 'Unknown',
      'monitor.fan.mode': 'Mode',
      'monitor.fan.mode.auto': 'Auto',
      'monitor.fan.mode.manual': 'Manual',
      'monitor.fan.mode.curve': 'Curve',
      'monitor.fan.manual': 'Manual speed',
      'monitor.fan.manualHint': 'Committed when the slider is released (about 250 ms debounce).',
      'monitor.fan.manualValue': '{rpm} RPM',
      'monitor.fan.holding': 'Holding control · target {rpm} RPM',
      'monitor.fan.autoHolding': 'System auto control',
      'monitor.fan.appliedAt': 'Applied {time}',
      'monitor.fan.curve.title': 'Temperature curve',
      'monitor.fan.curve.sensor': 'Temperature source',
      'monitor.fan.curve.hint': 'Drag a point to change temperature and speed; click empty space to add one; keep 2–8 points.',
      'monitor.fan.curve.delete': 'Delete point',
      'monitor.fan.curve.reset': 'Reset curve',
      'monitor.fan.curve.apply': 'Apply curve',
      'monitor.fan.curve.points': '{count} points',
      'monitor.fan.curve.point': '{celsius} °C → {rpm} RPM',
      'monitor.fan.presets': 'Presets',
      'monitor.fan.preset.auto': 'Auto',
      'monitor.fan.preset.quiet': 'Quiet',
      'monitor.fan.preset.balanced': 'Balanced',
      'monitor.fan.preset.performance': 'Performance',
      'monitor.fan.preset.max': 'Max',
      'monitor.fan.preset.custom': 'Custom',
      'monitor.fan.preset.save': 'Save current',
      'monitor.fan.preset.saveActive': 'Save the current mode as a preset',
      'monitor.fan.preset.namePlaceholder': 'Preset name',
      'monitor.fan.preset.delete': 'Delete the “{name}” preset',
      'monitor.fan.preset.nameRequired': 'Enter a preset name.',
      'monitor.fan.preset.invalid': 'Auto mode cannot be saved as a preset; pick Manual or Curve first.',
      'monitor.fan.preset.saved': 'Preset saved',
      'monitor.fan.restoreAuto': 'Restore system auto',
      'monitor.fan.otherControllers': 'Another fan controller is running: {names}. It will fight this panel over the fan.',
      'monitor.fan.pendingApply': 'Applying…',
      'monitor.fan.notReadyHint': 'The fan-control helper is not ready, so fan speeds cannot be read or written right now.',
      'monitor.processes.title': 'Top processes',
      'monitor.processes.expand': 'Expand the process ranking',
      'monitor.processes.collapse': 'Collapse the process ranking',
      'monitor.processes.hint': 'Sorted by {sort} · refreshed every 3 s',
      'monitor.processes.sortAria': 'Process sort order',
      'monitor.processes.sort.cpu': 'CPU',
      'monitor.processes.sort.memory': 'Memory',
      'monitor.processes.loading': 'Reading the process list…',
      'monitor.processes.empty': 'No processes to show',
      'monitor.processes.error': 'Cannot read the process list: {message}',
      'monitor.processes.pid': 'PID {pid}',
      'monitor.processes.name': 'Process',
      'monitor.processes.cpu': 'CPU',
      'monitor.processes.memory': 'Memory',
      'monitor.processes.rss': 'RSS',
      'monitor.processes.kill': 'Kill',
      'monitor.processes.killArmed': 'Confirm?',
      'monitor.processes.killAria': 'Kill the process {name} (PID {pid})',
      'monitor.processes.killProtected': 'Protected',
      'monitor.processes.killing': 'Killing…',
      'monitor.processes.error.kill_invalid_pid': 'That process cannot be killed (invalid PID, or it belongs to the Host itself).',
      'monitor.processes.error.kill_not_found': 'The process already exited.',
      'monitor.processes.error.kill_denied': 'Permission denied when killing that process.',
      'monitor.processes.error.generic': 'Action failed ({code}): {message}',
      'monitor.alerts.title': 'Alerts',
      'monitor.alerts.enabled': 'Enable alerts',
      'monitor.alerts.cpu': 'CPU threshold %',
      'monitor.alerts.temperature': 'Temperature threshold °C',
      'monitor.alerts.memory': 'Memory threshold %',
      'monitor.alerts.cooldown': 'Cooldown (seconds)',
      'monitor.alerts.notify': 'Send system notifications',
      'monitor.alerts.save': 'Save',
      'monitor.alerts.saving': 'Saving…',
      'monitor.alerts.saved': 'Saved',
      'monitor.alerts.test': 'Test notification',
      'monitor.alerts.testing': 'Sending…',
      'monitor.alerts.testSent': 'Test notification sent',
      'monitor.alerts.testUnavailable': 'This system cannot show notifications',
      'monitor.alerts.testFailed': 'The test notification failed: {message}',
      'monitor.alerts.events': 'Recent alerts',
      'monitor.alerts.eventsEmpty': 'No alert has fired yet',
      'monitor.alerts.eventRow': 'reached {value} (threshold {threshold})',
      'monitor.alerts.metric.cpu': 'CPU usage',
      'monitor.alerts.metric.temperature': 'Temperature',
      'monitor.alerts.metric.memory': 'Memory usage',
      'monitor.alerts.metric.unknown': 'Metric',
      'monitor.alerts.cooldownHint': 'Each metric alerts at most once per cooldown window.',
      'monitor.alerts.hint': 'Thresholds are evaluated by the Host in real time; firing shows a macOS notification (notification permission required).',
      'monitor.alerts.temperatureUnavailable': 'Temperature alerts are paused because the sensors are unavailable.',
      'monitor.alerts.error.invalid': 'Enter a valid number in range.',
      'monitor.alerts.error.generic': 'Alert action failed ({code}): {message}',
      'monitor.alerts.unavailable': 'Alert settings are unavailable',
      'monitor.system.title': 'System info',
      'monitor.system.hardware': 'System & hardware',
      'monitor.system.runtime': 'Runtime',
      'monitor.system.capabilities': 'Capabilities',
      'monitor.system.chip': 'Chip',
      'monitor.system.coresDetail': '{count} ({performance} performance + {efficiency} efficiency)',
      'monitor.system.hostPid': 'Host PID',
      'monitor.system.sampledAt': 'Sampled at',
      'monitor.system.interval': 'Sample interval',
      'monitor.system.polling': 'Polling',
      'monitor.system.pollingActive': 'Polling',
      'monitor.system.capability.screenshot': 'Screenshots',
      'monitor.system.capability.hideApp': 'Hide app while capturing',
      'monitor.system.capability.pin': 'Pinned windows',
      'monitor.system.capability.history': 'Screenshot history',
      'monitor.system.capability.transfer': 'Phone transfer',
      'monitor.system.capability.monitor': 'Live status monitoring',
      'monitor.system.capability.fanControl': 'Fan control',
      'monitor.system.note': 'Memory, disk, battery, CPU and network values live in the overview cards above.',
    }

    /**
     * The panel's stylesheet.
     *
     * It follows the shell's own design language: the Schedule page's
     * page/scroll/content geometry, pill tabs, flat hover-tinted rows, the shared
     * button and notice patterns, and card surfaces. Every chrome color is a
     * `--dsw-*` theme token, so the panel follows light and dark themes; the
     * only literal colors in this plugin are the annotation palette values,
     * which are artwork and live in the canvas engine below, not here. Motion is
     * short and disabled under `prefers-reduced-motion`.
     */
    const css = `
.dshMacToolsPage{width:100%;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;display:flex;overflow:hidden}
.dshMacToolsScroll{scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;flex:1;min-height:0;overflow:auto}
.dshMacToolsContent{width:100%;max-width:980px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.dshMacToolsHeading{display:flex;align-items:center;gap:14px;margin:0 0 16px;padding-top:28px}
[data-platform=darwin] .dshMacToolsHeading{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dshMacToolsHeadingMain{display:flex;align-items:center;gap:14px;flex:1;min-width:0}
.dshMacToolsBrandMark{width:42px;height:42px;flex:none;display:grid;place-items:center;color:var(--dsw-alias-state-business-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsHeadingText{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshMacToolsHeadingText h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dshMacToolsSubtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsHeadingRight{display:flex;align-items:center;gap:8px;flex:none;max-width:min(360px,44vw)}
.dshMacToolsStatusPill{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;padding:5px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshMacToolsStatusDot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dshMacToolsStatusReady .dshMacToolsStatusDot{background:var(--dsw-alias-state-success-primary)}
.dshMacToolsStatusLoading .dshMacToolsStatusDot{background:var(--dsw-alias-state-warn-primary)}
.dshMacToolsStatusMissing .dshMacToolsStatusDot,.dshMacToolsStatusError .dshMacToolsStatusDot{background:var(--dsw-alias-state-error-primary)}
.dshMacToolsStatusMissing,.dshMacToolsStatusError{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.dshMacToolsStatusText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dshMacToolsStatusRetry{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer}
.dshMacToolsStatusRetry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsTabs{display:flex;align-items:center;gap:2px;margin:0 0 18px;flex-wrap:wrap;border-bottom:.5px solid var(--dsw-alias-border-l1);padding-bottom:6px}
.dshMacToolsTab{display:inline-flex;align-items:center;gap:6px;height:30px;flex:none;padding:0 12px;border:0;border-radius:15px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;transition:background .15s,color .15s}
.dshMacToolsTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshMacToolsTabActive,.dshMacToolsTabActive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
.dshMacToolsScreenshot{display:flex;flex-direction:column;min-width:0;gap:12px}
.dshMacToolsTabPanel{animation:dshMacToolsFadeIn .18s ease-in-out}
.dshMacToolsTabPanel[hidden]{display:none}
.dshMacToolsButton{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;flex:none;padding:0 13px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .15s,border-color .15s,color .15s,opacity .15s}
.dshMacToolsButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsButton:disabled{cursor:not-allowed;opacity:.4}
.dshMacToolsButtonCompact{height:28px;padding:0 10px;border-radius:14px;font-size:12px;line-height:18px}
.dshMacToolsButtonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dshMacToolsButtonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshMacToolsButtonOutline{border:.5px solid var(--dsw-alias-border-l3)}
.dshMacToolsButtonOutline:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dshMacToolsButtonDanger{color:var(--dsw-alias-state-error-primary);font-weight:500}
.dshMacToolsButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dshMacToolsIconButton{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s,color .15s,opacity .15s}
.dshMacToolsIconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshMacToolsIconButton:disabled{cursor:not-allowed;opacity:.35}
.dshMacToolsIconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshMacToolsIcon{display:block}
.dshMacToolsHint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshMacToolsHintWarn{color:var(--dsw-alias-state-error-primary)}
.dshMacToolsSrOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.dshMacToolsNotice{display:flex;align-items:flex-start;flex-wrap:wrap;gap:9px;margin:0 0 14px;padding:11px 13px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dshMacToolsNotice p{flex:1;min-width:0;margin:0;overflow-wrap:anywhere}
.dshMacToolsNotice .dshMacToolsButton{margin-left:auto}
.dshMacToolsNoticeError{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.dshMacToolsNoticeIcon{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
.dshMacToolsNoticeError .dshMacToolsNoticeIcon{color:var(--dsw-alias-state-error-primary)}
.dshMacToolsCaptureBar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px}
.dshMacToolsCaptureActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshMacToolsToggle{display:inline-flex;align-items:center;gap:6px}
.dshMacToolsToggleOn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshMacToolsToggleOn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dshMacToolsHotkeyHint{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshMacToolsHotkeyRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}
.dshMacToolsHotkeyLabel{color:var(--dsw-alias-label-secondary)}
.dshMacToolsHotkeyValue{min-width:72px;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.dshMacToolsHotkeyMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshMacToolsHotkeyError{margin:0 0 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dshMacToolsHistory{margin-top:24px;padding-top:18px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dshMacToolsHistoryHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.dshMacToolsHistoryTitle{margin:0;font-size:15px;font-weight:500;line-height:22px}
.dshMacToolsHistoryCount{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsHistoryActions{display:flex;gap:6px;margin-left:auto}
.dshMacToolsHistoryEmpty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:21px}
.dshMacToolsHistoryError{margin:0 0 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dshMacToolsHistoryGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:10px}
.dshMacToolsHistoryCard{display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsHistoryThumb{display:block;padding:0;border:0;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.dshMacToolsHistoryThumb img{display:block;width:100%;height:104px;object-fit:cover}
.dshMacToolsHistoryMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsHistoryRow{display:flex;gap:2px;flex-wrap:wrap;margin-top:auto}
.dshMacToolsCaptureBusy{display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;border:.5px solid var(--dsw-alias-state-warn-secondary);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dshMacToolsCaptureBusy p{flex:1;min-width:0;margin:0}
.dshMacToolsSpinner{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);animation:dshMacToolsSpin .8s linear infinite}
.dshMacToolsWindowsPanel{margin:0 0 14px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsWindowsHeader{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshMacToolsWindowsTitle{margin:0;flex:1;min-width:120px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshMacToolsWindowsCount{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.dshMacToolsInput{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;font:inherit;font-size:13px;line-height:20px}
.dshMacToolsInput::placeholder{color:var(--dsw-alias-label-caption)}
.dshMacToolsInput:focus{border-color:var(--dsw-alias-state-business-primary)}
.dshMacToolsWindowsFilter{flex:1 1 180px;min-width:140px}
.dshMacToolsWindowsList{display:flex;flex-direction:column;gap:2px;margin:10px 0 0;padding:0;list-style:none;max-height:300px;overflow:auto}
.dshMacToolsWindowRow{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px 10px;width:100%;padding:7px 9px;border:0;border-radius:10px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;transition:background .15s}
.dshMacToolsWindowRow:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsWindowRow:disabled{cursor:not-allowed;opacity:.5}
.dshMacToolsWindowText{display:flex;flex-direction:column;min-width:0}
.dshMacToolsWindowApp{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsWindowTitle{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsWindowMeta{display:flex;align-items:center;gap:6px;flex:none}
.dshMacToolsWindowSize{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshMacToolsBadge{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:16px;white-space:nowrap}
.dshMacToolsEmpty{display:flex;flex-direction:column;align-items:center;margin:0;padding:36px 20px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);text-align:center;animation:dshMacToolsFadeIn .18s ease-in-out}
.dshMacToolsEmptyArt{display:grid;place-items:center;width:52px;height:52px;margin-bottom:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-caption)}
.dshMacToolsEmptyTitle{margin:0 0 6px;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}
.dshMacToolsEmptyHint{margin:0;max-width:420px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshMacToolsEditor{margin:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshMacToolsEditorBar{display:flex;align-items:center;gap:10px 12px;flex-wrap:wrap;padding:9px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dshMacToolsEditorMeta{flex:1;min-width:160px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsEditorMetaSub{margin:1px 0 0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsEditorActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshMacToolsToolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:7px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dshMacToolsToolGroup{display:flex;align-items:center;gap:1px;flex-wrap:wrap}
.dshMacToolsToolDivider{width:.5px;height:20px;flex:none;background:var(--dsw-alias-border-l1)}
.dshMacToolsToolButton{display:inline-flex;align-items:center;gap:5px;height:28px;flex:none;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s,color .15s}
.dshMacToolsToolButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshMacToolsToolButtonActive,.dshMacToolsToolButtonActive:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}
.dshMacToolsToolButton:disabled{cursor:not-allowed;opacity:.4}
.dshMacToolsToolLabel{white-space:nowrap}
.dshMacToolsSwatches{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dshMacToolsSwatch{position:relative;width:20px;height:20px;flex:none;padding:0;border:0;border-radius:50%;cursor:pointer;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4)}
.dshMacToolsSwatchActive{box-shadow:0 0 0 2px var(--dsw-alias-bg-base),0 0 0 3.5px var(--dsw-alias-label-primary)}
.dshMacToolsWidths{display:flex;align-items:center;gap:2px}
.dshMacToolsWidthButton{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s}
.dshMacToolsWidthButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshMacToolsWidthButtonActive,.dshMacToolsWidthButtonActive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}
.dshMacToolsWidthSample{display:block;width:15px;border-radius:999px;background:currentColor}
.dshMacToolsWidthSample1{height:2px}
.dshMacToolsWidthSample2{height:3px}
.dshMacToolsWidthSample3{height:5px}
.dshMacToolsCropBar{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsCropInfo{flex:1;min-width:150px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsCropActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshMacToolsCanvasStage{position:relative;display:flex;align-items:center;justify-content:center;align-items:safe center;justify-content:safe center;padding:14px;max-height:calc(100vh - 320px);overflow:auto;background-color:var(--dsw-alias-bg-layer-1);background-image:linear-gradient(45deg,var(--dsw-alias-bg-layer-2) 25%,transparent 25%,transparent 75%,var(--dsw-alias-bg-layer-2) 75%),linear-gradient(45deg,var(--dsw-alias-bg-layer-2) 25%,transparent 25%,transparent 75%,var(--dsw-alias-bg-layer-2) 75%);background-size:16px 16px;background-position:0 0,8px 8px}
.dshMacToolsCanvas{display:block;width:auto;max-width:100%;min-width:0;height:auto;border-radius:2px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);touch-action:none;user-select:none;-webkit-user-select:none}
.dshMacToolsTextInput{position:absolute;z-index:2;min-width:120px;max-width:min(320px,60vw);padding:3px 7px;border:.5px solid var(--dsw-alias-state-business-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none;box-shadow:var(--dsw-elevation-prominent);font:inherit;font-size:14px;line-height:20px}
.dshMacToolsTextHint{position:absolute;z-index:2;margin-top:26px;padding:2px 6px;border-radius:5px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-toast-label);font-size:11px;line-height:16px;white-space:nowrap;pointer-events:none}
.dshMacToolsEditorFooter{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dshMacToolsEditorHint{margin:0;flex:1;min-width:180px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px}
.dshMacToolsToast{position:fixed;left:50%;bottom:28px;z-index:1200;display:flex;align-items:center;gap:10px;max-width:min(620px,calc(100vw - 48px));padding:10px 14px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:var(--dsw-elevation-prominent);font-size:13px;line-height:20px;transform:translateX(-50%);animation:dshMacToolsToastIn .18s ease-out}
.dshMacToolsToastText{min-width:0;overflow-wrap:anywhere}
.dshMacToolsToastError{color:var(--dsw-alias-state-error-primary)}
.dshMacToolsToastAction{flex:none;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}
.dshMacToolsToastAction:hover{opacity:.8}
.dshMacToolsCalc{display:flex;flex-direction:column;gap:12px;max-width:360px}
.dshMacToolsCalcDisplay{padding:14px 16px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsCalcDisplayTop{display:flex;align-items:center;gap:8px}
.dshMacToolsCalcExpression{box-sizing:border-box;flex:1;min-width:0;height:34px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);outline:none;text-align:right;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:16px;line-height:24px;font-variant-numeric:tabular-nums}
.dshMacToolsCalcExpression::placeholder{color:var(--dsw-alias-label-caption)}
.dshMacToolsCalcExpression:focus{background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsCalcAngles{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshMacToolsCalcResult{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-top:8px;min-height:44px}
.dshMacToolsCalcResultValue{margin:0;min-width:0;color:var(--dsw-alias-label-primary);text-align:right;overflow-wrap:anywhere;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:26px;line-height:34px;font-weight:500;font-variant-numeric:tabular-nums}
.dshMacToolsCalcResultLabel{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px}
.dshMacToolsCalcError{margin:6px 0 0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshMacToolsCalcMuted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:22px;line-height:32px;text-align:right}
.dshMacToolsCalcKeypad{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;padding:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsKey{height:46px;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:17px;line-height:24px;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s}
.dshMacToolsKey:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsKey:disabled{cursor:not-allowed;opacity:.45}
.dshMacToolsKeyFn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:15px}
.dshMacToolsKeyAction{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:15px}
.dshMacToolsKeyOp{color:var(--dsw-alias-state-business-primary);font-weight:500}
.dshMacToolsKeyEquals{grid-column:1/-1;height:42px;border:0;border-radius:10px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:16px;font-weight:600;cursor:pointer;transition:background .15s,opacity .15s}
.dshMacToolsKeyEquals:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshMacToolsKeyEquals:disabled{cursor:not-allowed;opacity:.45}
.dshMacToolsCalcHistory{padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsCalcHistoryTitle{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 8px}
.dshMacToolsCalcHistoryTitle h3{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.dshMacToolsHistoryList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none}
.dshMacToolsHistoryRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;transition:background .15s}
.dshMacToolsHistoryRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsHistoryExpr{min-width:0;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsHistoryValue{flex:none;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshMacToolsSysHeader{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.dshMacToolsSysMeta{flex:1;min-width:140px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsSysGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.dshMacToolsCard{padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);min-width:0}
.dshMacToolsCardWide{grid-column:1/-1}
.dshMacToolsCardTitle{display:flex;align-items:center;gap:6px;margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;letter-spacing:.02em;text-transform:uppercase}
.dshMacToolsCardTitle svg{flex:none}
.dshMacToolsCardBody{display:flex;flex-direction:column;gap:1px;min-width:0}
.dshMacToolsKv{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:2px 0;font-size:13px;line-height:20px}
.dshMacToolsKvLabel{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshMacToolsKvValue{min-width:0;color:var(--dsw-alias-label-primary);text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.dshMacToolsKvValueMono{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
.dshMacToolsBar{position:relative;height:6px;margin:8px 0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.dshMacToolsBarFill{height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary);transition:width .2s ease-in-out}
.dshMacToolsBarFillDisk{background:var(--dsw-alias-state-business-primary)}
.dshMacToolsBarFillBattery{background:var(--dsw-alias-state-success-primary)}
.dshMacToolsBarMeta{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsLoading{display:flex;flex-direction:column;gap:8px}
.dshMacToolsSkeleton{height:64px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-skeleton);animation:dshMacToolsPulse 2s cubic-bezier(.36,0,.64,1) infinite}
.dshMacToolsPage :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshMacToolsCalcExpression:focus-visible,.dshMacToolsInput:focus-visible,.dshMacToolsTextInput:focus-visible{outline:none}
@keyframes dshMacToolsSpin{to{transform:rotate(360deg)}}
@keyframes dshMacToolsFadeIn{from{opacity:0}to{opacity:1}}
@keyframes dshMacToolsToastIn{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes dshMacToolsPulse{0%,100%{opacity:1}50%{opacity:.55}}
.dshMacToolsTransfer{display:flex;flex-direction:column;gap:14px;min-width:0}
.dshMacToolsTransferCard{padding:16px 18px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);min-width:0}
.dshMacToolsTransferCardHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshMacToolsTransferCardTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}
.dshMacToolsTransferCardMeta{flex:1;min-width:120px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsTransferIntroText{margin:6px 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshMacToolsTransferStartRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshMacToolsTransferQrRow{display:flex;align-items:flex-start;gap:18px;flex-wrap:wrap;margin-top:14px}
.dshMacToolsTransferQrBox{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none;min-width:0}
.dshMacToolsTransferQrImage{display:block;width:148px;height:148px;padding:8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);image-rendering:pixelated;box-sizing:border-box}
.dshMacToolsTransferQrFallback{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:148px;height:148px;padding:10px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center;overflow-wrap:anywhere}
.dshMacToolsTransferSession{display:flex;flex-direction:column;gap:8px;flex:1;min-width:220px}
.dshMacToolsTransferUrlRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshMacToolsTransferUrl{min-width:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}
.dshMacToolsTransferUrls{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dshMacToolsTransferUrlItem{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:17px;overflow-wrap:anywhere}
.dshMacToolsTransferHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshMacToolsTransferHintError{color:var(--dsw-alias-state-error-primary)}
.dshMacToolsTransferWarnings{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dshMacToolsTransferWarning{display:flex;align-items:flex-start;gap:6px;margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshMacToolsTransferWarningIcon{display:inline-flex;flex:none;margin-top:2px}
.dshMacToolsTransferColumns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.dshMacToolsTransferColumn{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsTransferColHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshMacToolsTransferColTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}
.dshMacToolsTransferColCount{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshMacToolsTransferColActions{display:flex;align-items:center;gap:2px;flex-wrap:wrap;margin-left:auto}
.dshMacToolsTransferCompose{display:flex;flex-direction:column;gap:8px}
.dshMacToolsTransferTextarea{box-sizing:border-box;width:100%;min-height:64px;max-height:180px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;resize:vertical;font:inherit;font-size:13px;line-height:20px}
.dshMacToolsTransferTextarea::placeholder{color:var(--dsw-alias-label-caption)}
.dshMacToolsTransferTextarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.dshMacToolsTransferComposeRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshMacToolsTransferRecent{display:flex;flex-direction:column;gap:6px}
.dshMacToolsTransferRecentTitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;letter-spacing:.02em;text-transform:uppercase}
.dshMacToolsTransferRecentGrid{display:flex;flex-wrap:wrap;gap:6px}
.dshMacToolsTransferRecentButton{display:block;width:56px;height:56px;flex:none;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;overflow:hidden;transition:border-color .15s,opacity .15s}
.dshMacToolsTransferRecentButton:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.dshMacToolsTransferRecentButton:disabled{cursor:not-allowed;opacity:.4}
.dshMacToolsTransferRecentButton img{display:block;width:100%;height:100%;object-fit:cover}
.dshMacToolsTransferList{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;max-height:320px;overflow:auto}
.dshMacToolsTransferRow{display:flex;flex-direction:column;gap:4px;padding:8px 9px;border-radius:10px;transition:background .15s}
.dshMacToolsTransferRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsTransferRowMain{display:flex;align-items:flex-start;gap:9px;min-width:0}
.dshMacToolsTransferThumb{width:56px;height:56px;flex:none;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshMacToolsTransferThumb img{display:block;width:100%;height:100%;object-fit:cover}
.dshMacToolsTransferRowText{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.dshMacToolsTransferRowName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsTransferRowPreview{display:-webkit-box;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dshMacToolsTransferRowMeta{margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsTransferRowActions{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
.dshMacToolsTransferBadge{flex:none;margin-left:auto;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);font-size:10px;line-height:16px;white-space:nowrap}
.dshMacToolsTransferEmpty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;margin:0;padding:22px 14px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center;overflow-wrap:anywhere}
.dshMacToolsTransferLoading{display:flex;align-items:center;gap:8px;margin:0;padding:14px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshMacToolsTransferSkeleton{height:44px;flex:none;border-radius:10px}
.dshMacToolsTransferToastRegion{position:relative}
.dshMacToolsMonitor{display:flex;flex-direction:column;gap:14px;min-width:0}
.dshMacToolsMonitorToolbar{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;padding:9px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshMacToolsMonitorSampledAt{flex:1;min-width:150px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorBadges{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.dshMacToolsMonitorBadge{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;white-space:nowrap}
.dshMacToolsMonitorBadgeOk{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary)}
.dshMacToolsMonitorBadgeWarn{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshMacToolsMonitorBadgePaused{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}
.dshMacToolsMonitorIntervals{display:flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshMacToolsMonitorInterval{height:24px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:17px;cursor:pointer}
.dshMacToolsMonitorInterval:hover{color:var(--dsw-alias-label-primary)}
.dshMacToolsMonitorIntervalActive,.dshMacToolsMonitorIntervalActive:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}
.dshMacToolsMonitorOverview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.dshMacToolsMonitorCardWide{grid-column:1/-1}
.dshMacToolsMonitorCardHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.dshMacToolsMonitorCardTitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;letter-spacing:.02em;text-transform:uppercase}
.dshMacToolsMonitorCardMeta{min-width:0;margin:0 0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsMonitorBig{display:flex;align-items:baseline;gap:7px;margin:0 0 4px}
.dshMacToolsMonitorBigValue{margin:0;color:var(--dsw-alias-label-primary);font-size:26px;line-height:32px;font-weight:500;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorBigUnit{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshMacToolsMonitorRowLine{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorMuted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshMacToolsMonitorSparkline{display:block;width:100%;height:38px;margin:7px 0 3px;overflow:visible}
.dshMacToolsMonitorSparklineTall{height:48px}
.dshMacToolsMonitorSparkLine{fill:none;stroke-width:1.6;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round;transition:none}
.dshMacToolsMonitorSparkArea{stroke:none;opacity:.14;transition:none}
.dshMacToolsMonitorLegend{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0;padding:0;list-style:none}
.dshMacToolsMonitorLegendItem{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshMacToolsMonitorLegendDot{width:7px;height:7px;flex:none;border-radius:50%}
.dshMacToolsMonitorCoreBars{display:flex;align-items:flex-end;gap:2px;height:26px;margin:6px 0 2px}
.dshMacToolsMonitorCoreBar{position:relative;flex:1;min-width:2px;max-width:14px;height:100%;border-radius:3px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.dshMacToolsMonitorCoreFill{position:absolute;left:0;right:0;bottom:0;border-radius:inherit;background:var(--dsw-alias-state-business-primary)}
.dshMacToolsMonitorStack{display:flex;width:100%;height:8px;margin:8px 0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.dshMacToolsMonitorStackPart{height:100%;min-width:0}
.dshMacToolsMonitorPressure{flex:none;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:17px;white-space:nowrap}
.dshMacToolsMonitorPressureNormal{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary)}
.dshMacToolsMonitorPressureWarning{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}
.dshMacToolsMonitorPressureCritical{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshMacToolsMonitorFooter{display:flex;align-items:center;gap:6px 16px;flex-wrap:wrap;grid-column:1/-1;padding:2px 2px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorSection{padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);min-width:0}
.dshMacToolsMonitorSectionHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.dshMacToolsMonitorSectionTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}
.dshMacToolsMonitorSectionMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorSectionActions{display:flex;align-items:center;gap:2px;flex-wrap:wrap;margin-left:auto}
.dshMacToolsMonitorSectionBody{display:flex;flex-direction:column;gap:8px;min-width:0}
.dshMacToolsMonitorChips{display:flex;align-items:stretch;gap:6px;flex-wrap:wrap;margin:0;padding:0;list-style:none}
.dshMacToolsMonitorChip{display:flex;flex-direction:column;gap:1px;min-width:84px;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshMacToolsMonitorChipLabel{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;white-space:nowrap}
.dshMacToolsMonitorChipValue{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshMacToolsMonitorSensorList{display:flex;flex-direction:column;gap:8px;margin:2px 0 0;max-height:320px;overflow:auto}
.dshMacToolsMonitorSensorFamily{display:flex;flex-direction:column;gap:2px}
.dshMacToolsMonitorSensorFamilyHead{display:flex;align-items:baseline;gap:8px;margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;font-weight:500}
.dshMacToolsMonitorSensorFamilyMeta{margin-left:auto;color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorSensorRows{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0;padding:0;list-style:none}
.dshMacToolsMonitorSensorRow{display:inline-flex;align-items:baseline;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorSensorKey{color:var(--dsw-alias-label-caption);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace)}
.dshMacToolsMonitorSensorValue{color:var(--dsw-alias-label-primary)}
.dshMacToolsMonitorFanFans{display:flex;flex-direction:column;gap:4px;margin:0 0 4px;padding:0;list-style:none}
.dshMacToolsMonitorFanRow{display:flex;align-items:baseline;gap:8px 12px;flex-wrap:wrap;padding:6px 9px;border-radius:9px;background:var(--dsw-alias-bg-base);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorFanName{color:var(--dsw-alias-label-secondary);font-weight:500}
.dshMacToolsMonitorFanMeta{color:var(--dsw-alias-label-primary)}
.dshMacToolsMonitorFanHint{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshMacToolsMonitorFanBadge{padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
.dshMacToolsMonitorSegmented{display:flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshMacToolsMonitorSegment{height:26px;padding:0 11px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshMacToolsMonitorSegment:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshMacToolsMonitorSegmentActive,.dshMacToolsMonitorSegmentActive:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}
.dshMacToolsMonitorSegment:disabled{cursor:not-allowed;opacity:.4}
.dshMacToolsMonitorSliderRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshMacToolsMonitorSlider{flex:1;min-width:140px;accent-color:var(--dsw-alias-state-business-primary)}
.dshMacToolsMonitorSliderValue{min-width:86px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;font-weight:500;font-variant-numeric:tabular-nums;text-align:right}
.dshMacToolsMonitorCurveBox{display:flex;flex-direction:column;gap:6px;margin-top:4px;padding:10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshMacToolsMonitorCurveSvg{display:block;width:100%;height:auto;touch-action:none;user-select:none;-webkit-user-select:none;cursor:crosshair}
.dshMacToolsMonitorCurveGrid{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke}
.dshMacToolsMonitorCurveArea{stroke:none;fill:var(--dsw-alias-state-business-primary);opacity:.12}
.dshMacToolsMonitorCurveLine{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:1.8;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round;transition:none}
.dshMacToolsMonitorCurvePoint{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-state-business-primary);stroke-width:1.8;vector-effect:non-scaling-stroke;cursor:grab;transition:none}
.dshMacToolsMonitorCurvePointActive{fill:var(--dsw-alias-state-business-primary);stroke:var(--dsw-alias-label-primary-foreground)}
.dshMacToolsMonitorCurveAxis{fill:var(--dsw-alias-label-caption);font-size:8px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorCurveBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshMacToolsMonitorCurveMeta{flex:1;min-width:150px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorPresets{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:2px 0 0}
.dshMacToolsMonitorPresetWrap{display:inline-flex;align-items:center;gap:0}
.dshMacToolsMonitorPreset{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshMacToolsMonitorPreset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshMacToolsMonitorPresetActive,.dshMacToolsMonitorPresetActive:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);font-weight:500}
.dshMacToolsMonitorPreset:disabled{cursor:not-allowed;opacity:.4}
.dshMacToolsMonitorPresetDelete{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;margin-left:-3px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-caption);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.dshMacToolsMonitorPresetDelete:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshMacToolsMonitorPresetSave{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.dshMacToolsMonitorPresetInput{flex:0 1 160px;min-width:120px;height:28px;font-size:12px}
.dshMacToolsMonitorWarning{display:flex;align-items:flex-start;gap:7px;margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-state-warn-secondary);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshMacToolsMonitorWarningIcon{display:inline-flex;flex:none;margin-top:2px}
.dshMacToolsMonitorFanFooter{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorFanBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshMacToolsMonitorFanBar .dshMacToolsButton{margin-left:auto}
.dshMacToolsMonitorInstallText{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;overflow-wrap:anywhere}
.dshMacToolsMonitorInstallMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dshMacToolsMonitorProcessSort{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshMacToolsMonitorProcessTable{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none}
.dshMacToolsMonitorProcessRow{display:grid;grid-template-columns:minmax(0,1fr) 62px 62px 78px auto;align-items:center;gap:4px 10px;padding:6px 9px;border-radius:9px;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorProcessRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsMonitorProcessRowHead,.dshMacToolsMonitorProcessRowHead:hover{background:transparent;color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;letter-spacing:.02em;text-transform:uppercase}
.dshMacToolsMonitorProcessName{display:flex;flex-direction:column;min-width:0}
.dshMacToolsMonitorProcessLabel{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshMacToolsMonitorProcessPid{color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px}
.dshMacToolsMonitorProcessValue{color:var(--dsw-alias-label-secondary);text-align:right}
.dshMacToolsMonitorProcessActions{display:flex;justify-content:flex-end}
.dshMacToolsMonitorKill{height:24px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:17px;cursor:pointer;white-space:nowrap}
.dshMacToolsMonitorKill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshMacToolsMonitorKill:disabled{cursor:not-allowed;opacity:.45}
.dshMacToolsMonitorKillArmed{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-weight:500}
.dshMacToolsMonitorProtected{color:var(--dsw-alias-label-caption);font-size:10px;line-height:17px;white-space:nowrap}
.dshMacToolsMonitorAlerts{display:flex;flex-direction:column;gap:10px}
.dshMacToolsMonitorAlertGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.dshMacToolsMonitorField{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshMacToolsMonitorFieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshMacToolsMonitorFieldInput{box-sizing:border-box;width:100%;height:30px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;font:inherit;font-size:13px;line-height:19px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorFieldInput:focus{border-color:var(--dsw-alias-state-business-primary)}
.dshMacToolsMonitorSwitchRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshMacToolsMonitorSwitch{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshMacToolsMonitorSwitchOn{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary)}
.dshMacToolsMonitorSwitchDot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dshMacToolsMonitorSwitchOn .dshMacToolsMonitorSwitchDot{background:var(--dsw-alias-state-business-primary)}
.dshMacToolsMonitorAlertActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshMacToolsMonitorAlertNotice{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshMacToolsMonitorAlertError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dshMacToolsMonitorEventList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none}
.dshMacToolsMonitorEventRow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:5px 8px;border-radius:8px;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshMacToolsMonitorEventRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshMacToolsMonitorEventMetric{color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap}
.dshMacToolsMonitorEventDetail{color:var(--dsw-alias-label-tertiary)}
.dshMacToolsMonitorEventTime{margin-left:auto;color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;white-space:nowrap}
.dshMacToolsMonitorSkeleton{height:220px}
.dshMacToolsMonitorEmpty{margin:0;padding:14px 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
@media (max-width:760px){
.dshMacToolsContent{padding:0 20px 32px}
.dshMacToolsHeading{padding-top:20px;align-items:flex-start;flex-wrap:wrap}
.dshMacToolsHeadingRight{max-width:100%}
.dshMacToolsToolLabel{display:none}
.dshMacToolsCalc{max-width:none}
.dshMacToolsCanvasStage{padding:8px}
.dshMacToolsEditorHint{display:none}
.dshMacToolsTransferColumns{grid-template-columns:minmax(0,1fr)}
.dshMacToolsTransferQrRow{gap:12px}
.dshMacToolsMonitorOverview{grid-template-columns:minmax(0,1fr)}
.dshMacToolsMonitorProcessRow{grid-template-columns:minmax(0,1fr) 54px 54px auto}
.dshMacToolsMonitorProcessValueRss{display:none}
}
@media (prefers-reduced-motion:reduce){
.dshMacToolsPage *,.dshMacToolsToast,.dshMacToolsTextInput{animation:none!important;transition:none!important}
}
`

    /** The `<style>` element id, so a second materialization cannot double-inject. */
    const STYLE_ID = `${NS}/panel.css`

    /**
     * Inject the stylesheet once. Called inside an effect, so unloading the
     * plugin removes what it added.
     *
     * @returns {() => void} the cleanup.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // ---------------------------------------------------------------------
    // Annotation palette and canvas engine
    // ---------------------------------------------------------------------

    /**
     * The fixed annotation palette. These are artwork values, not chrome: the
     * shell's theme tokens style the surrounding controls, while the marks the
     * operator draws keep their own colors so a screenshot looks the same in
     * light and dark themes.
     */
    const COLORS = [
      { value: '#ff3b30', key: 'color.red' },
      { value: '#ffcc00', key: 'color.orange' },
      { value: '#0a84ff', key: 'color.blue' },
      { value: '#34c759', key: 'color.green' },
      { value: '#ffffff', key: 'color.white' },
      { value: '#1c1c1e', key: 'color.black' },
    ]
    /** Display-pixel stroke widths, scaled to natural pixels when committed. */
    const STROKE_WIDTHS = [
      { value: 3, key: 'width.thin', sample: 1 },
      { value: 6, key: 'width.medium', sample: 2 },
      { value: 10, key: 'width.thick', sample: 3 },
    ]
    /** The tool strip, in render order. */
    const TOOLS = ['crop', 'arrow', 'rect', 'ellipse', 'pen', 'text', 'mosaic', 'highlight']
    /** Tool id -> locale key. */
    const TOOL_KEYS = {
      crop: 'tool.crop',
      arrow: 'tool.arrow',
      rect: 'tool.rect',
      ellipse: 'tool.ellipse',
      pen: 'tool.pen',
      text: 'tool.text',
      mosaic: 'tool.mosaic',
      highlight: 'tool.highlight',
    }
    /** Capture mode -> locale key (the Host reports the mode it used). */
    const MODE_KEYS = {
      interactive: 'mode.interactive',
      'interactive-region': 'mode.interactive-region',
      'interactive-window': 'mode.interactive-window',
      full: 'mode.full',
      window: 'mode.window',
      app: 'mode.app',
      frontmost: 'mode.frontmost',
      rect: 'mode.rect',
    }
    /** The highlight tool is a fixed translucent yellow, as specified. */
    const HIGHLIGHT_COLOR = '#ffcc00'
    const HIGHLIGHT_ALPHA = 0.35
    /** Mosaic blocks are measured in natural pixels, not display pixels. */
    const MOSAIC_BLOCK = 12
    /** Text is authored at this display size and scaled to natural pixels. */
    const TEXT_DISPLAY_SIZE = 18
    const TEXT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif'
    /** Keyboard shortcut defaults, shared by both registrations. */
    const SHORTCUT_TOGGLE = 'mac-tools.toggle'
    const SHORTCUT_SHOT = 'mac-tools.screenshot'

    /** @returns {object} a fresh annotation history. */
    function emptyAnnotations() {
      return { ops: [], past: [], future: [] }
    }

    /**
     * Keep a number inside a range.
     *
     * @param {number} value - the candidate.
     * @param {number} min - the lower bound.
     * @param {number} max - the upper bound.
     * @returns {number} the clamped value.
     */
    function clampNumber(value, min, max) {
      if (!Number.isFinite(value)) return min
      return Math.min(max, Math.max(min, value))
    }

    /**
     * Turn two drag points into an upright rectangle.
     *
     * @param {{x:number,y:number}} from - one corner.
     * @param {{x:number,y:number}} to - the other corner.
     * @returns {{x:number,y:number,w:number,h:number}} the rectangle.
     */
    function rectFromPoints(from, to) {
      const x = Math.min(from.x, to.x)
      const y = Math.min(from.y, to.y)
      return { x, y, w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) }
    }

    /**
     * Whether a committed op is big enough to be visible, so a stray click does
     * not leave an invisible entry in the undo history.
     *
     * @param {object} op - the pending annotation op.
     * @returns {boolean} whether to commit it.
     */
    function isSubstantialOp(op) {
      if (op.type === 'text') return String(op.text || '').trim() !== ''
      if (op.type === 'pen' || op.type === 'highlight') return Array.isArray(op.points) && op.points.length >= 2
      const rect = rectFromPoints(op.from, op.to)
      const reach = Math.max(rect.w, rect.h)
      return reach >= Math.max(4, (op.width || 1) * 0.8)
    }

    /**
     * Draw an arrow: a shaft and a filled head, all in natural pixels.
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {{from:object,to:object,color:string,width:number}} op - the op.
     * @returns {void}
     */
    function drawArrow(ctx, op) {
      const dx = op.to.x - op.from.x
      const dy = op.to.y - op.from.y
      const length = Math.hypot(dx, dy)
      if (length < 0.5) return
      const angle = Math.atan2(dy, dx)
      const headLength = Math.min(Math.max(12, op.width * 3.4), length * 0.5)
      const headWidth = headLength * 0.62
      const baseX = op.to.x - Math.cos(angle) * headLength
      const baseY = op.to.y - Math.sin(angle) * headLength
      ctx.save()
      ctx.strokeStyle = op.color
      ctx.fillStyle = op.color
      ctx.lineWidth = op.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(op.from.x, op.from.y)
      ctx.lineTo(baseX, baseY)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(op.to.x, op.to.y)
      ctx.lineTo(
        baseX + Math.cos(angle + Math.PI / 2) * headWidth,
        baseY + Math.sin(angle + Math.PI / 2) * headWidth,
      )
      ctx.lineTo(
        baseX + Math.cos(angle - Math.PI / 2) * headWidth,
        baseY + Math.sin(angle - Math.PI / 2) * headWidth,
      )
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    /**
     * Draw a stroked rectangle.
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {{from:object,to:object,color:string,width:number}} op - the op.
     * @returns {void}
     */
    function drawRectShape(ctx, op) {
      const rect = rectFromPoints(op.from, op.to)
      if (rect.w < 0.5 || rect.h < 0.5) return
      ctx.save()
      ctx.strokeStyle = op.color
      ctx.lineWidth = op.width
      ctx.lineJoin = 'round'
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      ctx.restore()
    }

    /**
     * Draw a stroked ellipse inscribed in the drag rectangle.
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {{from:object,to:object,color:string,width:number}} op - the op.
     * @returns {void}
     */
    function drawEllipseShape(ctx, op) {
      const rect = rectFromPoints(op.from, op.to)
      if (rect.w < 0.5 || rect.h < 0.5) return
      ctx.save()
      ctx.strokeStyle = op.color
      ctx.lineWidth = op.width
      ctx.beginPath()
      ctx.ellipse(
        rect.x + rect.w / 2,
        rect.y + rect.h / 2,
        Math.max(rect.w / 2, 0.5),
        Math.max(rect.h / 2, 0.5),
        0, 0, Math.PI * 2,
      )
      ctx.stroke()
      ctx.restore()
    }

    /**
     * Draw a freehand polyline (pen, or the translucent highlight).
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {Array<{x:number,y:number}>} points - the collected points.
     * @param {string} color - stroke color.
     * @param {number} width - stroke width in natural pixels.
     * @param {number} alpha - stroke alpha.
     * @returns {void}
     */
    function drawPolyline(ctx, points, color, width, alpha) {
      if (!Array.isArray(points) || points.length === 0) return
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y)
      for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y)
      ctx.stroke()
      ctx.restore()
    }

    /**
     * Draw a text annotation, with the size already converted to natural pixels.
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {{text:string,color:string,size:number,x:number,y:number}} op - the op.
     * @returns {void}
     */
    function drawTextOp(ctx, op) {
      const text = String(op.text || '')
      if (text === '') return
      ctx.save()
      ctx.fillStyle = op.color
      ctx.textBaseline = 'top'
      ctx.font = `600 ${Math.max(8, op.size)}px ${TEXT_FONT_FAMILY}`
      ctx.fillText(text, op.x, op.y)
      ctx.restore()
    }

    /**
     * Pixelate a rectangle of the *base* image in ~12x12 natural-pixel blocks,
     * recomputed from the base image on every redraw as the contract requires.
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {HTMLCanvasElement} base - the untouched captured image.
     * @param {{from:object,to:object}} op - the op.
     * @returns {void}
     */
    function drawMosaicOp(ctx, base, op) {
      if (base === null || base === undefined || typeof base.getContext !== 'function') return
      const rect = rectFromPoints(op.from, op.to)
      if (rect.w < 1 || rect.h < 1) return
      const x0 = Math.max(0, Math.floor(rect.x / MOSAIC_BLOCK) * MOSAIC_BLOCK)
      const y0 = Math.max(0, Math.floor(rect.y / MOSAIC_BLOCK) * MOSAIC_BLOCK)
      const x1 = Math.min(base.width, Math.ceil((rect.x + rect.w) / MOSAIC_BLOCK) * MOSAIC_BLOCK)
      const y1 = Math.min(base.height, Math.ceil((rect.y + rect.h) / MOSAIC_BLOCK) * MOSAIC_BLOCK)
      const blockWidth = x1 - x0
      const blockHeight = y1 - y0
      if (blockWidth <= 0 || blockHeight <= 0) return
      const baseContext = base.getContext('2d')
      if (!baseContext) return
      let pixels
      try {
        pixels = baseContext.getImageData(x0, y0, blockWidth, blockHeight).data
      } catch (error) {
        // A tainted or detached canvas cannot be sampled; skip this op rather
        // than blanking the whole editor.
        return
      }
      ctx.save()
      for (let by = 0; by < blockHeight; by += MOSAIC_BLOCK) {
        const cellHeight = Math.min(MOSAIC_BLOCK, blockHeight - by)
        for (let bx = 0; bx < blockWidth; bx += MOSAIC_BLOCK) {
          const cellWidth = Math.min(MOSAIC_BLOCK, blockWidth - bx)
          let red = 0
          let green = 0
          let blue = 0
          let alpha = 0
          let count = 0
          for (let py = 0; py < cellHeight; py += 1) {
            let offset = ((by + py) * blockWidth + bx) * 4
            for (let px = 0; px < cellWidth; px += 1) {
              red += pixels[offset]
              green += pixels[offset + 1]
              blue += pixels[offset + 2]
              alpha += pixels[offset + 3]
              offset += 4
              count += 1
            }
          }
          if (count === 0) continue
          ctx.fillStyle = `rgba(${Math.round(red / count)}, ${Math.round(green / count)}, ${Math.round(blue / count)}, ${(alpha / count / 255).toFixed(3)})`
          ctx.fillRect(x0 + bx, y0 + by, cellWidth, cellHeight)
        }
      }
      ctx.restore()
    }

    /**
     * Draw one committed (or in-progress) annotation.
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {HTMLCanvasElement} base - the untouched captured image, for mosaic sampling.
     * @param {object} op - the annotation.
     * @returns {void}
     */
    function drawAnnotation(ctx, base, op) {
      if (op === null || typeof op !== 'object') return
      switch (op.type) {
        case 'arrow':
          drawArrow(ctx, op)
          break
        case 'rect':
          drawRectShape(ctx, op)
          break
        case 'ellipse':
          drawEllipseShape(ctx, op)
          break
        case 'pen':
          drawPolyline(ctx, op.points, op.color, op.width, 1)
          break
        case 'highlight':
          drawPolyline(ctx, op.points, HIGHLIGHT_COLOR, Math.max(12, op.width * 2.5), HIGHLIGHT_ALPHA)
          break
        case 'text':
          drawTextOp(ctx, op)
          break
        case 'mosaic':
          drawMosaicOp(ctx, base, op)
          break
        default:
          break
      }
    }

    /**
     * Dim everything outside the pending crop rectangle and outline what remains.
     *
     * @param {CanvasRenderingContext2D} ctx - the target context.
     * @param {{x:number,y:number,w:number,h:number}} rect - the crop rectangle.
     * @param {HTMLCanvasElement} canvas - the canvas being painted.
     * @returns {void}
     */
    function drawCropOverlay(ctx, rect, canvas) {
      const x = clampNumber(rect.x, 0, canvas.width)
      const y = clampNumber(rect.y, 0, canvas.height)
      const width = clampNumber(rect.w, 0, canvas.width - x)
      const height = clampNumber(rect.h, 0, canvas.height - y)
      ctx.save()
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
      ctx.fillRect(0, 0, canvas.width, y)
      ctx.fillRect(0, y + height, canvas.width, canvas.height - (y + height))
      ctx.fillRect(0, y, x, height)
      ctx.fillRect(x + width, y, canvas.width - (x + width), height)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 800))
      ctx.setLineDash([9, 5])
      ctx.strokeRect(x, y, width, height)
      ctx.setLineDash([])
      ctx.restore()
    }

    /**
     * Repaint the visible canvas from the base image, committed ops, the
     * in-progress op and the optional crop overlay. The backing store stays at
     * the capture's natural size; only CSS scales it for display.
     *
     * @param {HTMLCanvasElement|null} canvas - the visible canvas.
     * @param {HTMLCanvasElement|null} base - the captured image canvas.
     * @param {Array<object>} ops - committed annotations.
     * @param {object|null} draft - the in-progress annotation.
     * @param {{x:number,y:number,w:number,h:number}|null} crop - the pending crop.
     * @returns {void}
     */
    function paintCanvas(canvas, base, ops, draft, crop) {
      if (canvas === null || canvas === undefined || typeof canvas.getContext !== 'function') return
      if (base === null || base === undefined) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(base, 0, 0)
      for (let index = 0; index < ops.length; index += 1) drawAnnotation(ctx, base, ops[index])
      if (draft !== null && draft !== undefined) drawAnnotation(ctx, base, draft)
      ctx.restore()
      if (crop !== null && crop !== undefined) drawCropOverlay(ctx, crop, canvas)
    }

    /**
     * Flatten the base image and its annotations into a fresh canvas at natural
     * size. Used for export, and as the source of a crop.
     *
     * @param {HTMLCanvasElement} base - the captured image canvas.
     * @param {Array<object>} ops - committed annotations.
     * @returns {HTMLCanvasElement|null} the composite canvas.
     */
    function flattenComposite(base, ops) {
      if (base === null || typeof document === 'undefined') return null
      const canvas = document.createElement('canvas')
      canvas.width = base.width
      canvas.height = base.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(base, 0, 0)
      for (let index = 0; index < ops.length; index += 1) drawAnnotation(ctx, base, ops[index])
      return canvas
    }

    /**
     * Copy a rectangle out of a canvas into a new canvas.
     *
     * @param {HTMLCanvasElement} source - the composite canvas.
     * @param {{x:number,y:number,w:number,h:number}} rect - the retained area.
     * @returns {HTMLCanvasElement|null} the cropped canvas.
     */
    function cropComposite(source, rect) {
      if (source === null || typeof document === 'undefined') return null
      const width = Math.max(1, Math.round(rect.w))
      const height = Math.max(1, Math.round(rect.h))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(source, -Math.round(rect.x), -Math.round(rect.y))
      return canvas
    }

    /**
     * Encode a canvas as raw base64 PNG payload data.
     *
     * @param {HTMLCanvasElement} canvas - the composite canvas.
     * @returns {string} the base64 payload (no `data:` prefix).
     */
    function canvasToBase64(canvas) {
      const dataUrl = canvas.toDataURL('image/png')
      const parts = dataUrl.split(',')
      return parts.length > 1 ? parts[1] : ''
    }

    /**
     * Convert a pointer event to natural canvas pixels.
     *
     * The canvas backing store is the capture's natural size while CSS scales it
     * for display, so the mapping divides by the element's bounding rect. This
     * deliberately does not use the device pixel ratio.
     *
     * @param {HTMLCanvasElement} canvas - the visible canvas.
     * @param {{clientX:number,clientY:number}} event - the pointer event.
     * @returns {{x:number,y:number}} the natural-pixel point.
     */
    function canvasPoint(canvas, event) {
      const rect = canvas.getBoundingClientRect()
      const scaleX = canvas.width / Math.max(1, rect.width)
      const scaleY = canvas.height / Math.max(1, rect.height)
      return {
        x: clampNumber((event.clientX - rect.left) * scaleX, 0, canvas.width),
        y: clampNumber((event.clientY - rect.top) * scaleY, 0, canvas.height),
      }
    }

    // ---------------------------------------------------------------------
    // Formatting and error copy
    // ---------------------------------------------------------------------

    /**
     * Format a byte count as GB with one decimal, per the panel spec.
     *
     * @param {number} bytes - the byte count.
     * @returns {string} the formatted size.
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    }

    /**
     * Format a 0–100 percentage for display.
     *
     * @param {number} percent - the percentage.
     * @returns {string} the rounded percentage.
     */
    function formatPercent(percent) {
      return String(clampNumber(Math.round(percent), 0, 100))
    }

    /**
     * Format a duration such as uptime or remaining battery time.
     *
     * @param {Function} t - the bound translator.
     * @param {number} totalSeconds - the duration in seconds.
     * @returns {string} e.g. "3 天 4 小时 5 分".
     */
    function durationText(t, totalSeconds) {
      const seconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0))
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const parts = []
      if (days > 0) parts.push(t('duration.day', { n: days }))
      if (hours > 0) parts.push(t('duration.hour', { n: hours }))
      if (minutes > 0) parts.push(t('duration.minute', { n: minutes }))
      if (parts.length === 0) parts.push(t('duration.second', { n: seconds % 60 }))
      return parts.join(' ')
    }

    /**
     * Format a timestamp for display, falling back to the raw value.
     *
     * @param {number|string} value - epoch milliseconds or an ISO string.
     * @returns {string} a locale string.
     */
    function formatDateTime(value) {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
    }

    /**
     * The localized label of the mode a shot was captured with.
     *
     * @param {Function} t - the bound translator.
     * @param {object} shot - the shot record.
     * @returns {string} the label.
     */
    function modeText(t, shot) {
      const mode = shot && typeof shot.mode === 'string' ? shot.mode : ''
      if (mode === 'display') return t('mode.display', { display: shot.display || 1 })
      return t(MODE_KEYS[mode] || 'mode.unknown')
    }

    /**
     * Localize a Host envelope failure, preferring the transport story when the
     * Host half is not on this page at all.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @param {string} fallbackKey - the endpoint family's generic message.
     * @returns {string} the localized message.
     */
    function hostErrorText(t, error, fallbackKey) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      const details = error && error.details && typeof error.details === 'object' ? error.details : {}
      if (code === 'host_missing') return t('host.missing', { status: details.http || 404 })
      if (code === 'host_unreachable') return t('host.unreachable', { message: error.message || '' })
      return t(fallbackKey, { message: error && error.message ? error.message : '', code })
    }

    /**
     * Localize a failed capture. `cancelled` never reaches this function — the
     * store treats it as a normal outcome.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function captureErrorText(t, error) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      if (code === 'busy') return t('capture.error.busy')
      if (code === 'no_window') return t('capture.error.no_window')
      if (code === 'permission') return t('capture.error.permission')
      if (code === 'timeout') return t('capture.error.timeout')
      if (code === 'capture_failed') return t('capture.error.capture_failed', { message: error.message || '' })
      if (code === 'invalid_request') return t('capture.error.invalid_request')
      if (code === 'host_missing' || code === 'host_unreachable') return hostErrorText(t, error, 'capture.error.generic')
      return t('capture.error.generic', { code: code || 'capture_failed', message: error && error.message ? error.message : '' })
    }

    /**
     * Localize a failed calculator request.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function calcErrorText(t, error) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      const message = error && error.message ? error.message : ''
      if (code === 'invalid_expression') return t('calc.error.invalid_expression')
      if (code === 'unknown_identifier') return t('calc.error.unknown_identifier', { message })
      if (code === 'unknown_function') return t('calc.error.unknown_function', { message })
      if (code === 'divide_by_zero') return t('calc.error.divide_by_zero')
      if (code === 'domain_error') return t('calc.error.domain_error', { message })
      if (code === 'too_long') return t('calc.error.too_long')
      if (code === 'host_missing' || code === 'host_unreachable') return hostErrorText(t, error, 'calc.error.generic')
      return t('calc.error.generic', { message })
    }

    /**
     * Localize a failed copy/save/reveal action.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function actionErrorText(t, error) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      const message = error && error.message ? error.message : ''
      const details = error && error.details && typeof error.details === 'object' ? error.details : {}
      if (code === 'too_large') {
        const megabytes = Number.isFinite(details.limit) ? Math.max(1, Math.round(details.limit / (1024 * 1024))) : 20
        return t('editor.error.tooLarge', { megabytes })
      }
      if (code === 'save_failed') return t('editor.error.saveFailed', { message })
      if (code === 'not_found') return t('editor.error.notFound')
      if (code === 'unknown_endpoint') return t('editor.error.outdated')
      return hostErrorText(t, error, 'editor.error')
    }

    /**
     * Localize a failed phone-transfer request. The Host reports the documented
     * transfer codes on success paths and the normalized transport codes when
     * the Host half itself is missing, so both families are covered here.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function transferErrorText(t, error) {
      const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
      const message = error !== null && error !== undefined && error.message ? error.message : ''
      if (code === 'unsupported') return t('transfer.error.unsupported')
      if (code === 'not_found') return t('transfer.error.not_found')
      if (code === 'invalid_request') return t('transfer.error.invalid_request')
      if (code === 'too_large') return t('transfer.error.too_large')
      if (code === 'io_error') return t('transfer.error.io_error', { message })
      if (code === 'port_unavailable') return t('transfer.error.port_unavailable')
      if (code === 'not_active') return t('transfer.error.not_active')
      if (code === 'host_missing' || code === 'host_unreachable') return hostErrorText(t, error, 'transfer.error.generic')
      return t('transfer.error.generic', { code: code || 'io_error', message })
    }

    /**
     * Format a byte count for one transfer row (B / KB / MB / GB).
     *
     * @param {number} bytes - the byte count.
     * @returns {string} the formatted size.
     */
    function transferSizeText(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${Math.round(bytes)} B`
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1)
      return `${rounded} ${units[unit]}`
    }

    /**
     * Format the remaining session time as a locally ticking clock.
     *
     * @param {Function} t - the bound translator.
     * @param {string|null} expiresAt - the session expiry as an ISO string.
     * @param {number} now - the local clock in epoch milliseconds.
     * @returns {string} the countdown, or an empty string when unknown.
     */
    function transferCountdownText(t, expiresAt, now) {
      const stamp = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN
      if (!Number.isFinite(stamp)) return ''
      const remaining = stamp - now
      if (remaining <= 0) return t('transfer.expired')
      const total = Math.ceil(remaining / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const pad = (value) => (value < 10 ? `0${value}` : String(value))
      const clock = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
      return t('transfer.remaining', { duration: clock })
    }

    /**
     * The type tag of one transfer item.
     *
     * @param {Function} t - the bound translator.
     * @param {string} kind - `text`, `file` or `history`.
     * @returns {string} the localized tag.
     */
    function transferKindLabel(t, kind) {
      if (kind === 'text') return t('transfer.kind.text')
      if (kind === 'history') return t('transfer.kind.history')
      return t('transfer.kind.file')
    }

    /**
     * Clamp a text item to a readable preview. Text items may be up to 64 KiB
     * each and the inbox keeps 200 of them, so the list never puts the whole
     * body in the DOM.
     *
     * @param {string} text - the item text.
     * @returns {string} the preview.
     */
    function transferPreviewText(text) {
      const value = String(text)
      return value.length > 240 ? `${value.slice(0, 240)}…` : value
    }

    /**
     * Localize one transfer toast. `text` holds the success locale key; a
     * failure carries the normalized error instead, so the store never needs
     * the locale service.
     *
     * @param {Function} t - the bound translator.
     * @param {object} toast - the store's toast value.
     * @returns {string} the toast text.
     */
    function transferToastText(t, toast) {
      if (toast === null || toast === undefined) return ''
      if (toast.error !== null && toast.error !== undefined) return transferErrorText(t, toast.error)
      return t(toast.text, toast.params)
    }

    // ---------------------------------------------------------------------
    // Monitor formatting and copy
    // ---------------------------------------------------------------------

    /**
     * Reduce a failure to the three fields the monitor copy needs.
     *
     * @param {any} error - a classified failure.
     * @returns {{ code: string, message: string, details: object }} the parts.
     */
    function monitorErrorParts(error) {
      const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
      const message = error !== null && error !== undefined && error.message ? String(error.message) : ''
      const details = error !== null && error !== undefined && error.details !== null && typeof error === 'object' && typeof error.details === 'object'
        ? error.details
        : {}
      return { code, message, details }
    }

    /**
     * Format a byte count for a monitor card (B / KB / MB / GB).
     *
     * @param {number} bytes - the byte count.
     * @returns {string} the formatted size.
     */
    function monitorSizeText(bytes) {
      return transferSizeText(bytes)
    }

    /**
     * Format a per-second byte rate as B/s, KB/s, MB/s or GB/s.
     *
     * @param {number} bytesPerSecond - the rate.
     * @returns {string} the formatted rate.
     */
    function monitorRateText(bytesPerSecond) {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '—'
      if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
      const units = ['KB/s', 'MB/s', 'GB/s']
      let value = bytesPerSecond / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const rounded = value >= 100 ? String(Math.round(value)) : value.toFixed(1)
      return `${rounded} ${units[unit]}`
    }

    /**
     * Format an SMC temperature.
     *
     * @param {number|null} value - degrees celsius.
     * @returns {string} e.g. "72.3 °C", or an em dash when unavailable.
     */
    function monitorCelsiusText(value) {
      if (!Number.isFinite(value)) return '—'
      return `${value.toFixed(1)} °C`
    }

    /**
     * Format a fan speed.
     *
     * @param {number|null} value - revolutions per minute.
     * @returns {string} e.g. "2220 RPM".
     */
    function monitorRpmText(value) {
      return Number.isFinite(value) ? `${Math.round(value)} RPM` : '—'
    }

    /**
     * Localize the SMC availability reason.
     *
     * @param {Function} t - the bound translator.
     * @param {string|null} reason - the Host's reason code.
     * @returns {string} the localized message.
     */
    function monitorSensorReasonText(t, reason) {
      const value = typeof reason === 'string' ? reason : ''
      const key = MONITOR_SENSOR_REASON_KEYS[value]
      if (key !== undefined) return t(key)
      return t('monitor.sensors.reason.generic', { reason: value === '' ? t('monitor.unknown') : value })
    }

    /**
     * Localize a fan-control state reason.
     *
     * @param {Function} t - the bound translator.
     * @param {string|null} reason - the Host's reason code.
     * @param {string|null} [message] - the Host's optional diagnostic.
     * @returns {string} the localized message.
     */
    function monitorFanReasonText(t, reason, message) {
      const value = typeof reason === 'string' ? reason : ''
      const key = MONITOR_FAN_REASON_KEYS[value]
      const detail = typeof message === 'string' && message !== '' ? message : ''
      if (key !== undefined) return t(key, { message: detail })
      return t('monitor.fan.reason.generic', { reason: value === '' ? t('monitor.unknown') : value })
    }

    /**
     * Localize a failed snapshot poll.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function monitorErrorText(t, error) {
      const { code, message } = monitorErrorParts(error)
      if (code === 'host_missing' || code === 'host_unreachable') return hostErrorText(t, error, 'monitor.error.generic')
      return t('monitor.error.generic', { message: message !== '' ? message : code })
    }

    /**
     * Localize a failed process request.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function monitorProcessErrorText(t, error) {
      const { code, message } = monitorErrorParts(error)
      if (code === 'kill_invalid_pid') return t('monitor.processes.error.kill_invalid_pid')
      if (code === 'kill_not_found') return t('monitor.processes.error.kill_not_found')
      if (code === 'kill_denied') return t('monitor.processes.error.kill_denied')
      if (code === 'host_missing' || code === 'host_unreachable') return hostErrorText(t, error, 'monitor.processes.error.generic')
      return t('monitor.processes.error.generic', { code: code === '' ? 'unknown' : code, message })
    }

    /**
     * Localize a failed fan request. A reason carried in `details.reason` wins
     * over the generic code, because the Host reports daemon refusals that way.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function monitorFanErrorText(t, error) {
      const { code, message, details } = monitorErrorParts(error)
      if (code === 'fan_not_ready') return t('monitor.fan.error.fan_not_ready')
      if (code === 'fan_apply_failed') return t('monitor.fan.error.fan_apply_failed', { message })
      if (typeof details.reason === 'string' && MONITOR_FAN_REASON_KEYS[details.reason] !== undefined) {
        return monitorFanReasonText(t, details.reason, message)
      }
      if (code === 'host_missing' || code === 'host_unreachable') return hostErrorText(t, error, 'monitor.fan.error.generic')
      return t('monitor.fan.error.generic', { code: code === '' ? 'unknown' : code, message })
    }

    /**
     * Localize a failed alert request.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - a classified failure.
     * @returns {string} the localized message.
     */
    function monitorAlertErrorText(t, error) {
      const { code, message } = monitorErrorParts(error)
      if (code === 'host_missing' || code === 'host_unreachable') return hostErrorText(t, error, 'monitor.alerts.error.generic')
      return t('monitor.alerts.error.generic', { code: code === '' ? 'unknown' : code, message })
    }

    /**
     * The localized label of a temperature group id.
     *
     * @param {Function} t - the bound translator.
     * @param {string} groupId - e.g. "cpuPerformance".
     * @returns {string} the label.
     */
    function monitorSensorGroupLabel(t, groupId) {
      const key = MONITOR_SENSOR_GROUP_KEYS[groupId]
      return key === undefined ? String(groupId) : t(key)
    }

    /**
     * Group raw SMC readings by their key family (the first two characters),
     * sort each family by temperature desc and the families by their hottest
     * member, per the contract.
     *
     * @param {Array<object>} readings - `{ key, celsius }` entries.
     * @returns {Array<{ family: string, readings: object[] }>} the groups.
     */
    function monitorSensorFamilies(readings) {
      const list = Array.isArray(readings) ? readings : []
      const families = new Map()
      for (let index = 0; index < list.length; index += 1) {
        const reading = list[index]
        if (reading === null || typeof reading !== 'object') continue
        if (typeof reading.key !== 'string' || !Number.isFinite(reading.celsius)) continue
        const family = reading.key.slice(0, 2)
        let bucket = families.get(family)
        if (bucket === undefined) {
          bucket = { family, readings: [] }
          families.set(family, bucket)
        }
        bucket.readings.push(reading)
      }
      const result = [...families.values()]
      for (let index = 0; index < result.length; index += 1) {
        result[index].readings.sort((left, right) => right.celsius - left.celsius)
      }
      result.sort((left, right) => right.readings[0].celsius - left.readings[0].celsius)
      return result
    }

    /**
     * Build a sparkline line (and matching area) path for one series.
     * Non-finite values are skipped, so a null temperature point leaves a gap.
     *
     * @param {Array<{value:number}>} series - history entries oldest → newest.
     * @param {number} min - the domain lower bound.
     * @param {number} max - the domain upper bound.
     * @param {number} width - the viewBox width.
     * @param {number} height - the viewBox height.
     * @returns {{ line: string, area: string }} the SVG paths.
     */
    function monitorSparklineGeometry(series, min, max, width, height) {
      const list = Array.isArray(series) ? series : []
      const coords = []
      for (let index = 0; index < list.length; index += 1) {
        const point = list[index]
        if (point === null || typeof point !== 'object' || !Number.isFinite(point.value)) continue
        const ratio = clampNumber((point.value - min) / (max - min), 0, 1)
        coords.push({
          x: list.length > 1 ? (index / (list.length - 1)) * width : width / 2,
          y: height - ratio * height,
        })
      }
      if (coords.length === 0) return { line: '', area: '' }
      const line = coords
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join(' ')
      if (coords.length === 1) return { line, area: '' }
      const first = coords[0]
      const last = coords[coords.length - 1]
      const area = `${line} L${last.x.toFixed(2)},${height} L${first.x.toFixed(2)},${height} Z`
      return { line, area }
    }

    /**
     * The shared domain for a multi-series sparkline.
     *
     * @param {Array<Array<{value:number}>>} seriesList - the series.
     * @param {number} [fixedMin] - a domain lower bound to keep.
     * @param {number} [fixedMax] - a domain upper bound to keep.
     * @returns {{ min: number, max: number }} the domain.
     */
    function monitorSeriesBounds(seriesList, fixedMin, fixedMax) {
      let min = Number.isFinite(fixedMin) ? fixedMin : Number.POSITIVE_INFINITY
      let max = Number.isFinite(fixedMax) ? fixedMax : Number.NEGATIVE_INFINITY
      const list = Array.isArray(seriesList) ? seriesList : []
      for (let seriesIndex = 0; seriesIndex < list.length; seriesIndex += 1) {
        const series = Array.isArray(list[seriesIndex]) ? list[seriesIndex] : []
        for (let pointIndex = 0; pointIndex < series.length; pointIndex += 1) {
          const point = series[pointIndex]
          if (point === null || typeof point !== 'object' || !Number.isFinite(point.value)) continue
          if (!Number.isFinite(fixedMin)) min = Math.min(min, point.value)
          if (!Number.isFinite(fixedMax)) max = Math.max(max, point.value)
        }
      }
      if (!Number.isFinite(min)) min = 0
      if (!Number.isFinite(max)) max = min + 1
      if (!(max > min)) max = min + 1
      return { min, max }
    }

    /**
     * The memory breakdown bar's segments. The detailed app/wired/compressed/
     * cached split is preferred; when the Host reports all four as zero the
     * bar falls back to used vs available so the card is still meaningful.
     *
     * @param {object} memory - the sample's memory block.
     * @returns {Array<{ key: string, labelKey: string|null, bytes: number, percent: number, color: string }>} the segments.
     */
    function monitorMemorySegments(memory) {
      const block = memory !== null && typeof memory === 'object' ? memory : {}
      const total = Number.isFinite(block.totalBytes) && block.totalBytes > 0 ? block.totalBytes : 0
      const detailed = [
        { key: 'app', labelKey: 'monitor.memory.app', bytes: block.appBytes, color: MONITOR_SERIES_COLORS.memoryApp },
        { key: 'wired', labelKey: 'monitor.memory.wired', bytes: block.wiredBytes, color: MONITOR_SERIES_COLORS.memoryWired },
        { key: 'compressed', labelKey: 'monitor.memory.compressed', bytes: block.compressedBytes, color: MONITOR_SERIES_COLORS.memoryCompressed },
        { key: 'cached', labelKey: 'monitor.memory.cached', bytes: block.cachedBytes, color: MONITOR_SERIES_COLORS.memoryCached },
      ].filter((segment) => Number.isFinite(segment.bytes) && segment.bytes > 0)
      if (total > 0 && detailed.length > 0) {
        let assignedBytes = 0
        let assignedPercent = 0
        const segments = detailed.map((segment) => {
          const percent = clampNumber((segment.bytes / total) * 100, 0, 100)
          assignedBytes += segment.bytes
          assignedPercent += percent
          return {
            key: segment.key,
            labelKey: segment.labelKey,
            bytes: segment.bytes,
            percent,
            color: segment.color,
          }
        })
        const restPercent = Math.max(0, 100 - assignedPercent)
        if (restPercent > 0.05) {
          segments.push({
            key: 'free',
            labelKey: 'monitor.memory.free',
            bytes: Math.max(0, total - assignedBytes),
            percent: restPercent,
            color: MONITOR_SERIES_COLORS.memoryFree,
          })
        }
        return segments
      }
      const used = Number.isFinite(block.usedBytes) ? block.usedBytes : NaN
      const available = Number.isFinite(block.availableBytes) ? block.availableBytes : NaN
      if (Number.isFinite(used) && Number.isFinite(available) && used + available > 0) {
        const sum = used + available
        return [
          { key: 'used', labelKey: null, bytes: used, percent: (used / sum) * 100, color: MONITOR_SERIES_COLORS.memoryApp },
          { key: 'free', labelKey: 'monitor.memory.free', bytes: available, percent: (available / sum) * 100, color: MONITOR_SERIES_COLORS.memoryFree },
        ]
      }
      return []
    }

    /**
     * Localize the memory-pressure badge.
     *
     * @param {Function} t - the bound translator.
     * @param {string|null} pressure - "normal" | "warning" | "critical".
     * @returns {{ label: string, className: string }} the badge.
     */
    function monitorPressureInfo(t, pressure) {
      if (pressure === 'normal' || pressure === 'warning' || pressure === 'critical') {
        const suffix = pressure.charAt(0).toUpperCase() + pressure.slice(1)
        return {
          label: t(`monitor.memory.pressure.${pressure}`),
          className: `dshMacToolsMonitorPressure dshMacToolsMonitorPressure${suffix}`,
        }
      }
      return { label: t('monitor.memory.pressure.unknown'), className: 'dshMacToolsMonitorPressure' }
    }

    /**
     * The localized name of one fan preset. Built-ins localize by their fixed
     * id; custom presets carry the user's name.
     *
     * @param {Function} t - the bound translator.
     * @param {object} preset - the preset block.
     * @returns {string} the label.
     */
    function monitorPresetLabel(t, preset) {
      if (preset === null || typeof preset !== 'object') return t('monitor.fan.preset.custom')
      const id = typeof preset.id === 'string' ? preset.id : ''
      if (preset.builtin === true && MONITOR_BUILTIN_PRESETS.indexOf(id) >= 0) return t(`monitor.fan.preset.${id}`)
      if (typeof preset.name === 'string' && preset.name !== '') return preset.name
      return t('monitor.fan.preset.custom')
    }

    /**
     * Whether a preset describes the fan state currently applied by the Host.
     *
     * @param {object} preset - the preset block.
     * @param {object} fanControl - the fanControl block.
     * @returns {boolean} whether it is the active preset.
     */
    function monitorPresetActive(preset, fanControl) {
      if (preset === null || typeof preset !== 'object') return false
      if (fanControl === null || typeof fanControl !== 'object') return false
      const mode = typeof fanControl.mode === 'string' ? fanControl.mode : ''
      if (preset.mode !== mode) return false
      if (mode === 'auto') return preset.id === 'auto'
      if (mode === 'manual') {
        const rpm = Number.isFinite(preset.rpm) ? preset.rpm : NaN
        const current = Number.isFinite(fanControl.manualRpm) ? fanControl.manualRpm : NaN
        return Number.isFinite(rpm) && Number.isFinite(current) && Math.abs(rpm - current) < 1
      }
      if (mode === 'curve') {
        if (preset.builtin === true) return false
        const left = preset.curve !== null && typeof preset.curve === 'object' ? preset.curve : null
        const right = fanControl.curve !== null && typeof fanControl.curve === 'object' ? fanControl.curve : null
        if (left === null || right === null) return false
        if (left.sensor !== right.sensor) return false
        const leftPoints = Array.isArray(left.points) ? left.points : []
        const rightPoints = Array.isArray(right.points) ? right.points : []
        if (leftPoints.length !== rightPoints.length) return false
        for (let index = 0; index < leftPoints.length; index += 1) {
          const a = leftPoints[index]
          const b = rightPoints[index]
          if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
          if (!Number.isFinite(a.celsius) || !Number.isFinite(b.celsius)) return false
          if (!Number.isFinite(a.rpm) || !Number.isFinite(b.rpm)) return false
          if (Math.abs(a.celsius - b.celsius) > 0.05) return false
          if (Math.abs(a.rpm - b.rpm) > 0.5) return false
        }
        return true
      }
      return false
    }

    /**
     * The localized label of a fan mode.
     *
     * @param {Function} t - the bound translator.
     * @param {string} mode - "auto" | "manual" | "curve".
     * @returns {string} the label.
     */
    function monitorFanModeLabel(t, mode) {
      const key = MONITOR_FAN_MODE_KEYS[mode]
      return key === undefined ? t('monitor.fan.fanState.unknown') : t(key)
    }

    /**
     * The localized label of a per-fan SMC mode.
     *
     * @param {Function} t - the bound translator.
     * @param {string} mode - "auto" | "forced" | "unknown".
     * @returns {string} the label.
     */
    function monitorFanItemModeLabel(t, mode) {
      const key = MONITOR_FAN_ITEM_MODE_KEYS[mode]
      return key === undefined ? t('monitor.fan.fanState.unknown') : t(key)
    }

    /**
     * The localized label of an alert event's metric.
     *
     * @param {Function} t - the bound translator.
     * @param {string} metric - "cpu" | "temperature" | "memory".
     * @returns {string} the label.
     */
    function monitorAlertMetricLabel(t, metric) {
      const key = MONITOR_ALERT_METRIC_KEYS[metric]
      return key === undefined ? t('monitor.alerts.metric.unknown') : t(key)
    }

    /**
     * Join controller names with the locale-aware separator.
     *
     * @param {Function} t - the bound translator.
     * @param {string[]} names - the names.
     * @returns {string} the joined string.
     */
    function monitorNameListText(t, names) {
      return names.join(t('monitor.separator'))
    }

    /**
     * The default fan curve, scaled into a fan's min..max range.
     *
     * @param {number} minRpm - the fan minimum.
     * @param {number} maxRpm - the fan maximum.
     * @returns {Array<{celsius:number,rpm:number}>} the points.
     */
    function monitorDefaultCurve(minRpm, maxRpm) {
      const low = Number.isFinite(minRpm) ? minRpm : 1000
      const high = Number.isFinite(maxRpm) && maxRpm > low ? maxRpm : low + 3000
      return MONITOR_FAN_CURVE_DEFAULT.map((corner) => ({
        celsius: corner.celsius,
        rpm: Math.round(low + (high - low) * corner.ratio),
      }))
    }

    /**
     * Copy a Host curve into an editable 2..8 point draft, clamped to the fan
     * range and the editor's temperature domain, sorted by celsius.
     *
     * @param {object|null} curve - the Host's `{ sensor, points }`.
     * @param {number} minRpm - the fan minimum.
     * @param {number} maxRpm - the fan maximum.
     * @returns {{ sensor: string, points: Array<{celsius:number,rpm:number}> }} the draft.
     */
    function monitorSanitizeCurve(curve, minRpm, maxRpm) {
      const source = curve !== null && typeof curve === 'object' ? curve : {}
      const low = Number.isFinite(minRpm) ? minRpm : 1000
      const high = Number.isFinite(maxRpm) && maxRpm > low ? maxRpm : low + 3000
      const rawPoints = Array.isArray(source.points) ? source.points : []
      const points = []
      for (let index = 0; index < rawPoints.length; index += 1) {
        const point = rawPoints[index]
        if (point === null || typeof point !== 'object') continue
        if (!Number.isFinite(point.celsius) || !Number.isFinite(point.rpm)) continue
        points.push({
          celsius: Math.round(clampNumber(point.celsius, MONITOR_CURVE_MIN_CELSIUS, MONITOR_CURVE_MAX_CELSIUS) * 10) / 10,
          rpm: Math.round(clampNumber(point.rpm, low, high)),
        })
      }
      points.sort((left, right) => left.celsius - right.celsius)
      const deduped = []
      for (let index = 0; index < points.length; index += 1) {
        if (deduped.length > 0 && points[index].celsius - deduped[deduped.length - 1].celsius < 1) continue
        deduped.push(points[index])
        if (deduped.length >= MONITOR_CURVE_MAX_POINTS) break
      }
      const sensor = typeof source.sensor === 'string' && source.sensor !== '' ? source.sensor : 'cpuPerformance'
      return { sensor, points: deduped }
    }

    // ---------------------------------------------------------------------
    // Glyphs
    // ---------------------------------------------------------------------

    /**
     * Stroke-only 20x20 glyph definitions, built once and rendered through
     * {@link glyph}. Keys are semantic so call sites read as intent.
     */
    const GLYPH_PARTS = {
      camera: [
        ['path', { d: 'M2.5 6.2 H12.5 V15 H2.5 Z' }],
        ['circle', { cx: 7.5, cy: 10.6, r: 2.4 }],
        ['path', { d: 'M4.9 6.2 L5.9 4.2 H9.1 L10.1 6.2' }],
        ['path', { d: 'M14.4 8.8 H17.6 V16.2 H14.4 Z' }],
        ['path', { d: 'M15.2 11.6 H15.22 M16.8 11.6 H16.82 M15.2 14 H15.22 M16.8 14 H16.82' }],
      ],
      eye: [
        ['path', { d: 'M2 10 C4.4 5.6, 15.6 5.6, 18 10 C15.6 14.4, 4.4 14.4, 2 10 Z' }],
        ['circle', { cx: 10, cy: 10, r: 2.6 }],
      ],
      crop: [
        ['path', { d: 'M6 2.5 V13.5 H17' }],
        ['path', { d: 'M2.5 6 H13.5 V17' }],
      ],
      arrow: [
        ['path', { d: 'M3.5 16.5 L16.5 3.5' }],
        ['path', { d: 'M9.4 3.5 H16.5 V10.6' }],
      ],
      rect: [['rect', { x: 3.5, y: 4.5, width: 13, height: 11, rx: 1 }]],
      ellipse: [['ellipse', { cx: 10, cy: 10, rx: 6.8, ry: 5.4 }]],
      pen: [
        ['path', { d: 'M3.5 16.5 L5.1 12 L13.6 3.5 L16.5 6.4 L8 14.9 Z' }],
        ['path', { d: 'M11.7 5.4 L14.6 8.3' }],
      ],
      text: [
        ['path', { d: 'M4 4.5 H16' }],
        ['path', { d: 'M10 4.5 V15.5' }],
      ],
      mosaic: [
        ['rect', { x: 3.2, y: 3.2, width: 5.6, height: 5.6 }],
        ['rect', { x: 11.2, y: 3.2, width: 5.6, height: 5.6 }],
        ['rect', { x: 3.2, y: 11.2, width: 5.6, height: 5.6 }],
        ['rect', { x: 11.2, y: 11.2, width: 5.6, height: 5.6 }],
      ],
      highlight: [
        ['path', { d: 'M4.2 13.2 L11.9 5.5 L14.5 8.1 L6.8 15.8 Z' }],
        ['path', { d: 'M2.8 17.6 H17.2' }],
      ],
      undo: [
        ['path', { d: 'M7.5 5.5 L3.5 9.5 L7.5 13.5' }],
        ['path', { d: 'M3.5 9.5 H12 A4.5 4.5 0 0 1 12 18.5 H10' }],
      ],
      redo: [
        ['path', { d: 'M12.5 5.5 L16.5 9.5 L12.5 13.5' }],
        ['path', { d: 'M16.5 9.5 H8 A4.5 4.5 0 0 0 8 18.5 H10' }],
      ],
      reset: [
        ['path', { d: 'M16.5 10 A6.5 6.5 0 1 1 12.2 4.1' }],
        ['path', { d: 'M16.5 3.4 V9.2 H10.7' }],
      ],
      copy: [
        ['rect', { x: 7.2, y: 7.2, width: 9.3, height: 9.3, rx: 1.4 }],
        ['path', { d: 'M12.8 7.2 V4.9 A1.4 1.4 0 0 0 11.4 3.5 H4.9 A1.4 1.4 0 0 0 3.5 4.9 V11.4 A1.4 1.4 0 0 0 4.9 12.8 H7.2' }],
      ],
      pin: [
        ['path', { d: 'M7.2 3.5 H12.8 L11.6 7.2 L14.4 10 H10.4 V16.5' }],
        ['path', { d: 'M5.6 10 H14.4' }],
      ],
      save: [
        ['path', { d: 'M3.5 5 A1.5 1.5 0 0 1 5 3.5 H13 L16.5 7 V15 A1.5 1.5 0 0 1 15 16.5 H5 A1.5 1.5 0 0 1 3.5 15 Z' }],
        ['path', { d: 'M6.5 3.5 V8 H13.2 V3.5' }],
        ['path', { d: 'M6.5 16.5 V11.2 H13.5 V16.5' }],
      ],
      close: [
        ['path', { d: 'M5 5 L15 15' }],
        ['path', { d: 'M15 5 L5 15' }],
      ],
      refresh: [
        ['path', { d: 'M16.4 10 A6.4 6.4 0 1 1 12.1 4.1' }],
        ['path', { d: 'M16.4 3.4 V9.4 H10.4' }],
      ],
      alert: [
        ['path', { d: 'M10 2.9 L17.4 16.2 H2.6 Z' }],
        ['path', { d: 'M10 7.4 V11.2' }],
        ['path', { d: 'M10 13.7 V13.72' }],
      ],
      check: [['path', { d: 'M4 10.5 L8 14.5 L16 5.5' }]],
      reveal: [
        ['path', { d: 'M3.5 6.2 A1.2 1.2 0 0 1 4.7 5 H8 L9.6 6.9 H15.3 A1.2 1.2 0 0 1 16.5 8.1 V14.3 A1.2 1.2 0 0 1 15.3 15.5 H4.7 A1.2 1.2 0 0 1 3.5 14.3 Z' }],
      ],
      calculator: [
        ['rect', { x: 4.5, y: 2.8, width: 11, height: 14.4, rx: 1.6 }],
        ['path', { d: 'M7 6.4 H13' }],
        ['path', { d: 'M7.6 10 H7.62 M10 10 H10.02 M12.4 10 H12.42 M7.6 13.4 H7.62 M10 13.4 H10.02 M12.4 13.4 H12.42' }],
      ],
      system: [
        ['rect', { x: 2.8, y: 3.8, width: 14.4, height: 9.6, rx: 1.4 }],
        ['path', { d: 'M7 16.2 H13' }],
        ['path', { d: 'M10 13.4 V16.2' }],
      ],
      image: [
        ['rect', { x: 3, y: 4, width: 14, height: 12, rx: 1.4 }],
        ['circle', { cx: 7.2, cy: 8.2, r: 1.4 }],
        ['path', { d: 'M3.4 14.6 L8 10 L11 13 L13.2 10.8 L16.6 14.2' }],
      ],
      settings: [
        ['circle', { cx: 10, cy: 10, r: 2.6 }],
        ['path', { d: 'M10 2.8 V5 M10 15 V17.2 M2.8 10 H5 M15 10 H17.2 M4.9 4.9 L6.4 6.4 M13.6 13.6 L15.1 15.1 M15.1 4.9 L13.6 6.4 M6.4 13.6 L4.9 15.1' }],
      ],
      qr: [
        ['rect', { x: 3, y: 3, width: 5, height: 5, rx: 0.8 }],
        ['rect', { x: 12, y: 3, width: 5, height: 5, rx: 0.8 }],
        ['rect', { x: 3, y: 12, width: 5, height: 5, rx: 0.8 }],
        ['path', { d: 'M12.2 12.2 H14.2 V14.2 H12.2 Z M15.6 12.2 H17.2 M12.2 15.6 H14.2 V17.2 M15.6 15.6 H17.2 V17.2' }],
      ],
    }

    /**
     * Render one glyph by name.
     *
     * @param {string} name - a key of {@link GLYPH_PARTS}.
     * @param {number} [size] - the edge length in CSS pixels.
     * @returns {object} the `<svg>` element.
     */
    function glyph(name, size, key) {
      const parts = GLYPH_PARTS[name] || GLYPH_PARTS.camera
      const edge = typeof size === 'number' ? size : 15
      return h('svg', {
        key,
        className: 'dshMacToolsIcon',
        width: edge,
        height: edge,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, parts.map((part, index) => h(part[0], Object.assign({ key: index }, part[1]))))
    }

    // ---------------------------------------------------------------------
    // Host transport
    // ---------------------------------------------------------------------

    /**
     * The Host HTTP contract: `POST /api/dsh-mac-tools` with
     * `{ endpoint, payload }`, answered by `{ ok: true, value }` or
     * `{ ok: false, error: { code, message, details } }`.
     *
     * Failures are normalized to `Error` objects carrying `code`, `message`
     * and `details`, so callers switch on a code rather than on HTTP details:
     *
     *   - `host_missing` — HTTP 404, the Host half is not published on this page;
     *   - `host_unreachable` — no fetch, a refused connection, a non-2xx status
     *     or a body that is not the envelope;
     *   - `aborted` — the caller's `AbortController` fired (unmount), not an error;
     *   - anything else — the Host answered and refused the operation, and the
     *     code is the endpoint's documented reason (`cancelled`, `busy`, …).
     *
     * @returns {{ post: Function, shotUrl: Function, historyUrl: Function, inboxUrl: Function }} the request helpers.
     */
    function createHostClient() {
      /**
       * @param {string} code - the normalized failure code.
       * @param {string} message - the wire message.
       * @param {object} [details] - structured details from the envelope.
       * @returns {Error} the classified failure.
       */
      function hostError(code, message, details) {
        const error = new Error(message)
        error.code = code
        error.details = details === undefined ? {} : details
        return error
      }

      /**
       * Post one endpoint and unwrap the envelope.
       *
       * @param {string} endpoint - the operation name.
       * @param {any} payload - its arguments.
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<any>} the operation value.
       */
      async function post(endpoint, payload, options) {
        const settings = options === undefined || options === null ? {} : options
        const doFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null
        if (doFetch === null) throw hostError('host_unreachable', 'this page cannot reach the host')
        let response
        try {
          response = await doFetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload: payload === undefined ? {} : payload }),
            credentials: 'same-origin',
            signal: settings.signal,
          })
        } catch (error) {
          if (error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
            throw hostError('aborted', 'aborted')
          }
          throw hostError('host_unreachable', error instanceof Error ? error.message : String(error))
        }
        if (response === null || typeof response !== 'object' || response.ok !== true) {
          const status = response !== null && typeof response === 'object' && typeof response.status === 'number' ? response.status : 0
          if (status === 404) throw hostError('host_missing', 'the Host half is not published on this page (HTTP 404)', { http: 404 })
          throw hostError('host_unreachable', status === 0 ? 'no response' : `HTTP ${status}`, { http: status })
        }
        let body
        try {
          body = await response.json()
        } catch (error) {
          throw hostError('host_unreachable', 'the Host answered with a body that is not JSON')
        }
        if (body === null || typeof body !== 'object' || body.ok !== true) {
          const reason = body !== null && typeof body === 'object' ? body.error : null
          const code = reason !== null && typeof reason === 'object' && typeof reason.code === 'string' ? reason.code : 'host_refused'
          const message = reason !== null && typeof reason === 'object' && typeof reason.message === 'string' ? reason.message : 'the Host refused the request'
          const details = reason !== null && typeof reason === 'object' && reason.details !== null && typeof reason.details === 'object' ? reason.details : {}
          throw hostError(code, message, details)
        }
        return body.value
      }

      /**
       * The same-origin image URL for a shot, cache-busted by its capture time
       * so a re-render never reloads the same PNG.
       *
       * @param {object} shot - the shot record.
       * @returns {string} the GET URL.
       */
      function shotUrl(shot) {
        const version = Number.isFinite(shot.at) ? shot.at : Date.now()
        return `${API_PATH}?shot=${encodeURIComponent(shot.id)}&t=${version}`
      }

      /**
       * The same-origin image URL for one durable history capture.
       *
       * @param {object} item - history entry.
       * @returns {string} the GET URL.
       */
      function historyUrl(item) {
        const stamp = typeof item.at === 'string' ? Date.parse(item.at) : Number(item.at)
        const version = Number.isFinite(stamp) ? stamp : Date.now()
        return `${API_PATH}?history=${encodeURIComponent(item.id)}&t=${version}`
      }

      /**
       * The same-origin preview URL for one phone-transfer inbox file, cache-
       * busted by the moment the phone sent it.
       *
       * @param {object} item - inbox entry.
       * @returns {string} the GET URL.
       */
      function inboxUrl(item) {
        const stamp = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number(item.createdAt)
        const version = Number.isFinite(stamp) ? stamp : Date.now()
        return `${API_PATH}?inbox=${encodeURIComponent(item.id)}&t=${version}`
      }

      return { post, shotUrl, historyUrl, inboxUrl }
    }

    /**
     * Reduce a thrown value to the store's error shape.
     *
     * @param {any} error - the thrown value.
     * @returns {{ code: string, message: string, details: object }} the failure.
     */
    function describeFailure(error) {
      return {
        code: error !== null && error !== undefined && typeof error.code === 'string' ? error.code : 'host_unreachable',
        message: error instanceof Error ? error.message : String(error),
        details: error !== null && error !== undefined && error.details !== null && typeof error === 'object' && typeof error.details === 'object' ? error.details : {},
      }
    }

    // ---------------------------------------------------------------------
    // The panel store
    // ---------------------------------------------------------------------

    /**
     * The one piece of cross-component state: everything that must outlive a
     * tab switch or survive the panel unmounting while a native capture is in
     * flight. It is created exactly once per factory materialization (not per
     * render and not per panel mount), so the keyboard shortcut can start a
     * capture and the panel simply adopts the result when it appears.
     *
     * It holds no authoritative data of its own: every value here is either the
     * last answer from the Host or ephemeral view state (active tab, in-flight
     * flags).
     *
     * @param {{ post: Function, shotUrl: Function, historyUrl: Function, inboxUrl: Function }} host - the transport.
     * @returns {object} the store.
     */
    function createMacToolsStore(host) {
      /** @type {Set<() => void>} */
      const listeners = new Set()
      let snapshot = {
        host: { kind: 'loading', value: null, http: 0, message: '' },
        tab: 'screenshot',
        hideApp: false,
        hideAppAvailable: false,
        hotkey: { recording: false, saving: false, error: null },
        history: { status: 'idle', items: [], error: null },
        capture: { status: 'idle', mode: '', cancelling: false, error: null },
        shot: null,
        windows: { status: 'idle', list: [], frontmost: null, error: null },
        calc: { expression: '', status: 'idle', result: null, error: null, history: [] },
        transfer: {
          status: 'idle',
          session: null,
          inbox: { status: 'idle', items: [], count: 0, error: null },
          outbox: { status: 'idle', items: [], count: 0, error: null },
          textDraft: '',
          sendingText: false,
          addingFile: false,
          toast: null,
          error: null,
        },
        monitor: {
          status: 'idle',
          value: null,
          error: null,
          paused: false,
          intervalMs: MONITOR_POLL_MS,
          fetchedAt: 0,
          processes: {
            open: false,
            status: 'idle',
            value: null,
            error: null,
            sort: 'cpu',
            armedPid: null,
            killingPid: null,
            actionError: null,
          },
          fan: { pending: null, error: null },
          alerts: { saving: false, testing: false, error: null },
        },
      }
      let hostRequest = null
      let windowsRequest = null
      let historyRequest = null
      let transferStatusRequest = null
      /** Whether a transfer status answer has landed since this store was made. */
      let transferStatusLoaded = false
      let transferInboxRequest = null
      let transferOutboxRequest = null
      let transferStartRequest = null
      let transferStopRequest = null
      /**
       * Bumped whenever a `transferStart`/`transferStop` answer settles. A
       * status poll that was sent before that point describes the previous
       * session, so its answer must not overwrite the fresh one.
       */
      let transferStatusGeneration = 0
      /**
       * Bumped by every local inbox mutation. A list read that was sent before
       * the mutation carries the pre-mutation list and must not resurrect it.
       */
      let transferInboxGeneration = 0
      /** The outbox twin of {@link transferInboxGeneration}. */
      let transferOutboxGeneration = 0
      /** Whether an inbox answer ever landed, so the skeleton shows only once. */
      let transferInboxLoaded = false
      /** The outbox twin of {@link transferInboxLoaded}. */
      let transferOutboxLoaded = false
      /** History ids whose one-tap `addHistory` request is still in flight. */
      const transferHistoryRequests = new Set()
      /** In-flight one-shot transfer actions, keyed by their action identity. */
      const transferActionRequests = new Map()
      /** Whether the user changed the hide-while-capturing toggle this session. */
      let hideAppTouched = false
      /** The in-flight `monitor` poll, shared by every caller for dedupe. */
      let monitorRequest = null
      /** The in-flight `monitorProcesses` read. */
      let monitorProcessesRequest = null
      /** Whether a sort change arrived while a process read was in flight. */
      let monitorProcessesReload = false
      /**
       * Bumped when the process sort changes or the section closes, so an
       * answer for the previous sort cannot overwrite the current ranking.
       */
      let monitorProcessGeneration = 0
      /** The in-flight alert-save promise, so double clicks cannot stack. */
      let monitorAlertSaveRequest = null
      /** The in-flight alert-test promise. */
      let monitorAlertTestRequest = null
      /**
       * A `fanApply` payload queued while another apply was in flight. The
       * latest release wins; only one write is ever outstanding.
       */
      let pendingFanApply = null

      /**
       * Replace part of the snapshot and notify subscribers. A subscriber that
       * throws cannot break the panel, so its failure is logged and forgotten.
       *
       * @param {object} patch - the snapshot fields to replace.
       * @returns {void}
       */
      function publish(patch) {
        snapshot = Object.assign({}, snapshot, patch)
        const current = [...listeners]
        for (let index = 0; index < current.length; index += 1) {
          try {
            current[index]()
          } catch (error) {
            console.warn(`[${NS}] a panel subscriber threw:`, error)
          }
        }
      }

      /**
       * Read `status` and cache it. Called on panel mount, after a failure, and
       * by the status pill's reconnect button; it never stacks requests.
       *
       * @returns {Promise<boolean>} whether the Host answered.
       */
      function loadHost() {
        if (hostRequest !== null) return hostRequest
        if (snapshot.host.kind === 'ready' && snapshot.host.value !== null) return Promise.resolve(true)
        publish({ host: Object.assign({}, snapshot.host, { kind: 'loading', http: 0, message: '' }) })
        const run = host.post('status', {}).then((value) => {
          const next = value !== null && typeof value === 'object' ? value : {}
          publish({ host: { kind: 'ready', value: next, http: 200, message: '' } })
          if (!hideAppTouched) {
            const available = next.canHideApp === true
            publish({ hideAppAvailable: available, hideApp: available && next.hideAppDuringCapture !== false })
          } else {
            publish({ hideAppAvailable: next.canHideApp === true })
          }
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          publish({
            host: {
              kind: failure.code === 'host_missing' ? 'missing' : 'error',
              value: null,
              http: failure.details.http || 0,
              message: failure.message,
            },
          })
          return false
        }).then((result) => {
          hostRequest = null
          return result
        }, (error) => {
          hostRequest = null
          throw error
        })
        hostRequest = run
        return run
      }

      /**
       * Read the on-screen window list once (the picker refreshes on demand).
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether the list is current.
       */
      function loadWindows(options) {
        if (windowsRequest !== null) return windowsRequest
        publish({ windows: Object.assign({}, snapshot.windows, { status: 'loading', error: null }) })
        const run = host.post('windows', {}, options).then((value) => {
          const list = value !== null && typeof value === 'object' && Array.isArray(value.windows) ? value.windows : []
          const frontmost = value !== null && typeof value === 'object' && value.frontmost !== null && typeof value.frontmost === 'object' ? value.frontmost : null
          publish({ windows: { status: 'ready', list, frontmost, error: null } })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            publish({ windows: Object.assign({}, snapshot.windows, { status: snapshot.windows.list.length > 0 ? 'ready' : 'idle', error: null }) })
            return false
          }
          publish({ windows: Object.assign({}, snapshot.windows, { status: 'error', error: failure }) })
          return false
        }).then((result) => {
          windowsRequest = null
          return result
        }, (error) => {
          windowsRequest = null
          throw error
        })
        windowsRequest = run
        return run
      }

      /**
       * Run a capture. Interactive modes park this promise until the operator
       * finishes or presses Esc; the store keeps `capture.status === 'running'`
       * for the whole time so the toolbar can offer the cancel button.
       *
       * A `cancelled` answer is a normal outcome and is not surfaced as an
       * error, per the contract. Any other failure is published for the
       * screenshot tab to localize.
       *
       * @param {object} request - the `capture` payload.
       * @returns {Promise<boolean>} whether a new shot was adopted.
       */
      function capture(request) {
        if (snapshot.capture.status === 'running') return Promise.resolve(false)
        const payload = request !== null && typeof request === 'object' ? request : {}
        const mode = typeof payload.mode === 'string' ? payload.mode : 'interactive'
        const outgoing = Object.assign({}, payload, { hideApp: snapshot.hideApp === true })
        publish({ capture: { status: 'running', mode, cancelling: false, error: null } })
        return host.post('capture', outgoing).then((value) => {
          const shot = value !== null && typeof value === 'object' && value.shot !== null && typeof value.shot === 'object' ? value.shot : value
          if (shot === null || typeof shot !== 'object' || typeof shot.id !== 'string') {
            const error = new Error('the Host returned no shot id')
            error.code = 'capture_failed'
            error.details = {}
            throw error
          }
          publish({
            capture: { status: 'idle', mode: '', cancelling: false, error: null },
            shot: Object.assign({}, shot, { imageUrl: host.shotUrl(shot) }),
          })
          void loadHistory()
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            publish({ capture: { status: 'idle', mode: '', cancelling: false, error: null } })
            return false
          }
          const cancelled = failure.code === 'cancelled'
          publish({
            capture: {
              status: 'idle',
              mode: '',
              cancelling: false,
              error: cancelled ? null : failure,
            },
          })
          return false
        }).then((result) => result, (error) => {
          // A non-capture failure would leave the toolbar stuck; unlock it and
          // rethrow so it is visible in the console rather than in the UI.
          publish({ capture: { status: 'idle', mode: '', cancelling: false, error: describeFailure(error) } })
          throw error
        })
      }

      /**
       * Ask the Host to end an in-flight interactive capture. The capture
       * request itself answers with `cancelled`, so the toolbar unlocks when
       * that promise settles rather than here.
       *
       * @returns {Promise<boolean>} whether the Host accepted the cancel.
       */
      function cancelCapture() {
        if (snapshot.capture.status !== 'running') return Promise.resolve(false)
        publish({ capture: Object.assign({}, snapshot.capture, { cancelling: true }) })
        return host.post('cancelCapture', {}).then((value) => {
          const accepted = value !== null && typeof value === 'object' && value.cancelled === true
          if (!accepted && snapshot.capture.status === 'running') {
            publish({ capture: Object.assign({}, snapshot.capture, { cancelling: false }) })
          }
          return accepted
        }).catch(() => {
          if (snapshot.capture.status === 'running') {
            publish({ capture: Object.assign({}, snapshot.capture, { cancelling: false }) })
          }
          return false
        })
      }

      /** @param {string} tab - one of {@link TABS}. */
      function selectTab(tab) {
        if (TABS.indexOf(tab) < 0 || tab === snapshot.tab) return
        publish({ tab })
      }

      /** Forget the current shot (the editor's close action). */
      function discardShot() {
        publish({ shot: null })
      }

      /** Drop the last capture failure so the notice disappears. */
      function dismissCaptureError() {
        publish({ capture: Object.assign({}, snapshot.capture, { error: null }) })
      }

      /**
       * @param {string} text - the new calculator expression.
       * @returns {void}
       */
      function setCalcExpression(text) {
        publish({
          calc: Object.assign({}, snapshot.calc, {
            expression: String(text),
            error: null,
          }),
        })
      }

      /** Clear the calculator's expression, result and failure. */
      function clearCalculator() {
        publish({ calc: Object.assign({}, snapshot.calc, { expression: '', result: null, error: null, status: 'idle' }) })
      }

      /**
       * Evaluate the current expression through the Host's engine. Only the
       * Host is authoritative; the panel never parses arithmetic itself.
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether an evaluation was adopted.
       */
      function evaluateCalc(options) {
        if (snapshot.calc.status === 'evaluating') return Promise.resolve(false)
        const expression = snapshot.calc.expression.trim()
        if (expression === '') return Promise.resolve(false)
        publish({ calc: Object.assign({}, snapshot.calc, { status: 'evaluating', error: null }) })
        return host.post('calc', { expression, angles: 'deg' }, options).then((value) => {
          const record = value !== null && typeof value === 'object' ? value : {}
          const entry = {
            expression: typeof record.expression === 'string' ? record.expression : expression,
            formatted: typeof record.formatted === 'string' ? record.formatted : String(record.value),
            value: record.value,
          }
          const history = [entry].concat(snapshot.calc.history).slice(0, CALC_HISTORY_LIMIT)
          publish({ calc: Object.assign({}, snapshot.calc, { status: 'idle', result: entry, error: null, history }) })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            publish({ calc: Object.assign({}, snapshot.calc, { status: 'idle' }) })
            return false
          }
          publish({ calc: Object.assign({}, snapshot.calc, { status: 'idle', error: failure }) })
          return false
        }).then((result) => result, (error) => {
          publish({ calc: Object.assign({}, snapshot.calc, { status: 'idle', error: describeFailure(error) }) })
          throw error
        })
      }

      /**
       * Put a PNG on the macOS clipboard.
       *
       * @param {string} pngBase64 - raw base64 PNG.
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<{bytes:number, at:number}>} the Host's answer.
       */
      function copyShot(pngBase64, options) {
        return host.post('copy', { pngBase64 }, options)
      }

      /**
       * Write a PNG into the configured save directory.
       *
       * @param {string} pngBase64 - raw base64 PNG.
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<{path:string,fileName:string,directory:string,bytes:number}>} the saved file.
       */
      function saveShot(pngBase64, options) {
        return host.post('save', { pngBase64 }, options)
      }

      /**
       * Pin a PNG to the screen as an always-on-top floating window, placed
       * where the capture came from when that rectangle is known.
       *
       * @param {string} pngBase64 - raw base64 PNG.
       * @param {string} [shotId] - the shot being pinned, so the Host can place it.
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<{ ok: boolean, path: string, count: number }>} the Host's answer.
       */
      function pinShot(pngBase64, shotId, options) {
        return host.post('pin', {
          pngBase64,
          ...(typeof shotId === 'string' && shotId !== '' ? { shotId } : {}),
        }, options)
      }

      /**
       * Ask Finder to reveal a saved file.
       *
       * @param {string} path - the absolute path the Host wrote.
       * @returns {Promise<any>} the Host's answer.
       */
      function revealPath(path) {
        return host.post('reveal', { path })
      }

      /**
       * Adopt one shot (from history, or from a pinned window's edit request)
       * into the editor.
       *
       * @param {object} shot - shot record from the Host.
       * @returns {boolean} whether the shot was adopted.
       */
      function adoptShot(shot) {
        if (shot === null || typeof shot !== 'object' || typeof shot.id !== 'string') return false
        publish({
          tab: 'screenshot',
          capture: { status: 'idle', mode: '', cancelling: false, error: null },
          shot: Object.assign({}, shot, { imageUrl: host.shotUrl(shot) }),
        })
        return true
      }

      /**
       * Read the durable screenshot history.
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether the list is current.
       */
      function loadHistory(options) {
        if (historyRequest !== null) return historyRequest
        publish({ history: Object.assign({}, snapshot.history, { status: snapshot.history.items.length === 0 ? 'loading' : 'ready', error: null }) })
        const run = host.post('history', {}, options).then((value) => {
          const items = value !== null && typeof value === 'object' && Array.isArray(value.items) ? value.items : []
          publish({ history: { status: 'ready', items, error: null } })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            publish({ history: Object.assign({}, snapshot.history, { status: snapshot.history.items.length === 0 ? 'idle' : 'ready' }) })
            return false
          }
          publish({ history: Object.assign({}, snapshot.history, { status: snapshot.history.items.length === 0 ? 'error' : 'ready', error: failure }) })
          return false
        }).then((result) => {
          historyRequest = null
          return result
        }, (error) => {
          historyRequest = null
          throw error
        })
        historyRequest = run
        return run
      }

      /**
       * Load one history capture into the editor.
       *
       * @param {string} id - history entry id.
       * @returns {Promise<boolean>} whether the shot was adopted.
       */
      async function openHistory(id) {
        try {
          const value = await host.post('historyOpen', { id })
          const shot = value !== null && typeof value === 'object' ? value.shot : null
          if (adoptShot(shot) !== true) return false
          return true
        } catch (error) {
          const failure = describeFailure(error)
          publish({ history: Object.assign({}, snapshot.history, { error: failure }) })
          return false
        }
      }

      /**
       * @param {string} id - history entry id.
       * @returns {Promise<boolean>} whether the entry was deleted.
       */
      async function deleteHistory(id) {
        try {
          await host.post('historyDelete', { id })
          await loadHistory()
          return true
        } catch (error) {
          publish({ history: Object.assign({}, snapshot.history, { error: describeFailure(error) }) })
          return false
        }
      }

      /**
       * Remove every history capture.
       *
       * @returns {Promise<boolean>} whether the history was cleared.
       */
      async function clearHistory() {
        try {
          await host.post('historyClear', {})
          publish({ history: { status: 'ready', items: [], error: null } })
          return true
        } catch (error) {
          publish({ history: Object.assign({}, snapshot.history, { error: describeFailure(error) }) })
          return false
        }
      }

      /**
       * Pin one history capture to the screen.
       *
       * @param {string} id - history entry id.
       * @returns {Promise<object>} the Host's answer.
       */
      function pinHistory(id) {
        return host.post('historyPin', { id })
      }

      /**
       * Copy one history capture to the clipboard.
       *
       * @param {string} id - history entry id.
       * @returns {Promise<object>} the Host's answer.
       */
      function copyHistory(id) {
        return host.post('historyCopy', { id })
      }

      // --- phone transfer -------------------------------------------------

      /**
       * Replace part of the transfer slice.
       *
       * @param {object} patch - the transfer fields to replace.
       * @returns {void}
       */
      function updateTransfer(patch) {
        publish({ transfer: Object.assign({}, snapshot.transfer, patch) })
      }

      /**
       * Show one toast. `text` is a locale key for success; failures carry the
       * normalized error so the tab can localize the reason itself.
       *
       * @param {object} toast - the toast value.
       * @returns {void}
       */
      function setTransferToast(toast) {
        updateTransfer({ toast })
      }

      /**
       * @param {object} failure - a normalized failure.
       * @returns {void}
       */
      function transferFailureToast(failure) {
        setTransferToast({ kind: 'error', text: 'transfer.toast.failed', error: failure })
      }

      /**
       * Adopt a full status answer. The contract keeps the whole object in
       * `session` while the session is live and clears it as soon as the Host
       * says the session is over.
       *
       * A poll that lands while a start/stop request is still in flight is
       * reading the previous state, so the in-flight request stays the truth:
       * otherwise the first start (which waits for the QR helper) would flash a
       * "no QR code" session card, and a stop would flip back to "running". A
       * poll still refreshes the session object mid-stop so the counts stay
       * current.
       *
       * @param {any} value - the `transferStatus`/`transferStart`/`transferStop` answer.
       * @param {boolean} [authoritative] - a start/stop answer overrides a poll.
       * @returns {void}
       */
      function adoptTransferStatus(value, authoritative) {
        const next = value !== null && typeof value === 'object' ? value : {}
        transferStatusLoaded = true
        if (authoritative !== true && (transferStartRequest !== null || transferStopRequest !== null)) {
          if (transferStopRequest !== null && next.active === true) {
            updateTransfer({ session: next })
          }
          return
        }
        if (next.active === true) {
          updateTransfer({ status: 'active', session: next, error: null })
          return
        }
        updateTransfer({ status: 'idle', session: null, error: null })
      }

      /**
       * Deduplicate one-shot transfer actions so a double click cannot stack
       * two identical requests.
       *
       * @param {string} key - the action identity.
       * @param {Function} task - the action body.
       * @returns {Promise<any>} the shared promise.
       */
      function transferAction(key, task) {
        if (transferActionRequests.has(key)) return transferActionRequests.get(key)
        const promise = Promise.resolve().then(task).then((result) => {
          transferActionRequests.delete(key)
          return result
        }, (error) => {
          transferActionRequests.delete(key)
          throw error
        })
        transferActionRequests.set(key, promise)
        return promise
      }

      /**
       * Read the transfer session state. Polled by the visible tab every 2 s; a
       * poll never stacks on an in-flight request and never flashes the loading
       * skeleton over a session already on screen.
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether the Host answered.
       */
      function loadTransferStatus(options) {
        if (transferStatusRequest !== null) return transferStatusRequest
        // The skeleton appears only before the first answer: a poll on an idle
        // session must not re-flash the loading card every two seconds.
        if (transferStatusLoaded !== true) {
          updateTransfer({ status: 'loading', error: null })
        }
        const generation = transferStatusGeneration
        const run = host.post('transferStatus', {}, options).then((value) => {
          // A start/stop settled while this poll was in flight; its answer is
          // newer than this one (see {@link transferStatusGeneration}).
          if (generation === transferStatusGeneration) adoptTransferStatus(value)
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            if (snapshot.transfer.status === 'loading') {
              updateTransfer({ status: 'idle', session: null })
            }
            return false
          }
          if (generation !== transferStatusGeneration) return false
          // A failed answer is still an answer: keep the error notice steady
          // instead of flashing the skeleton/clearing it on every poll.
          transferStatusLoaded = true
          updateTransfer({ status: 'error', error: failure })
          return false
        }).then((result) => {
          transferStatusRequest = null
          return result
        }, (error) => {
          transferStatusRequest = null
          throw error
        })
        transferStatusRequest = run
        return run
      }

      /**
       * Start a phone-transfer session (the first one may compile the QR
       * helper, so this can take a while and shows `starting` until it lands).
       *
       * @returns {Promise<boolean>} whether the session is active.
       */
      function startTransfer() {
        if (transferStartRequest !== null) return transferStartRequest
        if (snapshot.transfer.session !== null) return Promise.resolve(true)
        updateTransfer({ status: 'starting', error: null })
        const run = host.post('transferStart', {}).then((value) => {
          adoptTransferStatus(value, true)
          void refreshTransferInbox()
          void refreshTransferOutbox()
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            updateTransfer({ status: 'idle', session: null })
            return false
          }
          updateTransfer({ status: 'error', error: failure })
          // The next successful idle status poll (within 2 s) replaces this
          // notice again, so the toast is what keeps the reason readable.
          transferFailureToast(failure)
          return false
        }).then((result) => {
          transferStartRequest = null
          transferStatusGeneration += 1
          return result
        }, (error) => {
          transferStartRequest = null
          transferStatusGeneration += 1
          throw error
        })
        transferStartRequest = run
        return run
      }

      /**
       * End the current transfer session.
       *
       * @returns {Promise<boolean>} whether the session is over.
       */
      function stopTransfer() {
        if (transferStopRequest !== null) return transferStopRequest
        if (snapshot.transfer.session === null && snapshot.transfer.status !== 'active') return Promise.resolve(false)
        updateTransfer({ status: 'stopping', error: null })
        const run = host.post('transferStop', {}).then((value) => {
          adoptTransferStatus(value, true)
          void refreshTransferInbox()
          void refreshTransferOutbox()
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            updateTransfer({ status: snapshot.transfer.session === null ? 'idle' : 'active' })
            return false
          }
          updateTransfer({
            status: snapshot.transfer.session === null ? 'idle' : 'active',
            error: failure,
          })
          transferFailureToast(failure)
          return false
        }).then((result) => {
          transferStopRequest = null
          transferStatusGeneration += 1
          return result
        }, (error) => {
          transferStopRequest = null
          transferStatusGeneration += 1
          throw error
        })
        transferStopRequest = run
        return run
      }

      /**
       * Read the inbox (what the phone sent to this Mac).
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether the list is current.
       */
      function refreshTransferInbox(options) {
        if (transferInboxRequest !== null) return transferInboxRequest
        const current = snapshot.transfer.inbox
        // Only the first read shows the skeleton: a poll (or a retry after an
        // error) keeps the previous card on screen instead of flashing it.
        const firstRead = current.items.length === 0 && transferInboxLoaded !== true
        const keepError = firstRead !== true && current.error !== null && current.error !== undefined
        const generation = transferInboxGeneration
        updateTransfer({
          inbox: Object.assign({}, current, {
            status: firstRead ? 'loading' : (keepError ? 'error' : 'ready'),
            error: keepError ? current.error : null,
          }),
        })
        const run = host.post('transferInbox', { action: 'refresh' }, options).then((value) => {
          if (generation !== transferInboxGeneration) {
            // A delete/clear landed while this read was in flight, so the
            // answer predates it and must not resurrect the removed rows.
            const state = snapshot.transfer.inbox
            updateTransfer({ inbox: Object.assign({}, state, { status: 'ready', error: null }) })
            return false
          }
          const record = value !== null && typeof value === 'object' ? value : {}
          const items = Array.isArray(record.items) ? record.items : []
          const count = Number.isFinite(record.count) ? record.count : items.length
          transferInboxLoaded = true
          updateTransfer({ inbox: { status: 'ready', items, count, error: null } })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          const state = snapshot.transfer.inbox
          if (failure.code === 'aborted') {
            updateTransfer({ inbox: Object.assign({}, state, { status: state.items.length === 0 ? 'idle' : 'ready' }) })
            return false
          }
          transferInboxLoaded = true
          updateTransfer({
            inbox: Object.assign({}, state, {
              status: state.items.length === 0 ? 'error' : 'ready',
              error: failure,
            }),
          })
          return false
        }).then((result) => {
          transferInboxRequest = null
          return result
        }, (error) => {
          transferInboxRequest = null
          throw error
        })
        transferInboxRequest = run
        return run
      }

      /**
       * Read the outbox (what this Mac is offering to the phone).
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether the list is current.
       */
      function refreshTransferOutbox(options) {
        if (transferOutboxRequest !== null) return transferOutboxRequest
        const current = snapshot.transfer.outbox
        // Same rule as the inbox: one skeleton on the first read, then the
        // previous card (including a live error) stays until the answer lands.
        const firstRead = current.items.length === 0 && transferOutboxLoaded !== true
        const keepError = firstRead !== true && current.error !== null && current.error !== undefined
        const generation = transferOutboxGeneration
        updateTransfer({
          outbox: Object.assign({}, current, {
            status: firstRead ? 'loading' : (keepError ? 'error' : 'ready'),
            error: keepError ? current.error : null,
          }),
        })
        const run = host.post('transferOutbox', { action: 'refresh' }, options).then((value) => {
          if (generation !== transferOutboxGeneration) {
            // An add/remove landed while this read was in flight, so the answer
            // predates it and would hide a just-sent item or revive a removed one.
            const state = snapshot.transfer.outbox
            updateTransfer({ outbox: Object.assign({}, state, { status: 'ready', error: null }) })
            return false
          }
          const record = value !== null && typeof value === 'object' ? value : {}
          const items = Array.isArray(record.items) ? record.items : []
          const count = Number.isFinite(record.count) ? record.count : items.length
          transferOutboxLoaded = true
          updateTransfer({ outbox: { status: 'ready', items, count, error: null } })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          const state = snapshot.transfer.outbox
          if (failure.code === 'aborted') {
            updateTransfer({ outbox: Object.assign({}, state, { status: state.items.length === 0 ? 'idle' : 'ready' }) })
            return false
          }
          transferOutboxLoaded = true
          updateTransfer({
            outbox: Object.assign({}, state, {
              status: state.items.length === 0 ? 'error' : 'ready',
              error: failure,
            }),
          })
          return false
        }).then((result) => {
          transferOutboxRequest = null
          return result
        }, (error) => {
          transferOutboxRequest = null
          throw error
        })
        transferOutboxRequest = run
        return run
      }

      /**
       * Delete one inbox entry (and its file, for file entries).
       *
       * @param {string} id - inbox entry id.
       * @returns {Promise<boolean>} whether it was deleted.
       */
      function deleteTransferInboxItem(id) {
        return transferAction(`inbox:delete:${id}`, async () => {
          try {
            await host.post('transferInbox', { action: 'delete', id })
            transferInboxGeneration += 1
            const state = snapshot.transfer.inbox
            const items = state.items.filter((item) => item.id !== id)
            updateTransfer({
              inbox: Object.assign({}, state, { items, count: items.length, error: null }),
              toast: { kind: 'ok', text: 'transfer.toast.deleted' },
            })
            return true
          } catch (error) {
            transferFailureToast(describeFailure(error))
            return false
          }
        })
      }

      /**
       * Remove every inbox entry.
       *
       * @returns {Promise<boolean>} whether the inbox was cleared.
       */
      function clearTransferInbox() {
        return transferAction('inbox:clear', async () => {
          try {
            await host.post('transferInbox', { action: 'clear' })
            transferInboxGeneration += 1
            updateTransfer({
              inbox: { status: 'ready', items: [], count: 0, error: null },
              toast: { kind: 'ok', text: 'transfer.toast.cleared' },
            })
            return true
          } catch (error) {
            transferFailureToast(describeFailure(error))
            return false
          }
        })
      }

      /**
       * Copy one inbox text entry to the macOS clipboard.
       *
       * @param {string} id - inbox entry id.
       * @returns {Promise<boolean>} whether it was copied.
       */
      function copyTransferText(id) {
        return transferAction(`inbox:copy:${id}`, async () => {
          try {
            await host.post('transferInbox', { action: 'copyText', id })
            setTransferToast({ kind: 'ok', text: 'transfer.toast.copied' })
            return true
          } catch (error) {
            transferFailureToast(describeFailure(error))
            return false
          }
        })
      }

      /**
       * Ask Finder to reveal the file behind one inbox entry.
       *
       * @param {string} id - inbox entry id.
       * @returns {Promise<boolean>} whether Finder was asked.
       */
      function revealTransferInboxItem(id) {
        return transferAction(`inbox:reveal:${id}`, async () => {
          try {
            await host.post('transferInbox', { action: 'reveal', id })
            setTransferToast({ kind: 'ok', text: 'transfer.toast.revealed' })
            return true
          } catch (error) {
            transferFailureToast(describeFailure(error))
            return false
          }
        })
      }

      /**
       * @param {string} text - the new outbox text draft.
       * @returns {void}
       */
      function setTransferTextDraft(text) {
        updateTransfer({ textDraft: String(text) })
      }

      /**
       * Prepend freshly created outbox entries (the list is newest first).
       *
       * @param {object[]} items - the new entries.
       * @returns {object[]} the merged list.
       */
      function prependTransferOutboxItems(items) {
        transferOutboxGeneration += 1
        const state = snapshot.transfer.outbox
        const merged = items.concat(state.items)
        updateTransfer({
          outbox: Object.assign({}, state, { status: 'ready', items: merged, count: merged.length, error: null }),
        })
        return merged
      }

      /**
       * Send the current text draft to the phone.
       *
       * @returns {Promise<boolean>} whether it was queued.
       */
      async function sendTransferText() {
        if (snapshot.transfer.sendingText === true) return false
        const draft = snapshot.transfer.textDraft
        const text = draft.trim()
        if (text === '') return false
        updateTransfer({ sendingText: true })
        try {
          const value = await host.post('transferOutbox', { action: 'addText', text })
          const item = value !== null && typeof value === 'object' && value.item !== null && typeof value.item === 'object' ? value.item : null
          // Only clear the box when it still holds what was just sent: text
          // typed while the request was in flight must survive.
          const pendingDraft = snapshot.transfer.textDraft
          updateTransfer({ sendingText: false, textDraft: pendingDraft === draft ? '' : pendingDraft })
          if (item !== null) prependTransferOutboxItems([item])
          setTransferToast({ kind: 'ok', text: 'transfer.toast.sent' })
          return true
        } catch (error) {
          updateTransfer({ sendingText: false })
          transferFailureToast(describeFailure(error))
          return false
        }
      }

      /**
       * Open the native file picker and queue every chosen file. Cancelling the
       * picker is a normal outcome and stays silent.
       *
       * @returns {Promise<boolean>} whether any file was queued.
       */
      async function sendTransferFile() {
        if (snapshot.transfer.addingFile === true) return false
        updateTransfer({ addingFile: true })
        try {
          const value = await host.post('transferOutbox', { action: 'addFile' })
          const record = value !== null && typeof value === 'object' ? value : {}
          const items = Array.isArray(record.items) ? record.items : []
          updateTransfer({ addingFile: false })
          if (record.cancelled === true || items.length === 0) return false
          prependTransferOutboxItems(items)
          setTransferToast(items.length === 1
            ? { kind: 'ok', text: 'transfer.toast.fileAdded' }
            : { kind: 'ok', text: 'transfer.toast.filesAdded', params: { count: items.length } })
          return true
        } catch (error) {
          updateTransfer({ addingFile: false })
          transferFailureToast(describeFailure(error))
          return false
        }
      }

      /**
       * Queue one recent screenshot for the phone.
       *
       * @param {string} historyId - history entry id.
       * @returns {Promise<boolean>} whether it was queued.
       */
      function sendHistoryToPhone(historyId) {
        const id = String(historyId)
        if (transferHistoryRequests.has(id)) return Promise.resolve(false)
        const promise = Promise.resolve().then(async () => {
          try {
            const value = await host.post('transferOutbox', { action: 'addHistory', id })
            const item = value !== null && typeof value === 'object' && value.item !== null && typeof value.item === 'object' ? value.item : null
            if (item !== null) prependTransferOutboxItems([item])
            setTransferToast({ kind: 'ok', text: 'transfer.toast.sent' })
            return true
          } catch (error) {
            transferFailureToast(describeFailure(error))
            return false
          } finally {
            transferHistoryRequests.delete(id)
          }
        })
        transferHistoryRequests.add(id)
        return promise
      }

      /**
       * Drop one outbox entry (the file itself stays on disk).
       *
       * @param {string} id - outbox entry id.
       * @returns {Promise<boolean>} whether it was removed.
       */
      function removeTransferOutboxItem(id) {
        return transferAction(`outbox:remove:${id}`, async () => {
          try {
            await host.post('transferOutbox', { action: 'remove', id })
            transferOutboxGeneration += 1
            const state = snapshot.transfer.outbox
            const items = state.items.filter((item) => item.id !== id)
            updateTransfer({
              outbox: Object.assign({}, state, { items, count: items.length, error: null }),
              toast: { kind: 'ok', text: 'transfer.toast.removed' },
            })
            return true
          } catch (error) {
            transferFailureToast(describeFailure(error))
            return false
          }
        })
      }

      /**
       * Remove every outbox entry.
       *
       * @returns {Promise<boolean>} whether the outbox was cleared.
       */
      function clearTransferOutbox() {
        return transferAction('outbox:clear', async () => {
          try {
            await host.post('transferOutbox', { action: 'clear' })
            transferOutboxGeneration += 1
            updateTransfer({
              outbox: { status: 'ready', items: [], count: 0, error: null },
              toast: { kind: 'ok', text: 'transfer.toast.cleared' },
            })
            return true
          } catch (error) {
            transferFailureToast(describeFailure(error))
            return false
          }
        })
      }

      /** Hide the current toast (its three-second timer calls this). */
      function dismissTransferToast() {
        if (snapshot.transfer.toast === null) return
        updateTransfer({ toast: null })
      }

      /**
       * The same-origin preview URL for one inbox image.
       *
       * @param {object} item - inbox entry.
       * @returns {string} the GET URL.
       */
      function transferInboxImageUrl(item) {
        return host.inboxUrl(item)
      }

      /**
       * Ask whether a pinned window requested its image in the editor, and adopt
       * it when it did. Polled while the page is visible.
       *
       * @returns {Promise<boolean>} whether a shot was adopted.
       */
      async function pollPendingEditor() {
        if (snapshot.host.kind !== 'ready') return false
        try {
          const value = await host.post('pendingEditor', {})
          const shot = value !== null && typeof value === 'object' ? value.shot : null
          return adoptShot(shot)
        } catch {
          return false
        }
      }

      /**
       * @param {object} item - history entry.
       * @returns {string} the same-origin thumbnail URL.
       */
      function historyImageUrl(item) {
        return host.historyUrl(item)
      }

      /**
       * Turn the "hide DeepSeek Harness while capturing" preference on or off
       * for this session. The Host applies it to the next capture; the saved
       * row configuration is left alone.
       *
       * @param {boolean} enabled - the new preference.
       * @returns {void}
       */
      async function setHideApp(enabled) {
        hideAppTouched = true
        const next = enabled === true && snapshot.hideAppAvailable === true
        const previous = snapshot.hideApp
        publish({ hideApp: next })
        try {
          // The Host keeps this preference for its own screen captures too (the
          // global shortcut has no page to ask), so the toggle is shared state.
          await host.post('setHideApp', { enabled: next })
          return true
        } catch {
          publish({ hideApp: previous })
          return false
        }
      }

      /**
       * Adopt a global-hotkey status answered by the Host.
       *
       * @param {object | null} status - the controller state.
       * @returns {void}
       */
      function adoptHotkeyStatus(status) {
        if (snapshot.host.value === null) return
        const next = status !== null && typeof status === 'object' ? status : null
        publish({
          host: Object.assign({}, snapshot.host, {
            value: Object.assign({}, snapshot.host.value, { globalHotkey: next }),
          }),
        })
      }

      /** Start recording the next key combination for the global shortcut. */
      function beginHotkeyRecord() {
        publish({ hotkey: { recording: true, saving: false, error: null } })
      }

      /** Leave recording mode without changing anything. */
      function cancelHotkeyRecord() {
        publish({ hotkey: { recording: false, saving: false, error: null } })
      }

      /**
       * Ask the Host to use a new global shortcut (persisted by the Host).
       *
       * @param {string} accelerator - accelerator such as `ctrl+shift+a`.
       * @returns {Promise<boolean>} whether the Host accepted it.
       */
      async function setHotkey(accelerator) {
        publish({ hotkey: Object.assign({}, snapshot.hotkey, { saving: true, error: null }) })
        try {
          const status = await host.post('setHotkey', { accelerator })
          adoptHotkeyStatus(status)
          publish({ hotkey: { recording: false, saving: false, error: null } })
          return true
        } catch (error) {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            publish({ hotkey: Object.assign({}, snapshot.hotkey, { saving: false }) })
            return false
          }
          publish({ hotkey: { recording: false, saving: false, error: failure } })
          return false
        }
      }

      /**
       * Return the global shortcut to the configured default.
       *
       * @returns {Promise<boolean>} whether the Host accepted it.
       */
      async function resetHotkey() {
        publish({ hotkey: Object.assign({}, snapshot.hotkey, { saving: true, error: null }) })
        try {
          const status = await host.post('resetHotkey', {})
          adoptHotkeyStatus(status)
          publish({ hotkey: { recording: false, saving: false, error: null } })
          return true
        } catch (error) {
          const failure = describeFailure(error)
          publish({ hotkey: { recording: false, saving: false, error: failure } })
          return false
        }
      }

      // --- live status ----------------------------------------------------

      /**
       * Replace part of the monitor slice.
       *
       * @param {object} patch - the monitor fields to replace.
       * @returns {void}
       */
      function updateMonitor(patch) {
        publish({ monitor: Object.assign({}, snapshot.monitor, patch) })
      }

      /**
       * Replace part of the process sub-slice.
       *
       * @param {object} patch - the process fields to replace.
       * @returns {void}
       */
      function updateMonitorProcesses(patch) {
        updateMonitor({ processes: Object.assign({}, snapshot.monitor.processes, patch) })
      }

      /**
       * Replace part of the fan sub-slice.
       *
       * @param {object} patch - the fan fields to replace.
       * @returns {void}
       */
      function updateMonitorFan(patch) {
        updateMonitor({ fan: Object.assign({}, snapshot.monitor.fan, patch) })
      }

      /**
       * Replace part of the alert sub-slice.
       *
       * @param {object} patch - the alert fields to replace.
       * @returns {void}
       */
      function updateMonitorAlerts(patch) {
        updateMonitor({ alerts: Object.assign({}, snapshot.monitor.alerts, patch) })
      }

      /**
       * Read the live status snapshot. The visible tab owns the one-second
       * timer; this only dedupes in-flight requests, publishes the first-answer
       * skeleton and normalizes failures so the tab can localize them.
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether a snapshot was adopted.
       */
      function loadMonitor(options) {
        if (monitorRequest !== null) return monitorRequest
        const firstLoad = snapshot.monitor.value === null
        updateMonitor({ status: firstLoad ? 'loading' : 'ready', error: null })
        const run = host.post('monitor', {}, options).then((value) => {
          const next = value !== null && typeof value === 'object' ? value : {}
          updateMonitor({ status: 'ready', value: next, error: null, fetchedAt: Date.now() })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            updateMonitor({ status: snapshot.monitor.value === null ? 'idle' : 'ready' })
            return false
          }
          updateMonitor({
            status: snapshot.monitor.value === null ? 'error' : 'ready',
            error: failure,
          })
          return false
        }).then((result) => {
          monitorRequest = null
          return result
        }, (error) => {
          monitorRequest = null
          throw error
        })
        monitorRequest = run
        return run
      }

      /**
       * Choose one of the offered polling intervals.
       *
       * @param {number} intervalMs - 1000, 2000 or 5000.
       * @returns {void}
       */
      function setMonitorInterval(intervalMs) {
        const next = Number(intervalMs)
        if (!Number.isFinite(next) || MONITOR_INTERVALS.indexOf(next) < 0) return
        if (snapshot.monitor.intervalMs === next) return
        updateMonitor({ intervalMs: next })
      }

      /**
       * Pause or resume polling. The last snapshot stays on screen so the
       * charts freeze instead of disappearing.
       *
       * @param {boolean} paused - whether polling stops.
       * @returns {void}
       */
      function setMonitorPaused(paused) {
        updateMonitor({ paused: paused === true })
      }

      /**
       * A manual refresh; it works while paused too.
       *
       * @returns {Promise<boolean>} whether a snapshot was adopted.
       */
      function refreshMonitor() {
        return loadMonitor()
      }

      /**
       * Toggle the process section. Polling is owned by the visible tab and
       * only runs while this is open; opening seeds the first read.
       *
       * @returns {void}
       */
      function toggleMonitorProcesses() {
        const processes = snapshot.monitor.processes
        const open = processes.open !== true
        monitorProcessGeneration += 1
        updateMonitorProcesses({ open, armedPid: null, actionError: null })
        if (open) void loadMonitorProcesses()
      }

      /**
       * Switch the process ranking between CPU and memory.
       *
       * @param {string} sort - "cpu" or "memory".
       * @returns {void}
       */
      function setMonitorProcessSort(sort) {
        const next = sort === 'memory' ? 'memory' : 'cpu'
        const processes = snapshot.monitor.processes
        if (processes.sort === next) return
        monitorProcessGeneration += 1
        updateMonitorProcesses({ sort: next, armedPid: null, actionError: null })
        if (processes.open === true) void loadMonitorProcesses()
      }

      /**
       * Read the process ranking for the current sort. Deduped; a stale answer
       * for a previous sort is discarded through the generation counter.
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether the ranking was adopted.
       */
      function loadMonitorProcesses(options) {
        if (monitorProcessesRequest !== null) {
          monitorProcessesReload = true
          return monitorProcessesRequest
        }
        const state = snapshot.monitor.processes
        if (state.open !== true) return Promise.resolve(false)
        const firstLoad = state.value === null
        const keepError = firstLoad !== true && state.error !== null && state.error !== undefined
        const generation = monitorProcessGeneration
        const sort = state.sort
        let aborted = false
        updateMonitorProcesses({
          status: firstLoad ? 'loading' : (keepError ? 'error' : 'ready'),
          error: keepError ? state.error : null,
        })
        const run = host.post('monitorProcesses', { sort }, options).then((value) => {
          if (generation !== monitorProcessGeneration) return false
          const record = value !== null && typeof value === 'object' ? value : {}
          const processes = Array.isArray(record.processes) ? record.processes : []
          const count = Number.isFinite(record.count) ? record.count : processes.length
          updateMonitorProcesses({
            status: 'ready',
            value: {
              sampledAt: typeof record.sampledAt === 'string' ? record.sampledAt : '',
              sort: typeof record.sort === 'string' ? record.sort : sort,
              count,
              processes,
            },
            error: null,
          })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          const current = snapshot.monitor.processes
          if (failure.code === 'aborted') {
            // The tab hid or unmounted: do not re-read for a pending sort
            // change after the page went away.
            aborted = true
            updateMonitorProcesses({ status: current.value === null ? 'idle' : 'ready' })
            return false
          }
          if (generation !== monitorProcessGeneration) return false
          updateMonitorProcesses({
            status: current.value === null ? 'error' : 'ready',
            error: failure,
          })
          return false
        }).then((result) => {
          monitorProcessesRequest = null
          if (aborted !== true) drainMonitorProcessesReload()
          return result
        }, (error) => {
          monitorProcessesRequest = null
          if (aborted !== true) drainMonitorProcessesReload()
          throw error
        })
        monitorProcessesRequest = run
        return run
      }

      /**
       * Re-read the ranking when a sort change landed mid-flight, so the rows
       * always match the selected sort instead of waiting for the next tick.
       *
       * @returns {void}
       */
      function drainMonitorProcessesReload() {
        if (monitorProcessesReload !== true) return
        monitorProcessesReload = false
        if (snapshot.monitor.processes.open !== true) return
        void loadMonitorProcesses()
      }

      /**
       * Arm the inline "confirm?" state for one process.
       *
       * @param {number} pid - the target pid.
       * @returns {void}
       */
      function armProcessKill(pid) {
        const target = Number(pid)
        if (!Number.isInteger(target) || target <= 1) return
        const processes = snapshot.monitor.processes
        updateMonitorProcesses({
          armedPid: processes.armedPid === target ? null : target,
          actionError: null,
        })
      }

      /**
       * Disarm the inline kill confirmation.
       *
       * @returns {void}
       */
      function cancelProcessKill() {
        if (snapshot.monitor.processes.armedPid === null) return
        updateMonitorProcesses({ armedPid: null })
      }

      /**
       * Send SIGTERM to one process through the Host. Only an armed pid can be
       * killed; pid 1 and invalid pids are refused locally, and the Host's
       * documented error codes are the final authority.
       *
       * @param {number} pid - the target pid.
       * @returns {Promise<boolean>} whether the process was signalled.
       */
      function killMonitorProcess(pid) {
        const target = Number(pid)
        const processes = snapshot.monitor.processes
        if (processes.armedPid !== target) return Promise.resolve(false)
        if (!Number.isInteger(target) || target <= 1) return Promise.resolve(false)
        if (processes.killingPid !== null) return Promise.resolve(false)
        updateMonitorProcesses({ armedPid: null, killingPid: target, actionError: null })
        return host.post('monitorKill', { pid: target }).then(() => {
          const current = snapshot.monitor.processes
          const value = current.value
          let nextValue = value
          if (value !== null && typeof value === 'object' && Array.isArray(value.processes)) {
            const rest = value.processes.filter((row) => row === null || typeof row !== 'object' || row.pid !== target)
            nextValue = Object.assign({}, value, { processes: rest, count: rest.length })
          }
          updateMonitorProcesses({ killingPid: null, value: nextValue })
          void loadMonitorProcesses()
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          updateMonitorProcesses({ killingPid: null, actionError: failure })
          return false
        })
      }

      /** Drop the last process-action failure. */
      function dismissMonitorProcessError() {
        if (snapshot.monitor.processes.actionError === null) return
        updateMonitorProcesses({ actionError: null })
      }

      /**
       * Extract a fanControl block from either a bare block (fan endpoints) or
       * a `{ fanControl }` wrapper, defensively.
       *
       * @param {any} value - the Host answer.
       * @returns {object|null} the fanControl block.
       */
      function fanBlockOf(value) {
        if (value === null || typeof value !== 'object') return null
        if (value.fanControl !== null && typeof value.fanControl === 'object') return value.fanControl
        if (typeof value.state === 'string' && value.state !== '') return value
        return null
      }

      /**
       * Merge a fresh fanControl block into the last monitor snapshot.
       *
       * @param {any} value - a fan endpoint answer or the monitor snapshot.
       * @returns {boolean} whether a block was adopted.
       */
      function adoptFanControl(value) {
        const block = fanBlockOf(value)
        if (block === null) return false
        const monitor = snapshot.monitor
        const current = monitor.value
        if (current === null || typeof current !== 'object') {
          updateMonitor({ value: { fanControl: block } })
          return true
        }
        updateMonitor({ value: Object.assign({}, current, { fanControl: block }) })
        return true
      }

      /**
       * Merge a fresh preset list ({ presets: [...] }) into the last fan block.
       *
       * @param {any} value - the `fanPreset` answer.
       * @returns {boolean} whether a list was adopted.
       */
      function adoptFanPresets(value) {
        const presets = value !== null && typeof value === 'object' && Array.isArray(value.presets) ? value.presets : null
        if (presets === null) return false
        const monitor = snapshot.monitor
        const current = monitor.value
        if (current === null || typeof current !== 'object') return false
        const fanControl = current.fanControl !== null && typeof current.fanControl === 'object'
          ? Object.assign({}, current.fanControl, { presets })
          : { presets }
        updateMonitor({ value: Object.assign({}, current, { fanControl }) })
        return true
      }

      /**
       * Install the privileged fan helper. Blocking: the Host compiles the
       * Swift helper once and asks for the administrator password; the pending
       * flag drives the "waiting for authorization" card the whole time.
       *
       * @returns {Promise<boolean>} whether fan control is ready afterwards.
       */
      function fanInstall() {
        if (snapshot.monitor.fan.pending !== null) return Promise.resolve(false)
        updateMonitorFan({ pending: 'install', error: null })
        return host.post('fanInstall', {}).then((value) => {
          adoptFanControl(value)
          updateMonitorFan({ pending: null, error: null })
          void loadMonitor()
          return true
        }).catch((error) => {
          updateMonitorFan({ pending: null, error: describeFailure(error) })
          return false
        })
      }

      /**
       * Remove the privileged fan helper (the Host restores system auto first).
       *
       * @returns {Promise<boolean>} whether the helper was removed.
       */
      function fanUninstall() {
        if (snapshot.monitor.fan.pending !== null) return Promise.resolve(false)
        updateMonitorFan({ pending: 'uninstall', error: null })
        return host.post('fanUninstall', {}).then((value) => {
          adoptFanControl(value)
          updateMonitorFan({ pending: null, error: null })
          void loadMonitor()
          return true
        }).catch((error) => {
          updateMonitorFan({ pending: null, error: describeFailure(error) })
          return false
        })
      }

      /**
       * Take fan control: exactly one of the documented payload shapes.
       * A release that lands while another write is in flight is queued, and
       * the newest one wins (the slider releases faster than the round trip).
       *
       * @param {{ mode: string, rpm?: number, sensor?: string, points?: object[] }} payload - the fanApply payload.
       * @returns {Promise<boolean>} whether the Host accepted the write.
       */
      function fanApply(payload) {
        const request = payload !== null && typeof payload === 'object' ? payload : null
        if (request === null) return Promise.resolve(false)
        const fan = snapshot.monitor.fan
        if (fan.pending === 'install' || fan.pending === 'uninstall') return Promise.resolve(false)
        if (fan.pending !== null) {
          pendingFanApply = request
          return Promise.resolve(false)
        }
        updateMonitorFan({ pending: 'apply', error: null })
        const run = host.post('fanApply', request).then((value) => {
          adoptFanControl(value)
          updateMonitorFan({ pending: null, error: null })
          return true
        }).catch((error) => {
          updateMonitorFan({ pending: null, error: describeFailure(error) })
          return false
        }).then((result) => {
          drainPendingFanApply()
          return result
        })
        return run
      }

      /**
       * Send the newest queued fan write (if any) once the fan state is idle
       * again. The slider releases faster than the round trip, so a release
       * that lands mid-write replaces any earlier queued release.
       *
       * @returns {void}
       */
      function drainPendingFanApply() {
        if (pendingFanApply === null) return
        if (snapshot.monitor.fan.pending !== null) return
        const next = pendingFanApply
        pendingFanApply = null
        void fanApply(next)
      }

      /**
       * Save the current manual/curve draft as a custom preset.
       *
       * @param {{ name: string, mode: string, rpm?: number, sensor?: string, points?: object[] }} draft - the preset.
       * @returns {Promise<boolean>} whether it was saved.
       */
      function fanSavePreset(draft) {
        if (snapshot.monitor.fan.pending !== null) return Promise.resolve(false)
        const source = draft !== null && typeof draft === 'object' ? draft : {}
        const name = typeof source.name === 'string' ? source.name.trim() : ''
        const mode = source.mode === 'curve' ? 'curve' : (source.mode === 'manual' ? 'manual' : '')
        if (name === '' || mode === '') {
          const error = new Error('a preset needs a name and a manual or curve mode')
          error.code = 'invalid_request'
          error.details = {}
          updateMonitorFan({ error: describeFailure(error) })
          return Promise.resolve(false)
        }
        const payload = { op: 'save', name, mode }
        if (mode === 'manual') payload.rpm = Number(source.rpm)
        if (mode === 'curve') {
          payload.sensor = typeof source.sensor === 'string' ? source.sensor : ''
          payload.points = Array.isArray(source.points) ? source.points : []
        }
        updateMonitorFan({ pending: 'preset', error: null })
        return host.post('fanPreset', payload).then((value) => {
          adoptFanPresets(value)
          updateMonitorFan({ pending: null, error: null })
          drainPendingFanApply()
          return true
        }).catch((error) => {
          updateMonitorFan({ pending: null, error: describeFailure(error) })
          drainPendingFanApply()
          return false
        })
      }

      /**
       * Delete one custom preset.
       *
       * @param {string} id - the preset id.
       * @returns {Promise<boolean>} whether it was deleted.
       */
      function fanDeletePreset(id) {
        if (snapshot.monitor.fan.pending !== null) return Promise.resolve(false)
        const presetId = String(id)
        if (presetId === '') return Promise.resolve(false)
        updateMonitorFan({ pending: 'preset', error: null })
        return host.post('fanPreset', { op: 'delete', id: presetId }).then((value) => {
          adoptFanPresets(value)
          updateMonitorFan({ pending: null, error: null })
          drainPendingFanApply()
          return true
        }).catch((error) => {
          updateMonitorFan({ pending: null, error: describeFailure(error) })
          drainPendingFanApply()
          return false
        })
      }

      /** Drop the last fan failure notice. */
      function dismissFanError() {
        if (snapshot.monitor.fan.error === null) return
        updateMonitorFan({ error: null })
      }

      /**
       * Merge an alerts block ({ settings, events }) into the last snapshot.
       *
       * @param {any} value - the monitorAlertSave answer.
       * @returns {object|null} the normalized settings.
       */
      function adoptMonitorAlerts(value) {
        const record = value !== null && typeof value === 'object' ? value : null
        if (record === null) return null
        const settings = record.settings !== null && typeof record.settings === 'object' ? record.settings : null
        if (settings === null) return null
        const events = Array.isArray(record.events) ? record.events : []
        const monitor = snapshot.monitor
        const current = monitor.value
        if (current !== null && typeof current === 'object') {
          updateMonitor({ value: Object.assign({}, current, { alerts: { settings, events } }) })
        }
        return settings
      }

      /**
       * Persist threshold settings through the Host (the Host clamps values).
       *
       * @param {object} patch - any subset of the alert settings.
       * @returns {Promise<{ok:boolean, settings:object|null, error:object|null}>} the result.
       */
      function saveMonitorAlerts(patch) {
        if (monitorAlertSaveRequest !== null) return monitorAlertSaveRequest
        const request = patch !== null && typeof patch === 'object' ? patch : {}
        updateMonitorAlerts({ saving: true, error: null })
        const run = host.post('monitorAlertSave', request).then((value) => {
          const settings = adoptMonitorAlerts(value)
          updateMonitorAlerts({ saving: false, error: null })
          return { ok: true, settings, error: null }
        }).catch((error) => {
          const failure = describeFailure(error)
          updateMonitorAlerts({ saving: false, error: failure })
          return { ok: false, settings: null, error: failure }
        }).then((result) => {
          monitorAlertSaveRequest = null
          return result
        }, (error) => {
          monitorAlertSaveRequest = null
          throw error
        })
        monitorAlertSaveRequest = run
        return run
      }

      /**
       * Fire one test notification through the Host.
       *
       * @returns {Promise<{ok:boolean, notified:boolean, error:object|null}>} the result.
       */
      function testMonitorAlerts() {
        if (monitorAlertTestRequest !== null) return monitorAlertTestRequest
        updateMonitorAlerts({ testing: true, error: null })
        const run = host.post('monitorAlertTest', {}).then((value) => {
          updateMonitorAlerts({ testing: false, error: null })
          return {
            ok: true,
            notified: value !== null && typeof value === 'object' && value.notified === true,
            error: null,
          }
        }).catch((error) => {
          const failure = describeFailure(error)
          updateMonitorAlerts({ testing: false, error: failure })
          return { ok: false, notified: false, error: failure }
        }).then((result) => {
          monitorAlertTestRequest = null
          return result
        }, (error) => {
          monitorAlertTestRequest = null
          throw error
        })
        monitorAlertTestRequest = run
        return run
      }

      /** Drop the last alert failure notice. */
      function dismissMonitorAlertsError() {
        if (snapshot.monitor.alerts.error === null) return
        updateMonitorAlerts({ error: null })
      }

      return {
        /** @returns {object} the current snapshot. */
        getSnapshot: () => snapshot,
        /**
         * @param {() => void} listener - called after every change.
         * @returns {() => void} the unsubscribe.
         */
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        loadHost,
        loadWindows,
        capture,
        cancelCapture,
        selectTab,
        discardShot,
        dismissCaptureError,
        setCalcExpression,
        clearCalculator,
        evaluateCalc,
        copyShot,
        saveShot,
        pinShot,
        revealPath,
        setHideApp,
        beginHotkeyRecord,
        cancelHotkeyRecord,
        setHotkey,
        resetHotkey,
        loadHistory,
        openHistory,
        deleteHistory,
        clearHistory,
        pinHistory,
        copyHistory,
        pollPendingEditor,
        historyImageUrl,
        loadMonitor,
        refreshMonitor,
        setMonitorInterval,
        setMonitorPaused,
        toggleMonitorProcesses,
        setMonitorProcessSort,
        loadMonitorProcesses,
        armProcessKill,
        cancelProcessKill,
        killMonitorProcess,
        dismissMonitorProcessError,
        fanInstall,
        fanUninstall,
        fanApply,
        fanSavePreset,
        fanDeletePreset,
        dismissFanError,
        saveMonitorAlerts,
        testMonitorAlerts,
        dismissMonitorAlertsError,
        loadTransferStatus,
        startTransfer,
        stopTransfer,
        refreshTransferInbox,
        refreshTransferOutbox,
        deleteTransferInboxItem,
        clearTransferInbox,
        copyTransferText,
        revealTransferInboxItem,
        setTransferTextDraft,
        sendTransferText,
        sendTransferFile,
        sendHistoryToPhone,
        removeTransferOutboxItem,
        clearTransferOutbox,
        dismissTransferToast,
        transferInboxImageUrl,
      }
    }

    /**
     * Subscribe a component to the store.
     *
     * @param {object} store - the panel store.
     * @returns {object} the current snapshot.
     */
    function useStoreSnapshot(store) {
      const [state, setState] = React.useState(store.getSnapshot())
      React.useEffect(() => store.subscribe(() => setState(store.getSnapshot())), [store])
      return state
    }

    // ---------------------------------------------------------------------
    // Screenshot tab
    // ---------------------------------------------------------------------

    /** KeyboardEvent.code values the accelerator parser spells differently. */
    const ACCELERATOR_KEY_CODES = {
      Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
      BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-',
      Equal: '=', Backquote: '`', Space: 'space', Enter: 'return', Tab: 'tab',
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    }

    /**
     * Translate one keydown into the parser's key token.
     *
     * @param {object} event - the KeyboardEvent.
     * @returns {string | null} the key token, or null for a key the parser does not know.
     */
    function acceleratorKeyFromEvent(event) {
      const code = event !== null && typeof event === 'object' && typeof event.code === 'string' ? event.code : ''
      if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase()
      if (/^Digit[0-9]$/u.test(code)) return code.slice(5)
      if (/^F(?:[1-9]|1[0-9]|20)$/u.test(code)) return code.toLowerCase()
      return Object.hasOwn(ACCELERATOR_KEY_CODES, code) ? ACCELERATOR_KEY_CODES[code] : null
    }

    /**
     * Translate one keydown into an accelerator such as `ctrl+shift+a`.
     *
     * @param {object} event - the KeyboardEvent.
     * @returns {string | null} the accelerator, or null when the key is not usable.
     */
    function acceleratorFromEvent(event) {
      const key = acceleratorKeyFromEvent(event)
      if (key === null) return null
      const parts = []
      if (event.ctrlKey === true) parts.push('ctrl')
      if (event.altKey === true) parts.push('alt')
      if (event.shiftKey === true) parts.push('shift')
      if (event.metaKey === true) parts.push('cmd')
      return parts.concat(key).join('+')
    }

    /**
     * Localize one hotkey-check failure.
     *
     * @param {Function} t - the bound translator.
     * @param {object} error - the normalized failure.
     * @returns {string} display text.
     */
    function hotkeyErrorText(t, error) {
      if (error === null || error === undefined) return ''
      if (error.code === 'invalid_hotkey') return t('capture.hotkeyInvalid')
      if (error.code === 'unsupported') return t('capture.hotkeyUnavailable')
      return t('capture.hotkeyError', { message: error.message })
    }

    /**
     * The in-flight capture hint for a mode, localized.
     *
     * @param {Function} t - the bound translator.
     * @param {string} mode - the capture mode.
     * @returns {string} the hint.
     */
    function captureHintText(t, mode) {
      if (mode === 'interactive') return t('capture.hint.interactive')
      if (mode === 'interactive-region') return t('capture.hint.region')
      if (mode === 'interactive-window') return t('capture.hint.window')
      return t('capture.hint.default')
    }

    /**
     * A small labelled glyph button used in the editor's action bar.
     *
     * @param {object} props - the button props.
     * @returns {object} the element.
     */
    function IconButton({ name, label, onClick, disabled, danger, size }) {
      const className = danger
        ? 'dshMacToolsIconButton dshMacToolsIconButtonDanger'
        : 'dshMacToolsIconButton'
      return h('button', {
        type: 'button',
        className,
        title: label,
        'aria-label': label,
        disabled: disabled === true,
        onClick,
      }, glyph(name, typeof size === 'number' ? size : 15))
    }

    /**
     * The window picker: filter input, refresh, and one row per on-screen app
     * window. Clicking a row captures that window by id.
     *
     * @param {object} props - picker props.
     * @returns {object} the element.
     */
    function WindowPicker({ store, snapshot, t, onPicked }) {
      const [filter, setFilter] = React.useState('')
      const windows = snapshot.windows
      const capturing = snapshot.capture.status === 'running'
      /** The picker's own abort scope: leaving the panel aborts its read. */
      const controllerRef = React.useRef(null)
      const refreshWindows = () => {
        const controller = controllerRef.current
        void store.loadWindows(controller === null ? undefined : { signal: controller.signal })
      }

      // Windows move around, so the picker refreshes every time it opens; the
      // store de-duplicates a request that is already in flight.
      React.useEffect(() => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        controllerRef.current = controller
        void store.loadWindows(controller === null ? undefined : { signal: controller.signal })
        return () => {
          controllerRef.current = null
          if (controller !== null) controller.abort()
        }
      }, [store])

      const needle = filter.trim().toLowerCase()
      const rows = needle === ''
        ? windows.list
        : windows.list.filter((entry) => {
          const haystack = `${entry.app || ''} ${entry.title || ''}`.toLowerCase()
          return haystack.indexOf(needle) >= 0
        })

      const header = h('div', { key: 'header', className: 'dshMacToolsWindowsHeader' }, [
        h('h3', { key: 'title', className: 'dshMacToolsWindowsTitle' }, t('windows.title')),
        h('span', { key: 'count', className: 'dshMacToolsWindowsCount' }, t('windows.count', { count: windows.list.length })),
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          disabled: windows.status === 'loading',
          onClick: refreshWindows,
        }, [glyph('refresh', 13, 'icon'), h('span', { key: 'label' }, t('windows.refresh'))]),
      ])

      const filterRow = h('div', { key: 'filter', className: 'dshMacToolsWindowsHeader', style: { marginTop: 8 } }, [
        h('input', {
          key: 'input',
          className: 'dshMacToolsInput dshMacToolsWindowsFilter',
          type: 'search',
          value: filter,
          placeholder: t('windows.filter'),
          'aria-label': t('windows.filter'),
          onChange: (event) => setFilter(event.target.value),
        }),
      ])

      let listBody
      if (windows.status === 'loading' && windows.list.length === 0) {
        listBody = h('p', { key: 'loading', className: 'dshMacToolsHint' }, [
          h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }),
          ' ',
          t('windows.loading'),
        ])
      } else if (windows.status === 'error' && windows.error !== null) {
        listBody = h('div', { key: 'error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, hostErrorText(t, windows.error, 'windows.error')),
          h('button', {
            key: 'retry',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact',
            onClick: refreshWindows,
          }, t('common.retry')),
        ])
      } else if (rows.length === 0) {
        listBody = h('div', { key: 'empty', className: 'dshMacToolsEmpty' }, [
          h('div', { key: 'art', className: 'dshMacToolsEmptyArt', 'aria-hidden': true }, glyph('windows', 22)),
          h('p', { key: 'title', className: 'dshMacToolsEmptyTitle' }, t('windows.empty')),
          h('p', { key: 'hint', className: 'dshMacToolsEmptyHint' }, t('windows.emptyHint')),
        ])
      } else {
        listBody = h('ul', { key: 'list', className: 'dshMacToolsWindowsList' }, rows.map((entry, index) => {
          const app = typeof entry.app === 'string' && entry.app !== '' ? entry.app : t('system.unknown')
          const title = typeof entry.title === 'string' ? entry.title : ''
          const size = Number.isFinite(entry.w) && Number.isFinite(entry.h) ? `${entry.w} × ${entry.h}` : ''
          return h('li', { key: typeof entry.id === 'string' ? entry.id : `window-${index}` }, h('button', {
            type: 'button',
            className: 'dshMacToolsWindowRow',
            disabled: capturing,
            title: t('windows.captureAria', { app }),
            'aria-label': t('windows.captureAria', { app }),
            onClick: () => {
              if (typeof onPicked === 'function') onPicked()
              void store.capture({ mode: 'window', windowId: entry.id })
            },
          }, [
            h('span', { key: 'text', className: 'dshMacToolsWindowText' }, [
              h('span', { key: 'app', className: 'dshMacToolsWindowApp' }, app),
              title === '' ? null : h('span', { key: 'title', className: 'dshMacToolsWindowTitle' }, title),
            ]),
            h('span', { key: 'meta', className: 'dshMacToolsWindowMeta' }, [
              size === '' ? null : h('span', { key: 'size', className: 'dshMacToolsWindowSize' }, size),
              entry.frontmost === true ? h('span', { key: 'front', className: 'dshMacToolsBadge' }, t('windows.frontmost')) : null,
            ]),
          ]))
        }))
      }

      return h('div', { className: 'dshMacToolsWindowsPanel' }, [
        header,
        filterRow,
        h('p', { key: 'hint', className: 'dshMacToolsHint' }, t('windows.hint')),
        listBody,
      ])
    }

    /**
     * The annotation editor for the current shot.
     *
     * The visible canvas backing store is always the image's natural size and
     * CSS scales it for display, so pointer coordinates are mapped through the
     * element's bounding rect and exported PNGs keep the capture's real
     * resolution. Undo/redo is a stack of whole op lists; applying a crop
     * flattens the composite into a new base image and deliberately clears that
     * history, which the crop bar says out loud.
     *
     * @param {object} props - editor props.
     * @returns {object} the element.
     */
    function ScreenshotEditor({ store, snapshot, t, active }) {
      const shot = snapshot.shot
      const [base, setBase] = React.useState(null)
      const [baseStatus, setBaseStatus] = React.useState('loading')
      const [baseError, setBaseError] = React.useState('')
      const [annotations, setAnnotations] = React.useState(emptyAnnotations)
      const [tool, setTool] = React.useState('arrow')
      const [color, setColor] = React.useState(COLORS[0].value)
      const [widthIndex, setWidthIndex] = React.useState(1)
      const [draft, setDraft] = React.useState(null)
      const [crop, setCrop] = React.useState(null)
      const [textDraft, setTextDraft] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const [busy, setBusy] = React.useState(null)

      const canvasRef = React.useRef(null)
      const stageRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const textCancelRef = React.useRef(false)
      /** The latest keyboard handlers, so the document listener registers once. */
      const handlersRef = React.useRef({})
      /** The latest committed ops, so export/crop never read a stale closure. */
      const annotationsRef = React.useRef(annotations)
      annotationsRef.current = annotations

      // Build the immutable base image once per shot. Drawing the loaded PNG
      // into an offscreen canvas at natural size is what makes mosaics and crop
      // flattening read real pixels rather than CSS-scaled ones.
      React.useEffect(() => {
        const shotValue = shot
        if (shotValue === null || shotValue === undefined) {
          setBase(null)
          setBaseStatus('idle')
          setBaseError('')
          setAnnotations(emptyAnnotations())
          setCrop(null)
          setTextDraft(null)
          setDraft(null)
          dragRef.current = null
          return () => {}
        }
        let cancelled = false
        setBaseStatus('loading')
        setBase(null)
        setBaseError('')
        setAnnotations(emptyAnnotations())
        setCrop(null)
        setTextDraft(null)
        setDraft(null)
        dragRef.current = null
        const image = typeof Image === 'function' ? new Image() : document.createElement('img')
        image.onload = () => {
          if (cancelled) return
          const width = image.naturalWidth || image.width || shotValue.width || 1
          const height = image.naturalHeight || image.height || shotValue.height || 1
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(width))
          canvas.height = Math.max(1, Math.round(height))
          const context = canvas.getContext('2d')
          if (!context) {
            setBaseStatus('error')
            setBaseError('this browser cannot create a 2D canvas')
            return
          }
          context.drawImage(image, 0, 0)
          setBase({ canvas, width: canvas.width, height: canvas.height })
          setBaseStatus('ready')
        }
        image.onerror = () => {
          if (cancelled) return
          setBaseStatus('error')
          setBaseError('the captured PNG could not be loaded')
        }
        image.src = shotValue.imageUrl
        return () => {
          cancelled = true
          image.onload = null
          image.onerror = null
        }
      }, [shot])

      // Repaint whenever the model changes. The canvas element is at natural
      // size, so this is the only place the image is scaled — by CSS.
      React.useEffect(() => {
        paintCanvas(canvasRef.current, base === null ? null : base.canvas, annotations.ops, draft, crop)
      }, [base, annotations.ops, draft, crop])

      // Focus the inline text field as soon as it appears.
      React.useEffect(() => {
        if (textDraft === null) return
        const node = inputRef.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }, [textDraft === null])

      // Transient toast: one timer, cleared when it is dismissed or replaced.
      React.useEffect(() => {
        if (toast === null) return () => {}
        const timer = setTimeout(() => setToast(null), 4200)
        return () => clearTimeout(timer)
      }, [toast])

      const commitOp = (op) => {
        setAnnotations((previous) => ({
          ops: previous.ops.concat([op]),
          past: previous.past.concat([previous.ops]),
          future: [],
        }))
        setDraft(null)
      }

      const undo = () => {
        setAnnotations((previous) => {
          if (previous.past.length === 0) return previous
          const priorOps = previous.past[previous.past.length - 1]
          return {
            ops: priorOps,
            past: previous.past.slice(0, -1),
            future: previous.future.concat([previous.ops]),
          }
        })
      }

      const redo = () => {
        setAnnotations((previous) => {
          if (previous.future.length === 0) return previous
          const nextOps = previous.future[previous.future.length - 1]
          return {
            ops: nextOps,
            past: previous.past.concat([previous.ops]),
            future: previous.future.slice(0, -1),
          }
        })
      }

      const resetAnnotations = () => {
        setAnnotations((previous) => {
          if (previous.ops.length === 0) return previous
          return { ops: [], past: previous.past.concat([previous.ops]), future: [] }
        })
      }

      /**
       * Stroke width in natural pixels: the toolbar's 3/6/10 are what the user
       * sees at the current fit, so they are divided by the display scale.
       */
      const naturalStrokeWidth = (canvas) => {
        const rect = canvas.getBoundingClientRect()
        const scale = canvas.width / Math.max(1, rect.width)
        const display = STROKE_WIDTHS[widthIndex].value
        return Math.max(1, Math.round(display * scale))
      }

      const applyCrop = () => {
        if (base === null || crop === null) return
        const composite = flattenComposite(base.canvas, annotationsRef.current.ops)
        if (composite === null) return
        const cropped = cropComposite(composite, crop)
        if (cropped === null) return
        setBase({ canvas: cropped, width: cropped.width, height: cropped.height })
        setAnnotations(emptyAnnotations())
        setCrop(null)
        setDraft(null)
        dragRef.current = null
      }

      const commitText = () => {
        const current = textDraft
        setTextDraft(null)
        if (current === null) return
        if (textCancelRef.current) {
          textCancelRef.current = false
          return
        }
        const value = current.value.trim()
        if (value === '') return
        commitOp({ type: 'text', text: value, color, size: current.size, x: current.x, y: current.y })
      }

      const cancelText = () => {
        textCancelRef.current = true
        setTextDraft(null)
      }

      const onPointerDown = (event) => {
        if (base === null) return
        if (typeof event.button === 'number' && event.button !== 0) return
        if (textDraft !== null) return
        const canvas = canvasRef.current
        if (canvas === null || canvas === undefined) return
        const point = canvasPoint(canvas, event)
        try {
          if (typeof canvas.setPointerCapture === 'function' && event.pointerId !== undefined) {
            canvas.setPointerCapture(event.pointerId)
          }
        } catch (error) {
          // Pointer capture is an optimization; dragging still works without it.
        }
        if (tool === 'crop') {
          dragRef.current = { kind: 'crop', start: point }
          setCrop({ x: point.x, y: point.y, w: 0, h: 0 })
          return
        }
        if (tool === 'text') {
          textCancelRef.current = false
          const canvasRect = canvas.getBoundingClientRect()
          const stage = stageRef.current
          const stageRect = stage !== null && stage !== undefined && typeof stage.getBoundingClientRect === 'function'
            ? stage.getBoundingClientRect()
            : canvasRect
          const scrollLeft = stage !== null && stage !== undefined && typeof stage.scrollLeft === 'number' ? stage.scrollLeft : 0
          const scrollTop = stage !== null && stage !== undefined && typeof stage.scrollTop === 'number' ? stage.scrollTop : 0
          const scale = canvas.width / Math.max(1, canvasRect.width)
          setTextDraft({
            x: point.x,
            y: point.y,
            left: event.clientX - stageRect.left + scrollLeft,
            top: event.clientY - stageRect.top + scrollTop,
            size: TEXT_DISPLAY_SIZE * scale,
            value: '',
          })
          return
        }
        const width = naturalStrokeWidth(canvas)
        dragRef.current = { kind: tool, start: point, color, width, points: [point] }
        setDraft({ type: tool, from: point, to: point, points: [point], color, width })
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        const canvas = canvasRef.current
        if (canvas === null || canvas === undefined) return
        const point = canvasPoint(canvas, event)
        if (drag.kind === 'crop') {
          setCrop(rectFromPoints(drag.start, point))
          return
        }
        if (drag.kind === 'pen' || drag.kind === 'highlight') {
          const points = drag.points
          const last = points[points.length - 1]
          const minDistance = Math.max(1, (drag.width || 1) * 0.5)
          if (Math.hypot(point.x - last.x, point.y - last.y) < minDistance) return
          drag.points = points.concat([point])
          setDraft({ type: drag.kind, color: drag.color, width: drag.width, points: drag.points })
          return
        }
        setDraft({ type: drag.kind, from: drag.start, to: point, color: drag.color, width: drag.width })
      }

      const onPointerUp = (event) => {
        const drag = dragRef.current
        dragRef.current = null
        if (drag === null) return
        const canvas = canvasRef.current
        if (canvas === null || canvas === undefined) return
        const point = canvasPoint(canvas, event)
        if (drag.kind === 'crop') {
          const rect = rectFromPoints(drag.start, point)
          setCrop(rect.w >= 4 && rect.h >= 4 ? rect : null)
          return
        }
        const op = drag.kind === 'pen' || drag.kind === 'highlight'
          ? { type: drag.kind, color: drag.color, width: drag.width, points: drag.points.concat([point]) }
          : { type: drag.kind, from: drag.start, to: point, color: drag.color, width: drag.width }
        setDraft(null)
        if (isSubstantialOp(op)) commitOp(op)
      }

      const onPointerCancel = () => {
        const drag = dragRef.current
        dragRef.current = null
        setDraft(null)
        if (drag !== null && drag.kind === 'crop') setCrop(null)
      }

      // The editor's keyboard model. It is a component-owned document listener
      // registered only while the editor is visible, and removed on unmount or
      // when the tab is switched away, so no global listener outlives the panel.
      handlersRef.current = {
        undo,
        redo,
        applyCrop,
        cancelCrop: () => setCrop(null),
        cancelDraft: () => {
          dragRef.current = null
          setDraft(null)
        },
        close: () => store.discardShot(),
        cropPending: crop !== null,
        drafting: draft !== null,
      }
      React.useEffect(() => {
        if (!active || base === null) return () => {}
        const onKeyDown = (event) => {
          const handlers = handlersRef.current
          const target = event.target
          const tag = target !== null && target !== undefined && typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
          const editing = tag === 'input' || tag === 'textarea' || tag === 'select'
            || (target !== null && target !== undefined && target.isContentEditable === true)
          if (editing) return
          const primary = event.metaKey || event.ctrlKey
          if (primary && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
            event.preventDefault()
            if (event.shiftKey) handlers.redo()
            else handlers.undo()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            if (handlers.cropPending) handlers.cancelCrop()
            else if (handlers.drafting) handlers.cancelDraft()
            else handlers.close()
            return
          }
          if (event.key === 'Enter' && handlers.cropPending) {
            event.preventDefault()
            handlers.applyCrop()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [active, base === null])

      const runAction = async (kind) => {
        if (busy !== null || base === null) return
        const composite = flattenComposite(base.canvas, annotationsRef.current.ops)
        if (composite === null) return
        setBusy(kind)
        try {
          const pngBase64 = canvasToBase64(composite)
          if (kind === 'copy') {
            await store.copyShot(pngBase64)
            setToast({ kind: 'success', text: t('editor.copied') })
          } else if (kind === 'pin') {
            await store.pinShot(pngBase64, shot !== null && typeof shot === 'object' ? shot.id : undefined)
            setToast({ kind: 'success', text: t('editor.pinned') })
          } else {
            const saved = await store.saveShot(pngBase64)
            const path = saved !== null && typeof saved === 'object' && typeof saved.path === 'string' ? saved.path : ''
            setToast({ kind: 'success', text: t('editor.saved', { path }), path })
          }
        } catch (error) {
          const failure = describeFailure(error)
          if (failure.code !== 'aborted') setToast({ kind: 'error', text: actionErrorText(t, failure) })
        } finally {
          setBusy(null)
        }
      }

      const revealToastPath = async (path) => {
        try {
          await store.revealPath(path)
          setToast(null)
        } catch (error) {
          const failure = describeFailure(error)
          if (failure.code !== 'aborted') {
            setToast({ kind: 'error', text: hostErrorText(t, failure, 'editor.revealFailed') })
          }
        }
      }

      const canvasSizeLabel = t('editor.meta', {
        width: base === null ? shot.width : base.width,
        height: base === null ? shot.height : base.height,
        mode: modeText(t, shot),
      })
      const shotWindow = shot !== null && typeof shot === 'object' && shot.window !== null && typeof shot.window === 'object' ? shot.window : null
      const shotAt = shot !== null && typeof shot === 'object' ? formatDateTime(shot.at) : ''

      const canUndo = annotations.past.length > 0
      const canRedo = annotations.future.length > 0
      const canReset = annotations.ops.length > 0
      const cropReady = crop !== null && crop.w >= 4 && crop.h >= 4

      const actionButtons = [
        h('button', {
          key: 'copy',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          disabled: base === null || busy !== null,
          onClick: () => { void runAction('copy') },
        }, [glyph('copy', 13, 'icon'), h('span', { key: 'label' }, busy === 'copy' ? t('editor.copying') : t('editor.copy'))]),
        h('button', {
          key: 'pin',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          disabled: base === null || busy !== null,
          title: t('editor.pinned'),
          onClick: () => { void runAction('pin') },
        }, [glyph('pin', 13, 'icon'), h('span', { key: 'label' }, busy === 'pin' ? t('editor.pinning') : t('editor.pin'))]),
        h('button', {
          key: 'save',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonPrimary',
          disabled: base === null || busy !== null,
          onClick: () => { void runAction('save') },
        }, [glyph('save', 13, 'icon'), h('span', { key: 'label' }, busy === 'save' ? t('editor.saving') : t('editor.save'))]),
        h(IconButton, {
          key: 'close',
          name: 'close',
          label: t('editor.close'),
          onClick: () => store.discardShot(),
        }),
      ]

      const toolButtons = TOOLS.map((id) => h('button', {
        key: id,
        type: 'button',
        className: tool === id ? 'dshMacToolsToolButton dshMacToolsToolButtonActive' : 'dshMacToolsToolButton',
        'aria-pressed': tool === id,
        title: t(TOOL_KEYS[id]),
        onClick: () => {
          setTool(id)
          if (id !== 'crop') setCrop(null)
        },
      }, [glyph(id, 14, 'icon'), h('span', { key: 'label', className: 'dshMacToolsToolLabel' }, t(TOOL_KEYS[id]))]))

      const swatchButtons = COLORS.map((entry) => h('button', {
        key: entry.value,
        type: 'button',
        className: color === entry.value ? 'dshMacToolsSwatch dshMacToolsSwatchActive' : 'dshMacToolsSwatch',
        style: { backgroundColor: entry.value },
        'aria-label': t(entry.key),
        'aria-pressed': color === entry.value,
        title: t(entry.key),
        onClick: () => setColor(entry.value),
      }))

      const widthButtons = STROKE_WIDTHS.map((entry, index) => h('button', {
        key: entry.value,
        type: 'button',
        className: widthIndex === index ? 'dshMacToolsWidthButton dshMacToolsWidthButtonActive' : 'dshMacToolsWidthButton',
        'aria-label': t(entry.key),
        'aria-pressed': widthIndex === index,
        title: t(entry.key),
        onClick: () => setWidthIndex(index),
      }, h('span', { className: `dshMacToolsWidthSample dshMacToolsWidthSample${entry.sample}` })))

      const historyButtons = [
        h(IconButton, { key: 'undo', name: 'undo', label: t('editor.undo'), disabled: !canUndo, onClick: undo }),
        h(IconButton, { key: 'redo', name: 'redo', label: t('editor.redo'), disabled: !canRedo, onClick: redo }),
        h(IconButton, { key: 'reset', name: 'reset', label: t('editor.reset'), disabled: !canReset, onClick: resetAnnotations }),
      ]

      const cropBar = crop === null ? null : h('div', { key: 'crop', className: 'dshMacToolsCropBar' }, [
        h('p', { key: 'info', className: 'dshMacToolsCropInfo' }, [
          h('strong', { key: 'size' }, t('editor.cropSize', { width: Math.round(crop.w), height: Math.round(crop.h) })),
          ' — ',
          t('editor.cropHint'),
        ]),
        h('div', { key: 'actions', className: 'dshMacToolsCropActions' }, [
          h('button', {
            key: 'apply',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonPrimary',
            disabled: !cropReady,
            onClick: applyCrop,
          }, t('editor.cropApply')),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
            onClick: () => setCrop(null),
          }, t('editor.cropCancel')),
        ]),
      ])

      let stageBody
      if (baseStatus === 'error') {
        stageBody = h('div', { key: 'canvas-error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, t('editor.loadError', { message: baseError })),
        ])
      } else if (base === null) {
        stageBody = h('p', { key: 'canvas-loading', className: 'dshMacToolsHint', 'aria-busy': 'true' }, [
          h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }),
          ' ',
          t('editor.loading'),
        ])
      } else {
        stageBody = h('canvas', {
          key: 'canvas',
          ref: canvasRef,
          className: 'dshMacToolsCanvas',
          width: base.width,
          height: base.height,
          role: 'img',
          'aria-label': t('editor.canvasAria'),
          style: { cursor: tool === 'text' ? 'text' : tool === 'crop' ? 'crosshair' : 'crosshair' },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel,
          onContextMenu: (event) => event.preventDefault(),
        })
      }

      const textInput = textDraft === null ? null : [
        h('input', {
          key: 'text-input',
          ref: inputRef,
          className: 'dshMacToolsTextInput',
          type: 'text',
          value: textDraft.value,
          placeholder: t('editor.textPlaceholder'),
          'aria-label': t('editor.textPlaceholder'),
          style: { left: `${textDraft.left}px`, top: `${textDraft.top}px`, fontSize: `${TEXT_DISPLAY_SIZE}px` },
          onChange: (event) => setTextDraft(Object.assign({}, textDraft, { value: event.target.value })),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitText()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              cancelText()
            }
          },
          onBlur: commitText,
        }),
        h('span', {
          key: 'text-hint',
          className: 'dshMacToolsTextHint',
          style: { left: `${textDraft.left}px`, top: `${textDraft.top}px` },
        }, t('editor.textHint')),
      ]

      const toastElement = toast === null ? null : h('div', {
        key: 'toast',
        className: toast.kind === 'error' ? 'dshMacToolsToast dshMacToolsToastError' : 'dshMacToolsToast',
        role: toast.kind === 'error' ? 'alert' : 'status',
        'aria-live': 'polite',
      }, [
        h('span', { key: 'text', className: 'dshMacToolsToastText' }, toast.text),
        toast.path !== undefined && toast.path !== null && toast.path !== ''
          ? h('button', {
            key: 'reveal',
            type: 'button',
            className: 'dshMacToolsToastAction',
            onClick: () => { void revealToastPath(toast.path) },
          }, t('editor.reveal'))
          : null,
        h('button', {
          key: 'close',
          type: 'button',
          className: 'dshMacToolsIconButton',
          'aria-label': t('common.close'),
          title: t('common.close'),
          onClick: () => setToast(null),
        }, glyph('close', 13)),
      ])

      return h('div', { className: 'dshMacToolsEditor' }, [
        h('div', { key: 'bar', className: 'dshMacToolsEditorBar' }, [
          h('div', { key: 'meta', style: { flex: '1', minWidth: 0 } }, [
            h('p', { key: 'line', className: 'dshMacToolsEditorMeta' }, canvasSizeLabel),
            shotWindow === null
              ? h('p', { key: 'time', className: 'dshMacToolsEditorMetaSub' }, t('editor.capturedAt', { time: shotAt }))
              : h('p', { key: 'window', className: 'dshMacToolsEditorMetaSub' }, [
                t('editor.captureFrom', { app: shotWindow.app || '', title: shotWindow.title || '' }),
                ' · ',
                t('editor.capturedAt', { time: shotAt }),
              ]),
          ]),
          h('div', { key: 'actions', className: 'dshMacToolsEditorActions' }, actionButtons),
        ]),
        h('div', {
          key: 'toolbar',
          className: 'dshMacToolsToolbar',
          role: 'toolbar',
          'aria-label': t('editor.toolbarAria'),
        }, [
          h('div', { key: 'tools', className: 'dshMacToolsToolGroup' }, toolButtons),
          h('div', { key: 'divider-1', className: 'dshMacToolsToolDivider', 'aria-hidden': true }),
          h('div', { key: 'swatches', className: 'dshMacToolsSwatches', role: 'group', 'aria-label': t('editor.colorAria') }, swatchButtons),
          h('div', { key: 'widths', className: 'dshMacToolsWidths', role: 'group', 'aria-label': t('editor.widthAria') }, widthButtons),
          h('div', { key: 'divider-2', className: 'dshMacToolsToolDivider', 'aria-hidden': true }),
          h('div', { key: 'history', className: 'dshMacToolsToolGroup' }, historyButtons),
        ]),
        cropBar,
        h('div', { key: 'stage', ref: stageRef, className: 'dshMacToolsCanvasStage' }, [stageBody].concat(textInput === null ? [] : textInput)),
        h('div', { key: 'footer', className: 'dshMacToolsEditorFooter' }, [
          h('p', { key: 'hint', className: 'dshMacToolsEditorHint' }, t('editor.keyboardHint')),
        ]),
        toastElement,
      ])
    }

    /**
     * The screenshot tab: capture controls, the app-window picker and the
     * editor. It stays mounted while another tab is visible (hidden with the
     * `hidden` attribute), so an edited shot survives switching to the
     * calculator and back; the editor's keyboard listener is disabled through
     * `active` in that time.
     *
     * @param {object} props - tab props.
     * @returns {object} the element.
     */
    function ScreenshotTab({ store, snapshot, t, active }) {
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const [confirmClear, setConfirmClear] = React.useState(false)
      const capture = snapshot.capture
      const capturing = capture.status === 'running'
      const hostReady = snapshot.host.kind === 'ready'
      const hostUnavailable = snapshot.host.kind === 'missing' || snapshot.host.kind === 'error'
      // Hiding the host window only makes sense inside the Harness desktop
      // window, which is the window the Host can hide. A browser tab that shows
      // the Web GUI has no such window and keeps the toggle disabled.
      const inDesktopApp = typeof navigator === 'undefined' || /Electron\//u.test(navigator.userAgent || '')
      const hideAvailable = snapshot.hideAppAvailable === true && inDesktopApp
      const hideEnabled = hideAvailable && snapshot.hideApp === true
      const hotkey = snapshot.host.kind === 'ready' && snapshot.host.value !== null && typeof snapshot.host.value === 'object'
        ? snapshot.host.value.globalHotkey
        : null
      const hotkeyHint = hotkey !== null && typeof hotkey === 'object' && hotkey.enabled === true
        ? h('p', { key: 'hotkey', className: 'dshMacToolsHotkeyHint' }, hotkey.active === true
          ? t('capture.hotkeyActive', { accelerator: hotkey.label || hotkey.accelerator })
          : t('capture.hotkeyUnavailable'))
        : null
      const hotkeyState = snapshot.hotkey
      const hotkeyRecording = hotkeyState.recording === true
      const hotkeySaving = hotkeyState.saving === true
      const hotkeyError = hotkeyState.error

      // While recording, the next keydown is consumed: modifiers are collected
      // from the event, the last non-modifier key becomes the shortcut key.
      React.useEffect(() => {
        if (hotkeyRecording !== true) return undefined
        const onKeyDown = (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          if (event.key === 'Escape') {
            store.cancelHotkeyRecord()
            return
          }
          if (event.repeat === true) return
          const accelerator = acceleratorFromEvent(event)
          if (accelerator === null) return
          void store.setHotkey(accelerator)
        }
        // Window capture phase runs before the app's own shortcut listeners, so
        // the keys being recorded cannot fire another command first.
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
          window.removeEventListener('keydown', onKeyDown, true)
        }
      }, [hotkeyRecording, store])

      const hotkeyRow = hotkey === null || typeof hotkey !== 'object'
        ? null
        : h('div', { key: 'hotkey-row', className: 'dshMacToolsHotkeyRow' }, [
          h('span', { key: 'label', className: 'dshMacToolsHotkeyLabel' }, t('capture.hotkeyRow')),
          h('span', { key: 'value', className: 'dshMacToolsHotkeyValue' }, hotkeyRecording
            ? t('capture.hotkeyRecording')
            : hotkeySaving
              ? t('capture.hotkeySaving')
              : (hotkey.label || hotkey.accelerator || '—')),
          h('span', { key: 'source', className: 'dshMacToolsHotkeyMeta' }, hotkey.source === 'user' ? t('capture.hotkeyCustom') : t('capture.hotkeyDefault')),
          hotkeyRecording
            ? h('button', {
              key: 'cancel-record',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
              onClick: () => store.cancelHotkeyRecord(),
            }, t('common.cancel'))
            : h('button', {
              key: 'record',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
              disabled: hotkeySaving,
              onClick: () => store.beginHotkeyRecord(),
            }, t('capture.hotkeyRecord')),
          hotkey.source === 'user' && hotkeyRecording !== true
            ? h('button', {
              key: 'reset',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              disabled: hotkeySaving,
              onClick: () => { void store.resetHotkey() },
            }, t('capture.hotkeyReset'))
            : null,
        ])
      const hotkeyErrorLine = hotkeyError === null || hotkeyError === undefined
        ? null
        : h('p', { key: 'hotkey-error', className: 'dshMacToolsHotkeyError', role: 'alert' }, hotkeyErrorText(t, hotkeyError))
      const hotkeyInAppHint = hotkey === null || typeof hotkey !== 'object'
        ? null
        : h('p', { key: 'hotkey-inapp', className: 'dshMacToolsHotkeyHint' }, t('capture.hotkeyInAppHint'))

      const errorNotice = capture.error === null
        ? null
        : h('div', { key: 'capture-error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, captureErrorText(t, capture.error)),
          h('button', {
            key: 'dismiss',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact',
            onClick: () => store.dismissCaptureError(),
          }, t('common.dismiss')),
        ])

      const busyBar = capturing
        ? h('div', { key: 'busy', className: 'dshMacToolsCaptureBusy', role: 'status' }, [
          h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }),
          h('p', { key: 'text' }, hideEnabled ? t('capture.hint.hidden') : captureHintText(t, capture.mode)),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
            disabled: capture.cancelling,
            onClick: () => { void store.cancelCapture() },
          }, capture.cancelling ? t('capture.cancelling') : t('capture.cancel')),
        ])
        : h('div', { key: 'actions', className: 'dshMacToolsCaptureActions' }, [
          h('button', {
            key: 'interactive',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonPrimary',
            disabled: !hostReady || capturing,
            onClick: () => { void store.capture({ mode: 'interactive' }) },
          }, [glyph('camera', 15, 'icon'), h('span', { key: 'label' }, t('capture.primary'))]),
          h('button', {
            key: 'full',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonOutline',
            disabled: !hostReady || capturing,
            onClick: () => { void store.capture({ mode: 'full' }) },
          }, t('capture.full')),
          h('button', {
            key: 'delayed',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonOutline',
            disabled: !hostReady || capturing,
            onClick: () => { void store.capture({ mode: 'full', delaySeconds: 3 }) },
          }, t('capture.delayed')),
          h('button', {
            key: 'window',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonOutline',
            disabled: !hostReady || capturing,
            onClick: () => { void store.capture({ mode: 'interactive-window' }) },
          }, t('capture.window')),
          h('button', {
            key: 'picker',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonOutline',
            'aria-expanded': pickerOpen,
            disabled: hostUnavailable || capturing,
            onClick: () => setPickerOpen((open) => !open),
          }, [glyph('windows', 14, 'icon'), h('span', { key: 'label' }, pickerOpen ? t('capture.windowsHide') : t('capture.windows'))]),
          h('button', {
            key: 'hide-app',
            type: 'button',
            role: 'switch',
            'aria-checked': hideEnabled,
            'aria-label': t('capture.hideAppAria'),
            title: hideAvailable ? t('capture.hideAppAria') : t('capture.hideAppUnavailable'),
            className: 'dshMacToolsButton dshMacToolsButtonOutline dshMacToolsToggle' + (hideEnabled ? ' dshMacToolsToggleOn' : ''),
            disabled: hideAvailable === false || hostReady === false || capturing,
            onClick: () => store.setHideApp(!hideEnabled),
          }, [glyph('eye', 14, 'icon'), h('span', { key: 'label' }, t('capture.hideApp'))]),
        ])

      const picker = pickerOpen && hostUnavailable === false
        ? h(WindowPicker, { key: 'picker', store, snapshot, t, onPicked: () => setPickerOpen(false) })
        : null

      const emptyState = snapshot.shot !== null
        ? null
        : h('div', { key: 'empty', className: 'dshMacToolsEmpty' }, [
          h('div', { key: 'art', className: 'dshMacToolsEmptyArt', 'aria-hidden': true }, glyph('image', 24)),
          h('p', { key: 'title', className: 'dshMacToolsEmptyTitle' }, t('capture.empty')),
          h('p', { key: 'hint', className: 'dshMacToolsEmptyHint' }, t('capture.emptyHint')),
        ])

      const editor = snapshot.shot !== null
        ? h(ScreenshotEditor, { key: 'editor', store, snapshot, t, active })
        : null

      // The durable history refreshes when this tab becomes visible and every
      // few seconds after that, so a shortcut capture taken while the panel is
      // open shows up here without a manual refresh.
      const historyState = snapshot.history
      React.useEffect(() => {
        if (active !== true) return undefined
        void store.loadHistory()
        const timer = setInterval(() => {
          void store.loadHistory()
        }, 5000)
        return () => clearInterval(timer)
      }, [active, store])

      const historyItems = historyState.items
      const historySection = h('section', { key: 'history', className: 'dshMacToolsHistory' }, [
        h('div', { key: 'head', className: 'dshMacToolsHistoryHead' }, [
          h('h2', { key: 'title', className: 'dshMacToolsHistoryTitle' }, t('history.title')),
          h('span', { key: 'count', className: 'dshMacToolsHistoryCount' }, t('history.count', { count: historyItems.length })),
          h('div', { key: 'actions', className: 'dshMacToolsHistoryActions' }, [
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => { void store.loadHistory() },
            }, t('history.refresh')),
            historyItems.length > 0
              ? h('button', {
                key: 'clear',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
                onClick: () => {
                  if (confirmClear === true) {
                    setConfirmClear(false)
                    void store.clearHistory()
                  } else {
                    setConfirmClear(true)
                  }
                },
              }, confirmClear === true ? t('history.clearConfirm') : t('history.clear'))
              : null,
          ]),
        ]),
        historyState.error !== null && historyState.error !== undefined
          ? h('p', { key: 'error', className: 'dshMacToolsHistoryError', role: 'alert' }, t('history.error', { message: historyState.error.message }))
          : null,
        historyItems.length === 0
          ? h('p', { key: 'empty', className: 'dshMacToolsHistoryEmpty' }, t('history.empty'))
          : h('div', { key: 'grid', className: 'dshMacToolsHistoryGrid' }, historyItems.map((item) => h('div', {
            key: item.id,
            className: 'dshMacToolsHistoryCard',
          }, [
            h('button', {
              key: 'thumb',
              type: 'button',
              className: 'dshMacToolsHistoryThumb',
              title: t('history.openAria'),
              'aria-label': t('history.openAria'),
              onClick: () => { void store.openHistory(item.id) },
            }, h('img', {
              src: store.historyImageUrl(item),
              alt: '',
              loading: 'lazy',
              draggable: false,
            })),
            h('p', { key: 'meta', className: 'dshMacToolsHistoryMeta' }, `${formatDateTime(item.at)} · ${item.width}×${item.height}`),
            h('div', { key: 'row', className: 'dshMacToolsHistoryRow' }, [
              h('button', {
                key: 'edit',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact',
                onClick: () => { void store.openHistory(item.id) },
              }, t('history.edit')),
              h('button', {
                key: 'pin',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact',
                onClick: () => { void store.pinHistory(item.id).catch(() => {}) },
              }, t('history.pin')),
              h('button', {
                key: 'copy',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact',
                onClick: () => { void store.copyHistory(item.id).catch(() => {}) },
              }, t('history.copy')),
              h('button', {
                key: 'delete',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
                onClick: () => { void store.deleteHistory(item.id) },
              }, t('history.delete')),
            ]),
          ]))),
      ])

      return h('div', { className: 'dshMacToolsScreenshot' }, [
        errorNotice,
        h('div', { key: 'bar', className: 'dshMacToolsCaptureBar' }, [busyBar]),
        hotkeyHint,
        hotkeyRow,
        hotkeyErrorLine,
        hotkeyInAppHint,
        picker,
        editor,
        emptyState,
        historySection,
      ])
    }

    // ---------------------------------------------------------------------
    // Calculator tab
    // ---------------------------------------------------------------------

    /**
     * The keypad, in reading order. `token` keys append their literal token to
     * the expression (`÷` inserts `/` and so on); `action` keys edit the
     * expression rather than extending it.
     */
    const CALC_KEYS = [
      { id: 'sqrt', kind: 'token', token: 'sqrt(', label: '√', ariaKey: 'calc.key.sqrt', tone: 'fn' },
      { id: 'square', kind: 'token', token: '^2', label: 'x²', ariaKey: 'calc.key.square', tone: 'fn' },
      { id: 'pi', kind: 'token', token: 'pi', label: 'π', ariaKey: 'calc.key.pi', tone: 'fn' },
      { id: 'percent', kind: 'token', token: '/100', label: '%', ariaKey: 'calc.key.percent', tone: 'fn' },
      { id: 'clear', kind: 'action', action: 'clear', label: 'C', ariaKey: 'calc.key.clear', tone: 'action' },
      { id: 'backspace', kind: 'action', action: 'backspace', label: '⌫', ariaKey: 'calc.key.backspace', tone: 'action' },
      { id: 'open', kind: 'token', token: '(', label: '(', tone: 'fn' },
      { id: 'close', kind: 'token', token: ')', label: ')', tone: 'fn' },
      { id: 'seven', kind: 'token', token: '7', label: '7' },
      { id: 'eight', kind: 'token', token: '8', label: '8' },
      { id: 'nine', kind: 'token', token: '9', label: '9' },
      { id: 'divide', kind: 'token', token: '/', label: '÷', tone: 'op' },
      { id: 'four', kind: 'token', token: '4', label: '4' },
      { id: 'five', kind: 'token', token: '5', label: '5' },
      { id: 'six', kind: 'token', token: '6', label: '6' },
      { id: 'multiply', kind: 'token', token: '*', label: '×', tone: 'op' },
      { id: 'one', kind: 'token', token: '1', label: '1' },
      { id: 'two', kind: 'token', token: '2', label: '2' },
      { id: 'three', kind: 'token', token: '3', label: '3' },
      { id: 'minus', kind: 'token', token: '-', label: '−', tone: 'op' },
      { id: 'negate', kind: 'action', action: 'negate', label: '±', ariaKey: 'calc.key.plusMinus' },
      { id: 'zero', kind: 'token', token: '0', label: '0' },
      { id: 'dot', kind: 'token', token: '.', label: '.' },
      { id: 'plus', kind: 'token', token: '+', label: '+', tone: 'op' },
    ]

    /**
     * The calculator tab: an editable expression, the Host's result, a keypad
     * that edits the expression, and the session history. The host evaluator is
     * the only thing that computes a value; this component never parses math.
     *
     * @param {object} props - tab props.
     * @returns {object} the element.
     */
    function CalculatorTab({ store, snapshot, t }) {
      const calc = snapshot.calc
      const inputRef = React.useRef(null)
      const expression = calc.expression
      const evaluating = calc.status === 'evaluating'

      const focusInput = () => {
        const node = inputRef.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }
      const append = (token) => store.setCalcExpression(expression + token)
      const backspace = () => store.setCalcExpression(expression.slice(0, -1))
      const negate = () => {
        if (expression === '') store.setCalcExpression('-')
        else if (expression.charAt(0) === '-') store.setCalcExpression(expression.slice(1))
        else store.setCalcExpression(`-${expression}`)
      }
      const clear = () => {
        store.clearCalculator()
        focusInput()
      }
      const evaluate = () => {
        void store.evaluateCalc()
      }
      const handleKey = (key) => {
        if (key.action === 'clear') clear()
        else if (key.action === 'backspace') backspace()
        else if (key.action === 'negate') negate()
        else append(key.token)
      }

      const keys = CALC_KEYS.map((key) => {
        const className = ['dshMacToolsKey']
        if (key.tone === 'fn') className.push('dshMacToolsKeyFn')
        if (key.tone === 'op') className.push('dshMacToolsKeyOp')
        if (key.tone === 'action') className.push('dshMacToolsKeyAction')
        return h('button', {
          key: key.id,
          type: 'button',
          className: className.join(' '),
          'aria-label': key.ariaKey === undefined ? key.label : t(key.ariaKey),
          title: key.ariaKey === undefined ? undefined : t(key.ariaKey),
          onClick: () => handleKey(key),
        }, key.label)
      })
      keys.push(h('button', {
        key: 'equals',
        type: 'button',
        className: 'dshMacToolsKey dshMacToolsKeyEquals',
        'aria-label': t('calc.key.equals'),
        disabled: evaluating || expression.trim() === '',
        onClick: evaluate,
      }, '='))

      const resultLine = evaluating
        ? h('p', { key: 'value', className: 'dshMacToolsCalcMuted' }, t('calc.evaluating'))
        : h('p', {
          key: 'value',
          className: 'dshMacToolsCalcResultValue',
          'aria-live': 'polite',
        }, calc.result === null ? t('calc.emptyResult') : calc.result.formatted)

      const display = h('div', { key: 'display', className: 'dshMacToolsCalcDisplay' }, [
        h('div', { key: 'top', className: 'dshMacToolsCalcDisplayTop' }, [
          h('input', {
            key: 'expression',
            ref: inputRef,
            className: 'dshMacToolsCalcExpression',
            type: 'text',
            value: expression,
            placeholder: t('calc.placeholder'),
            'aria-label': t('calc.expressionAria'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => store.setCalcExpression(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                evaluate()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                clear()
              }
            },
          }),
          h('span', { key: 'angles', className: 'dshMacToolsCalcAngles', title: t('calc.hint') }, t('calc.angles')),
        ]),
        h('div', { key: 'result', className: 'dshMacToolsCalcResult' }, [
          h('span', { key: 'label', className: 'dshMacToolsCalcResultLabel' }, t('calc.result')),
          resultLine,
        ]),
        calc.error === null
          ? h('p', { key: 'hint', className: 'dshMacToolsHint' }, t('calc.hint'))
          : h('p', { key: 'error', className: 'dshMacToolsCalcError', role: 'alert' }, calcErrorText(t, calc.error)),
      ])

      const keypad = h('div', {
        key: 'keypad',
        className: 'dshMacToolsCalcKeypad',
        role: 'group',
        'aria-label': t('calc.keypad'),
      }, keys)

      const history = h('div', { key: 'history', className: 'dshMacToolsCalcHistory' }, [
        h('div', { key: 'title', className: 'dshMacToolsCalcHistoryTitle' }, [
          h('h3', { key: 'heading' }, t('calc.history')),
          h('button', {
            key: 'clear',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact',
            disabled: expression === '' && calc.result === null && calc.error === null,
            onClick: clear,
          }, t('calc.clear')),
        ]),
        calc.history.length === 0
          ? h('div', { key: 'empty' }, [
            h('p', { key: 'empty', className: 'dshMacToolsHint', style: { margin: 0 } }, t('calc.historyEmpty')),
            h('p', { key: 'hint', className: 'dshMacToolsHint', style: { margin: '2px 0 0' } }, t('calc.historyHint')),
          ])
          : h('ul', { key: 'list', className: 'dshMacToolsHistoryList' }, calc.history.map((row, index) => h('li', {
            key: `${index}:${row.expression}`,
          }, h('button', {
            type: 'button',
            className: 'dshMacToolsHistoryRow',
            title: t('calc.historyHint'),
            onClick: () => {
              store.setCalcExpression(row.expression)
              focusInput()
            },
          }, [
            h('span', { key: 'expression', className: 'dshMacToolsHistoryExpr' }, row.expression),
            h('span', { key: 'value', className: 'dshMacToolsHistoryValue' }, `= ${row.formatted}`),
          ])))),
      ])

      return h('div', { className: 'dshMacToolsCalc' }, [display, keypad, history])
    }

    // ---------------------------------------------------------------------
    // Shared system-information card helpers (used by the status tab)
    // ---------------------------------------------------------------------

    /**
     * One labelled value row inside a system card.
     *
     * @param {object} props - row props.
     * @returns {object} the element.
     */
    function KeyValue({ label, value, mono }) {
      return h('div', { className: 'dshMacToolsKv' }, [
        h('span', { key: 'label', className: 'dshMacToolsKvLabel' }, label),
        h('span', {
          key: 'value',
          className: mono === true ? 'dshMacToolsKvValue dshMacToolsKvValueMono' : 'dshMacToolsKvValue',
        }, value),
      ])
    }

    /**
     * A themed horizontal meter with a progress role.
     *
     * @param {object} props - meter props.
     * @returns {object} the element.
     */
    function MeterBar({ percent, label, tone }) {
      const safe = clampNumber(Math.round(Number.isFinite(percent) ? percent : 0), 0, 100)
      let fillClass = 'dshMacToolsBarFill'
      if (tone === 'disk') fillClass = 'dshMacToolsBarFill dshMacToolsBarFillDisk'
      if (tone === 'battery') fillClass = 'dshMacToolsBarFill dshMacToolsBarFillBattery'
      return h('div', {
        className: 'dshMacToolsBar',
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': safe,
        'aria-label': label,
      }, h('div', { className: fillClass, style: { width: `${safe}%` } }))
    }

    /**
     * One card in the system grid.
     *
     * @param {object} props - card props.
     * @returns {object} the element.
     */
    function SystemCard({ title, icon, wide, children }) {
      return h('section', { className: wide === true ? 'dshMacToolsCard dshMacToolsCardWide' : 'dshMacToolsCard' }, [
        h('h2', { key: 'title', className: 'dshMacToolsCardTitle' }, [
          icon === undefined ? null : glyph(icon, 14, 'icon'),
          h('span', { key: 'text' }, title),
        ]),
        h('div', { key: 'body', className: 'dshMacToolsCardBody' }, children),
      ])
    }

    // ---------------------------------------------------------------------
    // Phone transfer tab
    // ---------------------------------------------------------------------

    /**
     * The session countdown. It owns its own one-second clock so the tick only
     * re-renders this line instead of the whole tab with its two item lists.
     *
     * @param {{ t: Function, expiresAt: string|null, active: boolean }} props - the translator, the session expiry and whether the tab is visible.
     * @returns {object|null} the element, or null when the expiry is unknown.
     */
    function TransferCountdown({ t, expiresAt, active }) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (active !== true) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), TRANSFER_CLOCK_POLL_MS)
        return () => clearInterval(timer)
      }, [active, expiresAt])
      const text = transferCountdownText(t, expiresAt, now)
      if (text === '') return null
      return h('p', { className: 'dshMacToolsTransferCardMeta', role: 'timer' }, text)
    }

    /**
     * The phone-transfer tab.
     *
     * It starts and stops the Host's temporary LAN server, shows its QR code
     * and address, and mirrors the two queues: what the phone sent to this Mac
     * (inbox) and what this Mac offers to the phone (outbox, fed by text, the
     * native file picker, or one of the six most recent screenshots).
     *
     * Everything network-bound is polled only while this tab is the visible
     * one — the session state every two seconds, the two lists every four — and
     * the countdown re-renders locally every second. Switching tabs or closing
     * the panel clears every timer and aborts the requests the tab owns, so the
     * plugin never polls in the background.
     *
     * @param {object} props - tab props.
     * @returns {object} the element.
     */
    function TransferTab({ store, snapshot, t, active }) {
      const transfer = snapshot.transfer
      const session = transfer.session
      const inbox = transfer.inbox
      const outbox = transfer.outbox
      const sessionUrl = session !== null && typeof session.url === 'string' ? session.url : ''
      const [urlCopied, setUrlCopied] = React.useState(false)
      const [urlCopyError, setUrlCopyError] = React.useState('')
      const [confirmInboxClear, setConfirmInboxClear] = React.useState(false)
      const [confirmOutboxClear, setConfirmOutboxClear] = React.useState(false)

      React.useEffect(() => {
        if (active !== true) return undefined
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const signal = controller === null ? undefined : controller.signal
        void store.loadTransferStatus({ signal })
        void store.refreshTransferInbox({ signal })
        void store.refreshTransferOutbox({ signal })
        // The recent-screenshot strip is seeded from the shared history store;
        // it is refreshed on entry rather than polled, per the contract.
        if (snapshot.history.items.length === 0) void store.loadHistory({ signal })
        const statusTimer = setInterval(() => {
          void store.loadTransferStatus()
        }, TRANSFER_STATUS_POLL_MS)
        const listTimer = setInterval(() => {
          void store.refreshTransferInbox()
          void store.refreshTransferOutbox()
        }, TRANSFER_LIST_POLL_MS)
        return () => {
          clearInterval(statusTimer)
          clearInterval(listTimer)
          if (controller !== null) controller.abort()
        }
      }, [active, store])

      // A toast is transient: it clears itself after three seconds.
      const toast = transfer.toast
      React.useEffect(() => {
        if (toast === null || toast === undefined) return undefined
        const timer = setTimeout(() => store.dismissTransferToast(), TRANSFER_TOAST_MS)
        return () => clearTimeout(timer)
      }, [toast, store])

      // The copied-link label falls back to "copy" a moment later.
      React.useEffect(() => {
        if (urlCopied !== true) return undefined
        const timer = setTimeout(() => setUrlCopied(false), TRANSFER_TOAST_MS)
        return () => clearTimeout(timer)
      }, [urlCopied])

      // A new session means a new link: never carry a copy result (ok or
      // failed) over from the previous one.
      React.useEffect(() => {
        setUrlCopied(false)
        setUrlCopyError('')
      }, [sessionUrl])

      // Disarm "clear" as soon as the list is empty, so a stale armed button
      // cannot make the next item clearable with a single click.
      const inboxItemCount = inbox.items.length
      React.useEffect(() => {
        if (inboxItemCount === 0) setConfirmInboxClear(false)
      }, [inboxItemCount])
      const outboxItemCount = outbox.items.length
      React.useEffect(() => {
        if (outboxItemCount === 0) setConfirmOutboxClear(false)
      }, [outboxItemCount])

      const copyTransferUrl = () => {
        const url = sessionUrl
        if (url === '') return
        const clipboard = typeof navigator !== 'undefined'
          && navigator !== null
          && navigator.clipboard !== null
          && navigator.clipboard !== undefined
          && typeof navigator.clipboard === 'object'
          ? navigator.clipboard
          : null
        if (clipboard === null || typeof clipboard.writeText !== 'function') {
          setUrlCopyError(t('transfer.copyFailed', { message: t('transfer.clipboardUnavailable') }))
          return
        }
        setUrlCopyError('')
        Promise.resolve(clipboard.writeText(url)).then(() => {
          setUrlCopied(true)
        }, (error) => {
          setUrlCopied(false)
          setUrlCopyError(t('transfer.copyFailed', { message: error instanceof Error ? error.message : String(error) }))
        })
      }

      const inboxCount = Number.isFinite(inbox.count) ? inbox.count : inbox.items.length
      const outboxCount = Number.isFinite(outbox.count) ? outbox.count : outbox.items.length

      const transferError = transfer.error === null || transfer.error === undefined
        ? null
        : h('div', { key: 'transfer-error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, transferErrorText(t, transfer.error)),
          session !== null
            ? h('button', {
              key: 'retry',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => { void store.loadTransferStatus() },
            }, t('common.retry'))
            : null,
        ])

      let card
      if (session !== null) {
        // --- live session: QR, URLs, countdown, stop -----------------------
        const qrImage = typeof session.qrPngBase64 === 'string' && session.qrPngBase64 !== ''
          ? h('img', {
            key: 'qr',
            className: 'dshMacToolsTransferQrImage',
            src: `${TRANSFER_QR_PREFIX}${session.qrPngBase64}`,
            alt: t('transfer.qrAlt'),
            draggable: false,
          })
          : h('div', { key: 'qr', className: 'dshMacToolsTransferQrFallback' }, [
            h('span', { key: 'icon', 'aria-hidden': true }, glyph('qr', 26)),
            h('span', { key: 'text' }, t('transfer.qrFallback')),
          ])
        const qrError = typeof session.qrError === 'string' && session.qrError !== ''
          ? h('p', { key: 'qr-error', className: 'dshMacToolsTransferHint dshMacToolsTransferHintError', role: 'alert' }, t('transfer.qrError', { message: session.qrError }))
          : null

        const url = sessionUrl
        const urlRow = url === '' ? null : h('div', { key: 'url', className: 'dshMacToolsTransferUrlRow' }, [
          h('span', { key: 'label', className: 'dshMacToolsTransferHint' }, t('transfer.urlLabel')),
          h('span', { key: 'text', className: 'dshMacToolsTransferUrl' }, url),
          h('button', {
            key: 'copy',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
            onClick: copyTransferUrl,
          }, [
            glyph('copy', 13, 'icon'),
            h('span', { key: 'label' }, urlCopied ? t('transfer.urlCopied') : t('transfer.copyUrl')),
          ]),
        ])
        const copyError = urlCopyError === ''
          ? null
          : h('p', { key: 'copy-error', className: 'dshMacToolsTransferHint dshMacToolsTransferHintError', role: 'alert' }, urlCopyError)

        const urls = Array.isArray(session.urls)
          ? session.urls.filter((entry) => typeof entry === 'string' && entry !== '')
          : []
        const extraUrls = urls.length <= 1 ? null : h('div', { key: 'urls' }, [
          h('p', { key: 'title', className: 'dshMacToolsTransferHint' }, t('transfer.urlsTitle')),
          h('ul', { key: 'list', className: 'dshMacToolsTransferUrls' }, urls.map((entry, index) => h(
            'li',
            { key: `url-${index}`, className: 'dshMacToolsTransferUrlItem' },
            entry,
          ))),
        ])

        const directory = typeof session.directory === 'string' ? session.directory : ''
        const sessionMeta = h('p', { key: 'meta', className: 'dshMacToolsTransferHint' }, [
          directory === '' ? null : t('transfer.directory', { directory }),
          directory === '' ? null : ' · ',
          t('transfer.sessionMinutes', { minutes: Number.isFinite(session.sessionMinutes) ? session.sessionMinutes : 0 }),
          ' · ',
          t('transfer.maxFile', { megabytes: Number.isFinite(session.maxFileMB) ? Math.round(session.maxFileMB) : 0 }),
        ])

        const warnings = Array.isArray(session.warnings)
          ? session.warnings.filter((entry) => typeof entry === 'string' && entry !== '')
          : []
        const warningList = warnings.length === 0
          ? null
          : h('ul', { key: 'warnings', className: 'dshMacToolsTransferWarnings' }, warnings.map((entry, index) => h(
            'li',
            { key: `warning-${index}`, className: 'dshMacToolsTransferWarning' },
            [
              h('span', { key: 'icon', className: 'dshMacToolsTransferWarningIcon', 'aria-hidden': true }, glyph('alert', 13)),
              h('span', { key: 'text' }, entry),
            ],
          )))

        const stopping = transfer.status === 'stopping'

        card = h('section', { key: 'card', className: 'dshMacToolsTransferCard', 'aria-label': t('transfer.title') }, [
          h('div', { key: 'head', className: 'dshMacToolsTransferCardHead' }, [
            h('h2', { key: 'title', className: 'dshMacToolsTransferCardTitle' }, t('transfer.title')),
            h('span', { key: 'status', className: 'dshMacToolsStatusPill dshMacToolsStatusReady' }, [
              h('span', { key: 'dot', className: 'dshMacToolsStatusDot', 'aria-hidden': true }),
              h('span', { key: 'text', className: 'dshMacToolsStatusText' }, t('transfer.active')),
            ]),
            h(TransferCountdown, { key: 'countdown', t, expiresAt: session.expiresAt, active }),
            h('button', {
              key: 'stop',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
              disabled: stopping,
              onClick: () => { void store.stopTransfer() },
            }, stopping
              ? [h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }), t('transfer.stopping')]
              : t('transfer.stop')),
          ]),
          transferError,
          h('div', { key: 'body', className: 'dshMacToolsTransferQrRow' }, [
            h('div', { key: 'qr-box', className: 'dshMacToolsTransferQrBox' }, [qrImage, qrError]),
            h('div', { key: 'session', className: 'dshMacToolsTransferSession' }, [
              urlRow,
              copyError,
              extraUrls,
              sessionMeta,
              warningList,
            ]),
          ]),
          h('p', { key: 'hint', className: 'dshMacToolsTransferHint' }, t('transfer.wifiHint')),
        ])
      } else {
        // --- idle/loading/starting/error: the start card -------------------
        const hostReady = snapshot.host.kind === 'ready'
        const hostValue = snapshot.host.value
        const capabilities = hostValue !== null && typeof hostValue === 'object' && hostValue.capabilities !== null && typeof hostValue.capabilities === 'object'
          ? hostValue.capabilities
          : null
        const supported = capabilities === null || capabilities.transfer !== false
        const starting = transfer.status === 'starting'
        const loading = transfer.status === 'loading'
        let actionRow
        if (starting === true || loading === true) {
          actionRow = h('p', { key: 'busy', className: 'dshMacToolsTransferLoading', role: 'status' }, [
            h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }),
            t(starting === true ? 'transfer.starting' : 'transfer.loading'),
          ])
        } else {
          actionRow = h('div', { key: 'row', className: 'dshMacToolsTransferStartRow' }, [
            h('button', {
              key: 'start',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonPrimary',
              disabled: hostReady !== true || supported !== true,
              onClick: () => { void store.startTransfer() },
            }, [
              glyph('qr', 15, 'icon'),
              h('span', { key: 'label' }, t('transfer.start')),
            ]),
            supported === true
              ? null
              : h('span', { key: 'unsupported', className: 'dshMacToolsTransferHint dshMacToolsTransferHintError' }, t('transfer.error.unsupported')),
          ])
        }
        card = h('section', { key: 'card', className: 'dshMacToolsTransferCard', 'aria-label': t('transfer.title') }, [
          h('div', { key: 'head', className: 'dshMacToolsTransferCardHead' }, [
            h('h2', { key: 'title', className: 'dshMacToolsTransferCardTitle' }, t('transfer.title')),
          ]),
          h('p', { key: 'subtitle', className: 'dshMacToolsTransferIntroText' }, t('transfer.subtitle')),
          transferError,
          actionRow,
        ])
      }

      // --- inbox column ----------------------------------------------------
      const inboxItemNodes = inbox.items.map((item, index) => {
        const kind = typeof item.kind === 'string' ? item.kind : 'file'
        const name = typeof item.name === 'string' && item.name !== '' ? item.name : transferKindLabel(t, kind)
        const previewable = item.previewable === true && kind === 'file'
        const text = typeof item.text === 'string' ? item.text : ''
        const sizeText = transferSizeText(item.size)
        const timeText = formatDateTime(item.createdAt)
        // Text rows lead with the preview and still name the saved .txt file;
        // file rows lead with the name and keep size/time in the meta line.
        const meta = kind === 'text' && text !== ''
          ? `${name} · ${sizeText} · ${timeText}`
          : `${sizeText} · ${timeText}`
        const thumb = previewable === false
          ? null
          : h('div', { key: 'thumb', className: 'dshMacToolsTransferThumb' }, h('img', {
            src: store.transferInboxImageUrl(item),
            alt: t('transfer.inbox.previewAlt'),
            loading: 'lazy',
            draggable: false,
          }))
        const titleNode = kind === 'text' && text !== ''
          ? h('p', { key: 'preview', className: 'dshMacToolsTransferRowPreview' }, transferPreviewText(text))
          : h('span', { key: 'name', className: 'dshMacToolsTransferRowName' }, name)
        const actions = []
        if (kind === 'text') {
          actions.push(h('button', {
            key: 'copy',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
            onClick: () => { void store.copyTransferText(item.id) },
          }, t('transfer.inbox.copy')))
        }
        if (kind === 'file') {
          actions.push(h('button', {
            key: 'reveal',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact',
            onClick: () => { void store.revealTransferInboxItem(item.id) },
          }, t('transfer.inbox.reveal')))
        }
        actions.push(h('button', {
          key: 'delete',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
          onClick: () => { void store.deleteTransferInboxItem(item.id) },
        }, t('transfer.inbox.delete')))
        return h('li', { key: typeof item.id === 'string' ? item.id : `inbox-${index}`, className: 'dshMacToolsTransferRow' }, [
          h('div', { key: 'main', className: 'dshMacToolsTransferRowMain' }, [
            thumb,
            h('div', { key: 'text', className: 'dshMacToolsTransferRowText' }, [
              titleNode,
              h('span', { key: 'meta', className: 'dshMacToolsTransferRowMeta' }, meta),
            ]),
            h('span', { key: 'kind', className: 'dshMacToolsTransferBadge' }, transferKindLabel(t, kind)),
          ]),
          h('div', { key: 'actions', className: 'dshMacToolsTransferRowActions' }, actions),
        ])
      })

      let inboxBody
      if (inbox.items.length === 0) {
        if (inbox.status === 'loading') {
          inboxBody = h('div', { key: 'loading', className: 'dshMacToolsLoading', 'aria-busy': 'true' }, [
            h('p', { key: 'text', className: 'dshMacToolsTransferLoading' }, [
              h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }),
              t('transfer.inbox.loading'),
            ]),
            h('div', { key: 'one', className: 'dshMacToolsSkeleton dshMacToolsTransferSkeleton' }),
            h('div', { key: 'two', className: 'dshMacToolsSkeleton dshMacToolsTransferSkeleton' }),
          ])
        } else if (inbox.status === 'error' && inbox.error !== null) {
          inboxBody = h('div', { key: 'error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
            h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
            h('p', { key: 'text' }, transferErrorText(t, inbox.error)),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => { void store.refreshTransferInbox() },
            }, t('common.retry')),
          ])
        } else {
          inboxBody = h('p', { key: 'empty', className: 'dshMacToolsTransferEmpty' }, t('transfer.inbox.empty'))
        }
      } else {
        inboxBody = [
          inbox.error === null || inbox.error === undefined
            ? null
            : h('p', { key: 'stale', className: 'dshMacToolsTransferHint dshMacToolsTransferHintError', role: 'alert' }, t('transfer.inbox.error', { message: inbox.error.message })),
          h('ul', { key: 'list', className: 'dshMacToolsTransferList' }, inboxItemNodes),
        ]
      }

      const inboxPanel = h('section', { key: 'inbox', className: 'dshMacToolsTransferColumn', 'aria-label': t('transfer.inbox.title') }, [
        h('div', { key: 'head', className: 'dshMacToolsTransferColHead' }, [
          h('h2', { key: 'title', className: 'dshMacToolsTransferColTitle' }, t('transfer.inbox.title')),
          h('span', { key: 'count', className: 'dshMacToolsTransferColCount' }, t('transfer.inbox.count', { count: inboxCount })),
          h('div', { key: 'actions', className: 'dshMacToolsTransferColActions' }, [
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => { void store.refreshTransferInbox() },
            }, t('transfer.refresh')),
            inboxCount > 0
              ? h('button', {
                key: 'clear',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
                onClick: () => {
                  if (confirmInboxClear === true) {
                    setConfirmInboxClear(false)
                    void store.clearTransferInbox()
                  } else {
                    setConfirmInboxClear(true)
                  }
                },
              }, confirmInboxClear === true ? t('transfer.inbox.clearConfirm') : t('transfer.inbox.clear'))
              : null,
          ]),
        ]),
        inboxBody,
      ])

      // --- outbox column ---------------------------------------------------
      const recentItems = Array.isArray(snapshot.history.items)
        ? snapshot.history.items.slice(0, TRANSFER_RECENT_SCREENSHOTS)
        : []
      const recent = h('div', { key: 'recent', className: 'dshMacToolsTransferRecent' }, [
        h('p', { key: 'title', className: 'dshMacToolsTransferRecentTitle' }, t('transfer.outbox.recent')),
        recentItems.length === 0
          ? h('p', { key: 'empty', className: 'dshMacToolsTransferHint' }, t('transfer.outbox.recentEmpty'))
          : h('div', { key: 'grid', className: 'dshMacToolsTransferRecentGrid' }, recentItems.map((item, index) => h('button', {
            key: typeof item.id === 'string' ? item.id : `history-${index}`,
            type: 'button',
            className: 'dshMacToolsTransferRecentButton',
            title: t('transfer.outbox.sendHistory'),
            'aria-label': `${t('transfer.outbox.sendHistory')} ${formatDateTime(item.at)}`,
            onClick: () => { void store.sendHistoryToPhone(item.id) },
          }, h('img', {
            src: store.historyImageUrl(item),
            alt: '',
            loading: 'lazy',
            draggable: false,
          })))),
      ])

      const outboxItemNodes = outbox.items.map((item, index) => {
        const kind = typeof item.kind === 'string' ? item.kind : 'file'
        const name = typeof item.name === 'string' && item.name !== '' ? item.name : transferKindLabel(t, kind)
        const text = typeof item.text === 'string' ? item.text : ''
        const sizeText = transferSizeText(item.size)
        const timeText = formatDateTime(item.createdAt)
        const meta = kind === 'text' && text !== ''
          ? `${name} · ${sizeText} · ${timeText}`
          : `${sizeText} · ${timeText}`
        const titleNode = kind === 'text' && text !== ''
          ? h('p', { key: 'preview', className: 'dshMacToolsTransferRowPreview' }, transferPreviewText(text))
          : h('span', { key: 'name', className: 'dshMacToolsTransferRowName' }, name)
        return h('li', { key: typeof item.id === 'string' ? item.id : `outbox-${index}`, className: 'dshMacToolsTransferRow' }, [
          h('div', { key: 'main', className: 'dshMacToolsTransferRowMain' }, [
            h('div', { key: 'text', className: 'dshMacToolsTransferRowText' }, [
              titleNode,
              h('span', { key: 'meta', className: 'dshMacToolsTransferRowMeta' }, meta),
            ]),
            h('span', { key: 'kind', className: 'dshMacToolsTransferBadge' }, transferKindLabel(t, kind)),
          ]),
          h('div', { key: 'actions', className: 'dshMacToolsTransferRowActions' }, [
            h('button', {
              key: 'remove',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
              onClick: () => { void store.removeTransferOutboxItem(item.id) },
            }, t('transfer.outbox.remove')),
          ]),
        ])
      })

      let outboxBody
      if (outbox.items.length === 0) {
        if (outbox.status === 'loading') {
          outboxBody = h('div', { key: 'loading', className: 'dshMacToolsLoading', 'aria-busy': 'true' }, [
            h('p', { key: 'text', className: 'dshMacToolsTransferLoading' }, [
              h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }),
              t('transfer.outbox.loading'),
            ]),
            h('div', { key: 'one', className: 'dshMacToolsSkeleton dshMacToolsTransferSkeleton' }),
            h('div', { key: 'two', className: 'dshMacToolsSkeleton dshMacToolsTransferSkeleton' }),
          ])
        } else if (outbox.status === 'error' && outbox.error !== null) {
          outboxBody = h('div', { key: 'error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
            h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
            h('p', { key: 'text' }, transferErrorText(t, outbox.error)),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => { void store.refreshTransferOutbox() },
            }, t('common.retry')),
          ])
        } else {
          outboxBody = h('p', { key: 'empty', className: 'dshMacToolsTransferEmpty' }, t('transfer.outbox.empty'))
        }
      } else {
        outboxBody = [
          outbox.error === null || outbox.error === undefined
            ? null
            : h('p', { key: 'stale', className: 'dshMacToolsTransferHint dshMacToolsTransferHintError', role: 'alert' }, t('transfer.outbox.error', { message: outbox.error.message })),
          h('ul', { key: 'list', className: 'dshMacToolsTransferList' }, outboxItemNodes),
        ]
      }

      const sendingText = transfer.sendingText === true
      const addingFile = transfer.addingFile === true
      const draftEmpty = transfer.textDraft.trim() === ''
      const compose = h('div', { key: 'compose', className: 'dshMacToolsTransferCompose' }, [
        h('textarea', {
          key: 'draft',
          className: 'dshMacToolsTransferTextarea',
          rows: 2,
          value: transfer.textDraft,
          placeholder: t('transfer.outbox.textPlaceholder'),
          'aria-label': t('transfer.outbox.textPlaceholder'),
          onChange: (event) => store.setTransferTextDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey === true || event.ctrlKey === true)) {
              event.preventDefault()
              void store.sendTransferText()
            }
          },
        }),
        h('div', { key: 'row', className: 'dshMacToolsTransferComposeRow' }, [
          h('button', {
            key: 'send',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonPrimary',
            disabled: sendingText === true || draftEmpty === true,
            onClick: () => { void store.sendTransferText() },
          }, sendingText === true
            ? [h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }), t('transfer.outbox.sending')]
            : [glyph('arrow', 13, 'icon'), h('span', { key: 'label' }, t('transfer.outbox.send'))]),
          h('button', {
            key: 'file',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
            disabled: addingFile === true,
            onClick: () => { void store.sendTransferFile() },
          }, addingFile === true
            ? [h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }), t('transfer.outbox.choosingFile')]
            : [glyph('save', 13, 'icon'), h('span', { key: 'label' }, t('transfer.outbox.chooseFile'))]),
        ]),
        recent,
      ])

      const outboxPanel = h('section', { key: 'outbox', className: 'dshMacToolsTransferColumn', 'aria-label': t('transfer.outbox.title') }, [
        h('div', { key: 'head', className: 'dshMacToolsTransferColHead' }, [
          h('h2', { key: 'title', className: 'dshMacToolsTransferColTitle' }, t('transfer.outbox.title')),
          h('span', { key: 'count', className: 'dshMacToolsTransferColCount' }, t('transfer.outbox.count', { count: outboxCount })),
          h('div', { key: 'actions', className: 'dshMacToolsTransferColActions' }, [
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => { void store.refreshTransferOutbox() },
            }, t('transfer.refresh')),
            outboxCount > 0
              ? h('button', {
                key: 'clear',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
                onClick: () => {
                  if (confirmOutboxClear === true) {
                    setConfirmOutboxClear(false)
                    void store.clearTransferOutbox()
                  } else {
                    setConfirmOutboxClear(true)
                  }
                },
              }, confirmOutboxClear === true ? t('transfer.outbox.clearConfirm') : t('transfer.outbox.clear'))
              : null,
          ]),
        ]),
        compose,
        outboxBody,
      ])

      // The region owns the announcement: a nested `role="status"` live region
      // would make screen readers announce a toast twice.
      const toastNode = toast === null || toast === undefined
        ? null
        : h('div', {
          key: 'toast',
          className: toast.kind === 'error' ? 'dshMacToolsToast dshMacToolsToastError' : 'dshMacToolsToast',
        }, h('span', { key: 'text', className: 'dshMacToolsToastText' }, transferToastText(t, toast)))

      return h('div', { className: 'dshMacToolsTransfer' }, [
        card,
        h('div', { key: 'columns', className: 'dshMacToolsTransferColumns' }, [inboxPanel, outboxPanel]),
        h('div', {
          key: 'toast-region',
          className: 'dshMacToolsTransferToastRegion',
          'aria-live': 'polite',
          'aria-atomic': 'true',
        }, toastNode),
      ])
    }

    // ---------------------------------------------------------------------
    // Live status tab
    // ---------------------------------------------------------------------

    /**
     * One reusable sparkline. Series colours are the only literal colours in
     * the chart; the card chrome stays on theme tokens. Non-finite values are
     * skipped, so `history.cpuTemperature` may hold null points.
     *
     * @param {object} props - series, optional fixed domain, height and label.
     * @returns {object} the `<svg>` element.
     */
    function MonitorSparkline({ series, fixedMin, fixedMax, tall, ariaLabel }) {
      const groups = Array.isArray(series) ? series : []
      const bounds = monitorSeriesBounds(groups.map((group) => group.points), fixedMin, fixedMax)
      const width = 240
      const height = tall === true ? 52 : 40
      const paths = groups.map((group, index) => {
        const geometry = monitorSparklineGeometry(group.points, bounds.min, bounds.max, width, height)
        const nodes = []
        if (group.area === true && geometry.area !== '') {
          nodes.push(h('path', {
            key: 'area',
            className: 'dshMacToolsMonitorSparkArea',
            d: geometry.area,
            style: { fill: group.color },
            'vector-effect': 'non-scaling-stroke',
          }))
        }
        if (geometry.line !== '') {
          nodes.push(h('path', {
            key: 'line',
            className: 'dshMacToolsMonitorSparkLine',
            d: geometry.line,
            style: { stroke: group.color },
            'vector-effect': 'non-scaling-stroke',
          }))
        }
        return nodes
      })
      const labelled = typeof ariaLabel === 'string' && ariaLabel !== ''
      return h('svg', {
        className: tall === true ? 'dshMacToolsMonitorSparkline dshMacToolsMonitorSparklineTall' : 'dshMacToolsMonitorSparkline',
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        role: labelled ? 'img' : 'presentation',
        'aria-label': labelled ? ariaLabel : undefined,
        'aria-hidden': labelled ? undefined : true,
        focusable: false,
      }, paths)
    }

    /**
     * One overview card. Reuses the shared system-card surface so the panel
     * keeps a single visual language.
     *
     * @param {object} props - title, optional meta node, wide flag, children.
     * @returns {object} the element.
     */
    function MonitorCard({ title, meta, wide, children }) {
      return h('section', {
        className: wide === true ? 'dshMacToolsCard dshMacToolsMonitorCardWide' : 'dshMacToolsCard',
      }, [
        h('div', { key: 'head', className: 'dshMacToolsMonitorCardHead' }, [
          h('h2', { key: 'title', className: 'dshMacToolsMonitorCardTitle' }, title),
          meta === undefined || meta === null
            ? null
            : h('div', { key: 'meta', className: 'dshMacToolsMonitorCardMeta' }, meta),
        ]),
        h('div', { key: 'body', className: 'dshMacToolsCardBody' }, children),
      ])
    }

    /**
     * One legend dot for a chart series.
     *
     * @param {string} color - the series colour.
     * @returns {object} the element.
     */
    function MonitorLegendDot({ color }) {
      return h('span', {
        className: 'dshMacToolsMonitorLegendDot',
        style: { background: color },
        'aria-hidden': true,
      })
    }

    /**
     * The per-core mini bars.
     *
     * @param {object} props - translator and the perCorePercent array.
     * @returns {object|null} the element, or null when the Host sent no core data.
     */
    function MonitorCores({ t, cores }) {
      const list = Array.isArray(cores) ? cores : []
      if (list.length === 0) return null
      return h('div', {
        className: 'dshMacToolsMonitorCoreBars',
        role: 'img',
        'aria-label': t('monitor.cpu.perCore'),
      }, list.map((value, index) => {
        const percent = clampNumber(Number.isFinite(value) ? value : 0, 0, 100)
        return h('span', {
          key: `core-${index}`,
          className: 'dshMacToolsMonitorCoreBar',
          title: t('monitor.cpu.coreAria', { index: index + 1, value: formatPercent(percent) }),
        }, h('span', { className: 'dshMacToolsMonitorCoreFill', style: { height: `${percent}%` } }))
      }))
    }

    /**
     * 温度传感器 — the summary chips plus the collapsible all-sensors list
     * grouped by SMC key family and sorted by temperature desc.
     *
     * @param {object} props - translator and the sample's sensors block.
     * @returns {object} the section element.
     */
    function MonitorSensorsSection({ t, sensors }) {
      const [open, setOpen] = React.useState(false)
      const block = sensors !== null && typeof sensors === 'object' ? sensors : {}
      const available = block.available === true
      const groups = block.groups !== null && typeof block.groups === 'object' ? block.groups : {}
      const readings = Array.isArray(block.readings) ? block.readings : []

      const chips = []
      for (let index = 0; index < MONITOR_SENSOR_GROUPS.length; index += 1) {
        const id = MONITOR_SENSOR_GROUPS[index][0]
        const key = MONITOR_SENSOR_GROUPS[index][1]
        const value = groups[id]
        if (!Number.isFinite(value)) continue
        chips.push(h('li', { key: id, className: 'dshMacToolsMonitorChip' }, [
          h('span', { key: 'label', className: 'dshMacToolsMonitorChipLabel' }, t(key)),
          h('span', { key: 'value', className: 'dshMacToolsMonitorChipValue' }, monitorCelsiusText(value)),
        ]))
      }
      const families = monitorSensorFamilies(readings)

      let statusLine = null
      if (available !== true) {
        statusLine = h('div', { key: 'status', className: 'dshMacToolsNotice', role: 'status' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, monitorSensorReasonText(t, block.reason)),
        ])
      } else if (chips.length === 0 && families.length === 0) {
        statusLine = h('p', { key: 'empty', className: 'dshMacToolsMonitorMuted' }, t('monitor.sensors.empty'))
      }

      const summary = available === true && chips.length > 0
        ? h('ul', {
          key: 'summary',
          className: 'dshMacToolsMonitorChips',
          'aria-label': t('monitor.sensors.summaryAria'),
        }, chips)
        : null

      const allSensors = available === true && families.length > 0 && open === true
        ? h('div', { key: 'all', className: 'dshMacToolsMonitorSensorList' }, families.map((family) => h('div', {
          key: `family-${family.family}`,
          className: 'dshMacToolsMonitorSensorFamily',
        }, [
          h('p', { key: 'head', className: 'dshMacToolsMonitorSensorFamilyHead' }, [
            h('span', { key: 'name' }, family.family),
            h('span', {
              key: 'count',
              className: 'dshMacToolsMonitorSensorFamilyMeta',
            }, t('monitor.sensors.familyCount', { count: family.readings.length })),
          ]),
          h('ul', { key: 'rows', className: 'dshMacToolsMonitorSensorRows' }, family.readings.map((reading) => h('li', {
            key: `${family.family}-${reading.key}`,
            className: 'dshMacToolsMonitorSensorRow',
            title: t('monitor.sensors.readingAria', { key: reading.key, value: monitorCelsiusText(reading.celsius) }),
          }, [
            h('span', { key: 'key', className: 'dshMacToolsMonitorSensorKey' }, reading.key),
            h('span', { key: 'value', className: 'dshMacToolsMonitorSensorValue' }, monitorCelsiusText(reading.celsius)),
          ]))),
        ])))
        : null

      const actions = available === true && families.length > 0
        ? h('div', { key: 'actions', className: 'dshMacToolsMonitorSectionActions' }, h('button', {
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        }, open ? t('monitor.sensors.hideAll') : t('monitor.sensors.showAll')))
        : null

      return h('section', {
        className: 'dshMacToolsMonitorSection',
        'aria-label': t('monitor.sensors.title'),
      }, [
        h('div', { key: 'head', className: 'dshMacToolsMonitorSectionHead' }, [
          h('h2', { key: 'title', className: 'dshMacToolsMonitorSectionTitle' }, t('monitor.sensors.title')),
          readings.length === 0
            ? null
            : h('span', { key: 'count', className: 'dshMacToolsMonitorSectionMeta' }, t('monitor.sensors.count', { count: readings.length })),
          actions,
        ]),
        h('div', { key: 'body', className: 'dshMacToolsMonitorSectionBody' }, [statusLine, summary, allSensors]),
      ])
    }


    /**
     * 系统信息 — the surviving standalone System-tab content, merged into the
     * status tab between 温度传感器 and 风扇控制. Memory, disk, battery, CPU and
     * network values stay in the overview cards above (battery is not repeated
     * here), while hardware identity, runtime facts and Host capabilities live
     * in this section's three reused system cards.
     *
     * @param {object} props - snapshot and translator.
     * @returns {object|null} the section, or null before the first snapshot.
     */
    function MonitorSystemSection({ snapshot, t }) {
      const monitor = snapshot.monitor
      const value = monitor.value
      if (value === null || typeof value !== 'object') return null
      const sample = value.sample !== null && typeof value.sample === 'object' ? value.sample : {}
      const host = sample.host !== null && typeof sample.host === 'object' ? sample.host : {}
      const systemInfo = snapshot.host !== null && typeof snapshot.host === 'object'
        ? snapshot.host
        : { kind: 'loading', value: null }
      const hostValue = systemInfo.value !== null && typeof systemInfo.value === 'object' ? systemInfo.value : null
      const capabilities = hostValue !== null && hostValue.capabilities !== null && typeof hostValue.capabilities === 'object'
        ? hostValue.capabilities
        : null
      const unknown = t('system.unknown')
      const textOf = (field) => (typeof field === 'string' && field !== '' ? field : unknown)
      const finiteOf = (field) => (Number.isFinite(field) ? field : null)

      const osVersion = typeof host.osVersion === 'string' ? host.osVersion : ''
      const osText = osVersion === '' ? textOf(host.osName) : `${textOf(host.osName)} ${osVersion}`
      const cpuCores = finiteOf(host.cpuCores)
      const performanceCores = finiteOf(host.performanceCores)
      const efficiencyCores = finiteOf(host.efficiencyCores)
      const coresText = cpuCores === null
        ? unknown
        : (performanceCores !== null && efficiencyCores !== null
          ? t('monitor.system.coresDetail', { count: cpuCores, performance: performanceCores, efficiency: efficiencyCores })
          : t('system.cores', { count: cpuCores }))
      const uptimeText = t('system.uptimeValue', {
        duration: durationText(t, Number.isFinite(host.uptimeSeconds) ? host.uptimeSeconds : 0),
      })

      const version = typeof value.version === 'string' && value.version !== '' ? value.version : unknown
      const hostPid = hostValue !== null && Number.isFinite(hostValue.hostPid) ? String(hostValue.hostPid) : unknown
      const hasSampledAt = typeof value.sampledAt === 'string' && value.sampledAt !== ''
      const sampledAt = hasSampledAt ? formatDateTime(value.sampledAt) : unknown
      const saveDirectory = hostValue !== null && typeof hostValue.saveDirectory === 'string' && hostValue.saveDirectory !== ''
        ? hostValue.saveDirectory
        : unknown
      const intervalMs = MONITOR_INTERVALS.indexOf(monitor.intervalMs) >= 0 ? monitor.intervalMs : MONITOR_POLL_MS
      const intervalText = t('monitor.interval.option', { n: intervalMs / 1000 })
      const pollingText = monitor.paused === true ? t('monitor.paused') : t('monitor.system.pollingActive')

      const hardwareCard = h(SystemCard, { key: 'hardware', title: t('monitor.system.hardware'), icon: 'system' }, [
        h(KeyValue, { key: 'os', label: t('system.os'), value: osText }),
        h(KeyValue, { key: 'arch', label: t('system.arch'), value: textOf(host.arch) }),
        h(KeyValue, { key: 'hostname', label: t('system.hostname'), value: textOf(host.hostname) }),
        h(KeyValue, { key: 'model', label: t('system.model'), value: textOf(host.modelIdentifier) }),
        h(KeyValue, { key: 'chip', label: t('monitor.system.chip'), value: textOf(host.cpuModel) }),
        h(KeyValue, { key: 'cores', label: t('system.coresLabel'), value: coresText }),
        h(KeyValue, { key: 'uptime', label: t('system.uptime'), value: uptimeText }),
      ])

      const runtimeCard = h(SystemCard, { key: 'runtime', title: t('monitor.system.runtime'), icon: 'settings' }, [
        h(KeyValue, { key: 'version', label: t('system.version'), value: version }),
        h(KeyValue, { key: 'hostPid', label: t('monitor.system.hostPid'), value: hostPid }),
        h(KeyValue, { key: 'sampledAt', label: t('monitor.system.sampledAt'), value: sampledAt }),
        h(KeyValue, { key: 'saveDirectory', label: t('system.saveDirectory'), value: saveDirectory, mono: true }),
        h(KeyValue, { key: 'interval', label: t('monitor.system.interval'), value: intervalText }),
        h(KeyValue, { key: 'polling', label: t('monitor.system.polling'), value: pollingText }),
      ])

      const capabilityRows = MONITOR_SYSTEM_CAPABILITIES.map((entry) => h(KeyValue, {
        key: `capability-${entry[0]}`,
        label: t(entry[1]),
        value: hostValue === null
          ? (systemInfo.kind === 'loading' ? t('host.loading') : unknown)
          : (capabilities === null
            ? unknown
            : (capabilities[entry[0]] === true ? t('system.available') : t('system.unavailable'))),
      }))
      const capabilitiesCard = h(SystemCard, {
        key: 'capabilities',
        title: t('monitor.system.capabilities'),
        icon: 'check',
      }, capabilityRows)

      return h('section', {
        className: 'dshMacToolsMonitorSection',
        'aria-label': t('monitor.system.title'),
      }, [
        h('div', { key: 'head', className: 'dshMacToolsMonitorSectionHead' }, [
          h('h2', { key: 'title', className: 'dshMacToolsMonitorSectionTitle' }, t('monitor.system.title')),
          hasSampledAt
            ? h('span', { key: 'meta', className: 'dshMacToolsMonitorSectionMeta' }, t('system.capturedAt', { time: sampledAt }))
            : null,
        ]),
        h('div', { key: 'body', className: 'dshMacToolsMonitorSectionBody' }, [
          h('div', { key: 'grid', className: 'dshMacToolsSysGrid' }, [hardwareCard, runtimeCard, capabilitiesCard]),
          h('p', { key: 'note', className: 'dshMacToolsMonitorMuted' }, t('monitor.system.note')),
        ]),
      ])
    }

    /**
     * The SVG fan-curve editor: 2…8 points joined by straight segments. Drag a
     * point to change its temperature (kept strictly between its neighbours)
     * and speed; click empty space to add one; the selected point can be
     * deleted, and the whole curve can be reset to the default.
     *
     * @param {object} props - translator, points, fan range, disabled, change/commit callbacks.
     * @returns {object} the editor element.
     */
    function MonitorCurveChart({ t, points, minRpm, maxRpm, disabled, onChange, onCommit }) {
      const [selected, setSelected] = React.useState(-1)
      const svgRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const low = Number.isFinite(minRpm) ? minRpm : 1000
      const high = Number.isFinite(maxRpm) && maxRpm > low ? maxRpm : low + 3000
      const list = Array.isArray(points) ? points : []

      const toX = (celsius) => {
        const span = MONITOR_CURVE_MAX_CELSIUS - MONITOR_CURVE_MIN_CELSIUS
        return ((clampNumber(celsius, MONITOR_CURVE_MIN_CELSIUS, MONITOR_CURVE_MAX_CELSIUS) - MONITOR_CURVE_MIN_CELSIUS) / span) * MONITOR_CURVE_WIDTH
      }
      const toY = (rpm) => MONITOR_CURVE_HEIGHT - ((clampNumber(rpm, low, high) - low) / (high - low)) * MONITOR_CURVE_HEIGHT

      /**
       * Map a pointer event to viewBox coordinates through the element rect.
       *
       * @param {object} event - the pointer event.
       * @returns {{x:number,y:number}|null} the position.
       */
      const pointerPosition = (event) => {
        const node = svgRef.current
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null
        const rect = node.getBoundingClientRect()
        const width = Math.max(1, rect.width)
        const height = Math.max(1, rect.height)
        return {
          x: clampNumber(((event.clientX - rect.left) / width) * MONITOR_CURVE_WIDTH, 0, MONITOR_CURVE_WIDTH),
          y: clampNumber(((event.clientY - rect.top) / height) * MONITOR_CURVE_HEIGHT, 0, MONITOR_CURVE_HEIGHT),
        }
      }
      const positionToCelsius = (position) => MONITOR_CURVE_MIN_CELSIUS
        + (position.x / MONITOR_CURVE_WIDTH) * (MONITOR_CURVE_MAX_CELSIUS - MONITOR_CURVE_MIN_CELSIUS)
      const positionToRpm = (position) => high - (position.y / MONITOR_CURVE_HEIGHT) * (high - low)

      const handlePointerDown = (event) => {
        if (disabled === true) return
        const position = pointerPosition(event)
        if (position === null) return
        let hit = -1
        for (let index = 0; index < list.length; index += 1) {
          const dx = toX(list[index].celsius) - position.x
          const dy = toY(list[index].rpm) - position.y
          if (Math.hypot(dx, dy) <= 10) {
            hit = index
            break
          }
        }
        if (hit < 0) {
          if (list.length >= MONITOR_CURVE_MAX_POINTS) return
          const celsius = Math.round(positionToCelsius(position) * 10) / 10
          const rpm = Math.round(positionToRpm(position))
          // Keep at least one degree between nodes so a click next to an
          // existing point cannot make the two impossible to drag apart.
          for (let index = 0; index < list.length; index += 1) {
            if (Math.abs(list[index].celsius - celsius) < 1) return
          }
          const next = list.concat([{ celsius, rpm }]).sort((left, right) => left.celsius - right.celsius)
          hit = next.findIndex((point) => point.celsius === celsius && point.rpm === rpm)
          onChange(next)
        }
        setSelected(hit)
        dragRef.current = { index: hit }
        const target = event.currentTarget
        if (target !== null && target !== undefined && typeof target.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
          try {
            target.setPointerCapture(event.pointerId)
          } catch (error) {
            // Pointer capture is optional; the drag still works without it.
          }
        }
        if (typeof event.preventDefault === 'function') event.preventDefault()
      }

      const handlePointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null || disabled === true) return
        const index = drag.index
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return
        const position = pointerPosition(event)
        if (position === null) return
        const minimum = index > 0 ? list[index - 1].celsius + 1 : MONITOR_CURVE_MIN_CELSIUS
        const maximum = index < list.length - 1 ? list[index + 1].celsius - 1 : MONITOR_CURVE_MAX_CELSIUS
        if (minimum > maximum) return
        const celsius = Math.round(clampNumber(positionToCelsius(position), minimum, maximum) * 10) / 10
        const rpm = Math.round(clampNumber(positionToRpm(position), low, high))
        const next = list.map((point, pointIndex) => (pointIndex === index ? { celsius, rpm } : point))
        onChange(next)
      }

      const handlePointerUp = () => {
        if (dragRef.current === null) return
        dragRef.current = null
        if (typeof onCommit === 'function') onCommit()
      }

      const selectedPoint = Number.isInteger(selected) && selected >= 0 && selected < list.length ? list[selected] : null
      const curvePath = list
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${toX(point.celsius).toFixed(2)},${toY(point.rpm).toFixed(2)}`)
        .join(' ')
      const areaPath = list.length >= 2
        ? `${curvePath} L${toX(list[list.length - 1].celsius).toFixed(2)},${MONITOR_CURVE_HEIGHT} L${toX(list[0].celsius).toFixed(2)},${MONITOR_CURVE_HEIGHT} Z`
        : ''

      const grid = []
      for (let index = 0; index <= 4; index += 1) {
        const ratio = index / 4
        grid.push(h('line', {
          key: `h-${index}`,
          className: 'dshMacToolsMonitorCurveGrid',
          x1: 0,
          y1: MONITOR_CURVE_HEIGHT * ratio,
          x2: MONITOR_CURVE_WIDTH,
          y2: MONITOR_CURVE_HEIGHT * ratio,
        }))
        grid.push(h('line', {
          key: `v-${index}`,
          className: 'dshMacToolsMonitorCurveGrid',
          x1: MONITOR_CURVE_WIDTH * ratio,
          y1: 0,
          x2: MONITOR_CURVE_WIDTH * ratio,
          y2: MONITOR_CURVE_HEIGHT,
        }))
      }
      const ticks = []
      for (let index = 0; index <= 4; index += 1) {
        const ratio = index / 4
        ticks.push(h('text', {
          key: `rpm-${index}`,
          className: 'dshMacToolsMonitorCurveAxis',
          x: 3,
          y: Math.min(MONITOR_CURVE_HEIGHT - 2, MONITOR_CURVE_HEIGHT * ratio + 9),
        }, String(Math.round(high - ratio * (high - low)))))
        ticks.push(h('text', {
          key: `celsius-${index}`,
          className: 'dshMacToolsMonitorCurveAxis',
          x: clampNumber(ratio * MONITOR_CURVE_WIDTH + (index === 0 ? 2 : -14), 0, MONITOR_CURVE_WIDTH - 14),
          y: MONITOR_CURVE_HEIGHT - 2,
        }, String(Math.round(MONITOR_CURVE_MIN_CELSIUS + ratio * (MONITOR_CURVE_MAX_CELSIUS - MONITOR_CURVE_MIN_CELSIUS)))))
      }
      const pointNodes = list.map((point, index) => h('circle', {
        key: `point-${index}`,
        className: index === selected
          ? 'dshMacToolsMonitorCurvePoint dshMacToolsMonitorCurvePointActive'
          : 'dshMacToolsMonitorCurvePoint',
        cx: toX(point.celsius),
        cy: toY(point.rpm),
        r: index === selected ? 6 : 4.5,
      }))

      const deletePoint = () => {
        if (selectedPoint === null || list.length <= MONITOR_CURVE_MIN_POINTS) return
        const next = list.filter((point, index) => index !== selected)
        setSelected(-1)
        onChange(next)
        if (typeof onCommit === 'function') onCommit()
      }
      const resetCurve = () => {
        setSelected(-1)
        onChange(monitorDefaultCurve(low, high))
        if (typeof onCommit === 'function') onCommit()
      }

      const chart = h('svg', {
        key: 'chart',
        ref: svgRef,
        className: 'dshMacToolsMonitorCurveSvg',
        viewBox: `0 0 ${MONITOR_CURVE_WIDTH} ${MONITOR_CURVE_HEIGHT}`,
        role: 'img',
        'aria-label': t('monitor.fan.curve.hint'),
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerUp,
      }, [
        h('g', { key: 'grid' }, grid),
        areaPath === '' ? null : h('path', { key: 'area', className: 'dshMacToolsMonitorCurveArea', d: areaPath }),
        h('path', { key: 'line', className: 'dshMacToolsMonitorCurveLine', d: curvePath }),
        h('g', { key: 'ticks' }, ticks),
        h('g', { key: 'points' }, pointNodes),
      ])

      const bar = h('div', { key: 'bar', className: 'dshMacToolsMonitorCurveBar' }, [
        h('p', { key: 'meta', className: 'dshMacToolsMonitorCurveMeta' }, selectedPoint === null
          ? t('monitor.fan.curve.points', { count: list.length })
          : t('monitor.fan.curve.point', { celsius: selectedPoint.celsius.toFixed(1), rpm: Math.round(selectedPoint.rpm) })),
        h('button', {
          key: 'delete',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
          disabled: disabled === true || selectedPoint === null || list.length <= MONITOR_CURVE_MIN_POINTS,
          onClick: deletePoint,
        }, t('monitor.fan.curve.delete')),
        h('button', {
          key: 'reset',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          disabled: disabled === true,
          onClick: resetCurve,
        }, t('monitor.fan.curve.reset')),
        h('button', {
          key: 'apply',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonPrimary',
          disabled: disabled === true || list.length < MONITOR_CURVE_MIN_POINTS,
          onClick: () => {
            if (typeof onCommit === 'function') onCommit()
          },
        }, t('monitor.fan.curve.apply')),
      ])

      return h('div', { className: 'dshMacToolsMonitorCurveBox' }, [
        chart,
        bar,
        h('p', { key: 'hint', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.curve.hint')),
      ])
    }

    /**
     * 风扇控制. Renders the install CTA / status card / ready-state controls
     * (per-fan readings, auto/manual/curve modes, manual slider committed on
     * release, the curve editor, presets and uninstall), exactly per §5.
     *
     * @param {object} props - store, snapshot and translator.
     * @returns {object} the section element.
     */
    function MonitorFanSection({ store, snapshot, t }) {
      const monitor = snapshot.monitor
      const value = monitor.value
      const fanState = monitor.fan
      const pending = fanState.pending
      const fanError = fanState.error
      const [manualRpm, setManualRpm] = React.useState(null)
      const manualRef = React.useRef(null)
      const [curveDraft, setCurveDraft] = React.useState(null)
      const curveRef = React.useRef(null)
      const [presetName, setPresetName] = React.useState('')
      const [presetNotice, setPresetNotice] = React.useState('')
      const [confirmUninstall, setConfirmUninstall] = React.useState(false)
      const commitTimer = React.useRef(null)

      const fanControl = value !== null && typeof value === 'object'
        && value.fanControl !== null && typeof value.fanControl === 'object'
        ? value.fanControl
        : null
      const sample = value !== null && typeof value === 'object' && value.sample !== null && typeof value.sample === 'object'
        ? value.sample
        : {}
      const fansBlock = sample.fans !== null && typeof sample.fans === 'object' ? sample.fans : null
      const fanItems = fansBlock !== null && Array.isArray(fansBlock.items) ? fansBlock.items : []
      const ready = fanControl !== null && fanControl.state === 'ready'
      const installed = fanControl !== null && fanControl.installed === true
      const minRpm = fanControl !== null && Number.isFinite(fanControl.minRpm) ? fanControl.minRpm : 1000
      const maxRpm = fanControl !== null && Number.isFinite(fanControl.maxRpm) && fanControl.maxRpm > minRpm
        ? fanControl.maxRpm
        : minRpm + 3000
      const busyInstall = pending === 'install' || pending === 'uninstall'
      const controlsDisabled = busyInstall === true

      // Seed the editable drafts from the Host's applied state. The signatures
      // change only when the Host's value changes, so a poll every second never
      // clobbers what the operator is dragging.
      const curveSignature = ready && fanControl.curve !== null && typeof fanControl.curve === 'object'
        ? JSON.stringify(fanControl.curve)
        : ''
      React.useEffect(() => {
        if (ready !== true || fanControl.curve === null || typeof fanControl.curve !== 'object') return
        const seeded = monitorSanitizeCurve(fanControl.curve, minRpm, maxRpm)
        const next = {
          sensor: seeded.sensor,
          points: seeded.points.length >= MONITOR_CURVE_MIN_POINTS ? seeded.points : monitorDefaultCurve(minRpm, maxRpm),
        }
        setCurveDraft(next)
        curveRef.current = next
      }, [curveSignature])

      const manualSignature = ready && Number.isFinite(fanControl.manualRpm) ? `${fanControl.mode}:${fanControl.manualRpm}` : ''
      React.useEffect(() => {
        if (ready !== true || !Number.isFinite(fanControl.manualRpm)) return
        const next = clampNumber(fanControl.manualRpm, minRpm, maxRpm)
        setManualRpm(next)
        manualRef.current = next
      }, [manualSignature])

      React.useEffect(() => () => {
        if (commitTimer.current !== null) clearTimeout(commitTimer.current)
      }, [])

      React.useEffect(() => {
        if (presetNotice === '') return undefined
        const timer = setTimeout(() => setPresetNotice(''), MONITOR_ALERT_NOTICE_MS)
        return () => clearTimeout(timer)
      }, [presetNotice])

      React.useEffect(() => {
        if (confirmUninstall !== true) return undefined
        const timer = setTimeout(() => setConfirmUninstall(false), MONITOR_KILL_ARM_MS)
        return () => clearTimeout(timer)
      }, [confirmUninstall])

      const fallbackCurve = () => {
        const source = fanControl !== null && fanControl.curve !== null && typeof fanControl.curve === 'object'
          ? fanControl.curve
          : null
        const seeded = monitorSanitizeCurve(source, minRpm, maxRpm)
        return {
          sensor: seeded.sensor,
          points: seeded.points.length >= MONITOR_CURVE_MIN_POINTS ? seeded.points : monitorDefaultCurve(minRpm, maxRpm),
        }
      }
      const effectiveCurve = curveDraft !== null ? curveDraft : fallbackCurve()
      const effectiveManual = manualRpm !== null
        ? manualRpm
        : (ready && Number.isFinite(fanControl.manualRpm) ? clampNumber(fanControl.manualRpm, minRpm, maxRpm) : minRpm)

      const scheduleApply = (payload) => {
        if (commitTimer.current !== null) clearTimeout(commitTimer.current)
        commitTimer.current = setTimeout(() => {
          commitTimer.current = null
          void store.fanApply(payload)
        }, MONITOR_FAN_DEBOUNCE_MS)
      }
      const commitManual = () => {
        const rpm = Math.round(Number(manualRef.current === null ? effectiveManual : manualRef.current))
        if (!Number.isFinite(rpm)) return
        scheduleApply({ mode: 'manual', rpm: clampNumber(rpm, minRpm, maxRpm) })
      }
      const commitCurve = () => {
        const draft = curveRef.current !== null ? curveRef.current : effectiveCurve
        if (draft === null) return
        scheduleApply({
          mode: 'curve',
          sensor: draft.sensor,
          points: draft.points.map((point) => ({ celsius: point.celsius, rpm: Math.round(point.rpm) })),
        })
      }
      const handleCurveChange = (nextPoints) => {
        if (!Array.isArray(nextPoints)) return
        const sensor = curveRef.current !== null ? curveRef.current.sensor : effectiveCurve.sensor
        const next = { sensor, points: nextPoints }
        setCurveDraft(next)
        curveRef.current = next
      }
      const handleManualChange = (event) => {
        const next = Number(event.target.value)
        if (!Number.isFinite(next)) return
        setManualRpm(next)
        manualRef.current = next
      }
      const handleSensorChange = (event) => {
        const sensor = typeof event.target.value === 'string' ? event.target.value : effectiveCurve.sensor
        const next = { sensor, points: effectiveCurve.points }
        setCurveDraft(next)
        curveRef.current = next
      }
      const applyMode = (mode) => {
        if (ready !== true || pending !== null) return
        if (mode === 'auto') {
          void store.fanApply({ mode: 'auto' })
          return
        }
        const draft = curveRef.current !== null ? curveRef.current : effectiveCurve
        if (mode === 'manual') {
          const rpm = Math.round(Number(manualRef.current === null ? effectiveManual : manualRef.current))
          void store.fanApply({ mode: 'manual', rpm: clampNumber(Number.isFinite(rpm) ? rpm : effectiveManual, minRpm, maxRpm) })
          return
        }
        void store.fanApply({
          mode: 'curve',
          sensor: draft.sensor,
          points: draft.points.map((point) => ({ celsius: point.celsius, rpm: Math.round(point.rpm) })),
        })
      }
      const applyPreset = (preset) => {
        if (preset === null || typeof preset !== 'object' || pending !== null) return
        if (preset.mode === 'auto') {
          void store.fanApply({ mode: 'auto' })
          return
        }
        if (preset.mode === 'manual' && Number.isFinite(preset.rpm)) {
          void store.fanApply({ mode: 'manual', rpm: preset.rpm })
          return
        }
        if (preset.mode === 'curve' && preset.curve !== null && typeof preset.curve === 'object') {
          const points = Array.isArray(preset.curve.points) ? preset.curve.points : []
          void store.fanApply({
            mode: 'curve',
            sensor: typeof preset.curve.sensor === 'string' ? preset.curve.sensor : effectiveCurve.sensor,
            points,
          })
        }
      }
      const savePreset = () => {
        if (ready !== true || pending !== null) return
        const name = presetName.trim()
        if (name === '') {
          setPresetNotice(t('monitor.fan.preset.nameRequired'))
          return
        }
        if (fanControl.mode === 'auto') {
          setPresetNotice(t('monitor.fan.preset.invalid'))
          return
        }
        setPresetNotice('')
        const draft = fanControl.mode === 'curve'
          ? {
            name,
            mode: 'curve',
            sensor: effectiveCurve.sensor,
            points: effectiveCurve.points.map((point) => ({ celsius: point.celsius, rpm: Math.round(point.rpm) })),
          }
          : { name, mode: 'manual', rpm: Math.round(effectiveManual) }
        void store.fanSavePreset(draft).then((saved) => {
          if (saved === true) {
            setPresetName('')
            setPresetNotice(t('monitor.fan.preset.saved'))
          }
        })
      }
      const requestUninstall = () => {
        if (confirmUninstall === true) {
          setConfirmUninstall(false)
          void store.fanUninstall()
          return
        }
        setConfirmUninstall(true)
      }

      const spinner = h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true })
      const fanErrorNotice = fanError === null || fanError === undefined
        ? null
        : h('div', { key: 'fan-error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, monitorFanErrorText(t, fanError)),
          h('button', {
            key: 'dismiss',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact',
            onClick: () => store.dismissFanError(),
          }, t('common.dismiss')),
        ])
      const retryButton = h('button', {
        key: 'retry',
        type: 'button',
        className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
        onClick: () => { void store.refreshMonitor() },
      }, t('monitor.fan.retry'))
      const uninstallButton = installed || ready
        ? h('button', {
          key: 'uninstall',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonDanger',
          title: t('monitor.fan.uninstallHint'),
          disabled: pending !== null,
          onClick: requestUninstall,
        }, pending === 'uninstall'
          ? t('monitor.fan.uninstalling')
          : confirmUninstall === true
            ? t('monitor.fan.uninstallConfirm')
            : t('monitor.fan.uninstall'))
        : null
      const otherControllers = fanControl !== null && Array.isArray(fanControl.otherControllers)
        ? fanControl.otherControllers.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name !== '')
        : []
      const otherWarning = otherControllers.length === 0
        ? null
        : h('p', { key: 'other-controllers', className: 'dshMacToolsMonitorWarning', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsMonitorWarningIcon', 'aria-hidden': true }, glyph('alert', 14)),
          h('span', { key: 'text' }, t('monitor.fan.otherControllers', {
            names: monitorNameListText(t, otherControllers.map((entry) => entry.name)),
          })),
        ])

      const modeButtons = ['auto', 'manual', 'curve'].map((mode) => h('button', {
        key: mode,
        type: 'button',
        className: fanControl !== null && fanControl.mode === mode
          ? 'dshMacToolsMonitorSegment dshMacToolsMonitorSegmentActive'
          : 'dshMacToolsMonitorSegment',
        'aria-pressed': fanControl !== null && fanControl.mode === mode,
        disabled: ready !== true || pending !== null,
        onClick: () => applyMode(mode),
      }, monitorFanModeLabel(t, mode)))

      const fanRows = fanItems.map((fan, index) => {
        const fanIndex = Number.isFinite(fan.index) ? fan.index : index
        const actual = monitorRpmText(fan.actualRpm)
        const target = monitorRpmText(fan.targetRpm)
        const low = Number.isFinite(fan.minRpm) ? Math.round(fan.minRpm) : Math.round(minRpm)
        const high = Number.isFinite(fan.maxRpm) ? Math.round(fan.maxRpm) : Math.round(maxRpm)
        return h('li', { key: `fan-${fanIndex}`, className: 'dshMacToolsMonitorFanRow' }, [
          h('span', { key: 'name', className: 'dshMacToolsMonitorFanName' }, t('monitor.fan.fanName', { index: fanIndex + 1 })),
          h('span', { key: 'actual', className: 'dshMacToolsMonitorFanMeta' }, t('monitor.fan.actual', { rpm: actual })),
          h('span', { key: 'target', className: 'dshMacToolsMonitorFanHint' }, t('monitor.fan.target', { rpm: target })),
          h('span', { key: 'range', className: 'dshMacToolsMonitorFanHint' }, t('monitor.fan.range', { min: low, max: high })),
          h('span', { key: 'mode', className: 'dshMacToolsMonitorFanBadge' }, monitorFanItemModeLabel(t, typeof fan.mode === 'string' ? fan.mode : 'unknown')),
        ])
      })

      const modeRow = h('div', { key: 'modes', className: 'dshMacToolsMonitorFanBar' }, [
        h('span', { key: 'label', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.mode')),
        h('div', { key: 'seg', className: 'dshMacToolsMonitorSegmented' }, modeButtons),
        pending === 'apply' || pending === 'preset'
          ? h('span', { key: 'busy', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.pendingApply'))
          : null,
      ])

      const manualBlock = h('div', { key: 'manual', className: 'dshMacToolsMonitorSectionBody' }, [
        h('div', { key: 'row', className: 'dshMacToolsMonitorSliderRow' }, [
          h('span', { key: 'label', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.manual')),
          h('input', {
            key: 'slider',
            type: 'range',
            className: 'dshMacToolsMonitorSlider',
            min: minRpm,
            max: maxRpm,
            step: 10,
            value: Math.round(effectiveManual),
            'aria-label': t('monitor.fan.manual'),
            disabled: controlsDisabled,
            onChange: handleManualChange,
            onPointerUp: commitManual,
            onKeyUp: commitManual,
            onBlur: commitManual,
          }),
          h('span', {
            key: 'value',
            className: 'dshMacToolsMonitorSliderValue',
          }, t('monitor.fan.manualValue', { rpm: Math.round(effectiveManual) })),
        ]),
        h('p', { key: 'hint', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.manualHint')),
      ])

      const sensorIds = fanControl !== null && Array.isArray(fanControl.sensorOptions) && fanControl.sensorOptions.length > 0
        ? fanControl.sensorOptions
        : Object.keys(MONITOR_SENSOR_GROUP_KEYS)
      const sensorControl = h('div', { key: 'sensor', className: 'dshMacToolsMonitorFanBar' }, [
        h('span', { key: 'label', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.curve.sensor')),
        h('select', {
          key: 'select',
          className: 'dshMacToolsInput dshMacToolsMonitorPresetInput',
          value: effectiveCurve.sensor,
          'aria-label': t('monitor.fan.curve.sensor'),
          disabled: controlsDisabled,
          onChange: handleSensorChange,
        }, sensorIds.map((id) => h('option', { key: String(id), value: String(id) }, monitorSensorGroupLabel(t, String(id))))),
      ])

      const curveBlock = h('div', { key: 'curve', className: 'dshMacToolsMonitorSectionBody' }, [
        h('p', { key: 'title', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.curve.title')),
        sensorControl,
        h(MonitorCurveChart, {
          key: 'chart',
          t,
          points: effectiveCurve.points,
          minRpm,
          maxRpm,
          disabled: controlsDisabled,
          onChange: handleCurveChange,
          onCommit: commitCurve,
        }),
      ])

      const presets = fanControl !== null && Array.isArray(fanControl.presets) ? fanControl.presets : []
      const presetNodes = presets.map((preset, index) => {
        const label = monitorPresetLabel(t, preset)
        const active = monitorPresetActive(preset, fanControl)
        const chip = h('button', {
          key: `preset-${typeof preset.id === 'string' ? preset.id : index}`,
          type: 'button',
          className: active
            ? 'dshMacToolsMonitorPreset dshMacToolsMonitorPresetActive'
            : 'dshMacToolsMonitorPreset',
          'aria-pressed': active,
          disabled: pending !== null,
          onClick: () => applyPreset(preset),
        }, label)
        if (preset.builtin === true) return chip
        const id = typeof preset.id === 'string' ? preset.id : ''
        return h('span', {
          key: `preset-wrap-${id === '' ? index : id}`,
          className: 'dshMacToolsMonitorPresetWrap',
        }, [
          chip,
          h('button', {
            key: 'delete',
            type: 'button',
            className: 'dshMacToolsMonitorPresetDelete',
            'aria-label': t('monitor.fan.preset.delete', { name: label }),
            title: t('monitor.fan.preset.delete', { name: label }),
            disabled: pending !== null,
            onClick: () => { void store.fanDeletePreset(id) },
          }, '×'),
        ])
      })
      const presetSaveRow = h('div', { key: 'preset-save', className: 'dshMacToolsMonitorPresetSave' }, [
        h('input', {
          key: 'name',
          type: 'text',
          className: 'dshMacToolsInput dshMacToolsMonitorPresetInput',
          value: presetName,
          maxLength: 40,
          placeholder: t('monitor.fan.preset.namePlaceholder'),
          'aria-label': t('monitor.fan.preset.namePlaceholder'),
          disabled: controlsDisabled,
          onChange: (event) => setPresetName(event.target.value),
        }),
        h('button', {
          key: 'save',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          title: t('monitor.fan.preset.saveActive'),
          disabled: pending !== null || presetName.trim() === '' || fanControl === null || fanControl.mode === 'auto',
          onClick: savePreset,
        }, t('monitor.fan.preset.save')),
        presetNotice === ''
          ? null
          : h('span', { key: 'notice', className: 'dshMacToolsMonitorAlertNotice' }, presetNotice),
      ])
      const presetsBlock = h('div', { key: 'presets', className: 'dshMacToolsMonitorSectionBody' }, [
        h('p', { key: 'label', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.presets')),
        h('div', { key: 'chips', className: 'dshMacToolsMonitorPresets' }, presetNodes),
        presetSaveRow,
      ])

      const appliedRpm = fanControl !== null && Number.isFinite(fanControl.appliedRpm) ? fanControl.appliedRpm : null
      const appliedAt = fanControl !== null && typeof fanControl.lastAppliedAt === 'string' && fanControl.lastAppliedAt !== ''
        ? formatDateTime(fanControl.lastAppliedAt)
        : ''
      const holdingText = fanControl === null || fanControl.mode === 'auto' || appliedRpm === null
        ? t('monitor.fan.autoHolding')
        : t('monitor.fan.holding', { rpm: Math.round(appliedRpm) })
      const fanFooter = h('p', { key: 'footer', className: 'dshMacToolsMonitorFanFooter' }, appliedAt === ''
        ? holdingText
        : `${holdingText} · ${t('monitor.fan.appliedAt', { time: appliedAt })}`)

      let body
      if (fanControl === null) {
        body = [
          h('p', { key: 'hint', className: 'dshMacToolsMonitorMuted' }, t('monitor.fan.notReadyHint')),
          fanErrorNotice,
          h('div', { key: 'actions', className: 'dshMacToolsMonitorFanBar' }, retryButton),
        ]
      } else if (fanControl.state === 'not-installed') {
        body = [
          h('p', { key: 'title', className: 'dshMacToolsMonitorSectionMeta' }, t('monitor.fan.notInstalledTitle')),
          h('p', { key: 'intro', className: 'dshMacToolsMonitorInstallText' }, t('monitor.fan.install.intro')),
          h('p', { key: 'helper', className: 'dshMacToolsMonitorInstallMeta' }, t('monitor.fan.install.helper')),
          h('p', { key: 'daemon', className: 'dshMacToolsMonitorInstallMeta' }, t('monitor.fan.install.daemon')),
          h('p', { key: 'prompt', className: 'dshMacToolsMonitorInstallMeta' }, t('monitor.fan.install.prompt')),
          fanErrorNotice,
          h('div', { key: 'actions', className: 'dshMacToolsMonitorFanBar' }, pending === 'install'
            ? h('p', { key: 'busy', className: 'dshMacToolsMonitorMuted', role: 'status' }, [spinner, t('monitor.fan.enabling')])
            : h('button', {
              key: 'enable',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonPrimary',
              disabled: pending !== null,
              onClick: () => { void store.fanInstall() },
            }, [glyph('settings', 15, 'icon'), h('span', { key: 'label' }, t('monitor.fan.enable'))])),
        ]
      } else if (fanControl.state === 'installing') {
        body = [
          h('p', { key: 'busy', className: 'dshMacToolsMonitorMuted', role: 'status' }, [spinner, t('monitor.fan.installing')]),
        ]
      } else if (fanControl.state === 'unavailable') {
        body = [
          h('div', { key: 'unavailable', className: 'dshMacToolsNotice', role: 'status' }, [
            h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
            h('p', { key: 'text' }, monitorFanReasonText(t, fanControl.reason, fanControl.message)),
          ]),
          fanErrorNotice,
          h('div', { key: 'actions', className: 'dshMacToolsMonitorFanBar' }, [retryButton, uninstallButton]),
        ]
      } else if (fanControl.state === 'error') {
        const retryable = fanControl.reason !== 'no-fans' && fanControl.reason !== 'unsupported-platform'
        body = [
          h('p', { key: 'title', className: 'dshMacToolsMonitorSectionMeta' }, t('monitor.fan.errorTitle')),
          h('div', { key: 'reason', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
            h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
            h('p', { key: 'text' }, monitorFanReasonText(t, fanControl.reason, fanControl.message)),
          ]),
          fanErrorNotice,
          otherWarning,
          h('div', { key: 'actions', className: 'dshMacToolsMonitorFanBar' }, [
            retryButton,
            retryable
              ? h('button', {
                key: 'reinstall',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
                disabled: pending !== null,
                onClick: () => { void store.fanInstall() },
              }, pending === 'install' ? t('monitor.fan.enabling') : t('monitor.fan.reinstall'))
              : null,
            uninstallButton,
          ]),
        ]
      } else {
        body = [
          fanRows.length === 0
            ? null
            : h('ul', { key: 'fans', className: 'dshMacToolsMonitorFanFans', 'aria-label': t('monitor.fan.fansAria') }, fanRows),
          otherWarning,
          modeRow,
          manualBlock,
          curveBlock,
          presetsBlock,
          h('div', { key: 'bottom', className: 'dshMacToolsMonitorFanBar' }, [
            h('button', {
              key: 'auto',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
              disabled: pending !== null,
              onClick: () => { void store.fanApply({ mode: 'auto' }) },
            }, t('monitor.fan.restoreAuto')),
            uninstallButton,
          ]),
          fanFooter,
          fanErrorNotice,
        ]
      }

      return h('section', {
        className: 'dshMacToolsMonitorSection',
        'aria-label': t('monitor.fan.title'),
      }, [
        h('div', { key: 'head', className: 'dshMacToolsMonitorSectionHead' }, [
          h('h2', { key: 'title', className: 'dshMacToolsMonitorSectionTitle' }, t('monitor.fan.title')),
          ready
            ? h('span', { key: 'mode', className: 'dshMacToolsMonitorSectionMeta' }, monitorFanModeLabel(t, fanControl.mode))
            : null,
        ]),
        h('div', { key: 'body', className: 'dshMacToolsMonitorSectionBody' }, body),
      ])
    }

    /**
     * 进程排行. Collapsed by default; while expanded the visible tab polls the
     * Host every three seconds. Each row's kill action is a two-step inline
     * confirmation armed for three seconds; the Host's `killable` flag (when
     * present) is authoritative, and the documented error codes are the final
     * authority on a refused kill.
     *
     * @param {object} props - store, snapshot and translator.
     * @returns {object} the section element.
     */
    function MonitorProcessSection({ store, snapshot, t }) {
      const processes = snapshot.monitor.processes
      const open = processes.open === true
      const sort = processes.sort === 'memory' ? 'memory' : 'cpu'
      const armedPid = processes.armedPid
      const killingPid = processes.killingPid
      const actionError = processes.actionError
      const listError = processes.error
      const value = processes.value
      const rows = value !== null && typeof value === 'object' && Array.isArray(value.processes)
        ? value.processes.slice(0, MONITOR_PROCESS_LIMIT)
        : []

      React.useEffect(() => {
        if (armedPid === null || armedPid === undefined) return undefined
        const timer = setTimeout(() => store.cancelProcessKill(), MONITOR_KILL_ARM_MS)
        return () => clearTimeout(timer)
      }, [armedPid, store])

      const toggle = h('div', { key: 'actions', className: 'dshMacToolsMonitorSectionActions' }, h('button', {
        type: 'button',
        className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
        'aria-expanded': open,
        onClick: () => store.toggleMonitorProcesses(),
      }, open ? t('monitor.processes.collapse') : t('monitor.processes.expand')))

      const head = h('div', { key: 'head', className: 'dshMacToolsMonitorSectionHead' }, [
        h('h2', { key: 'title', className: 'dshMacToolsMonitorSectionTitle' }, t('monitor.processes.title')),
        toggle,
      ])

      if (open !== true) {
        return h('section', {
          className: 'dshMacToolsMonitorSection',
          'aria-label': t('monitor.processes.title'),
        }, [head])
      }

      const sortButtons = ['cpu', 'memory'].map((id) => h('button', {
        key: id,
        type: 'button',
        className: sort === id
          ? 'dshMacToolsMonitorSegment dshMacToolsMonitorSegmentActive'
          : 'dshMacToolsMonitorSegment',
        'aria-pressed': sort === id,
        onClick: () => store.setMonitorProcessSort(id),
      }, t(`monitor.processes.sort.${id}`)))

      const sortRow = h('div', { key: 'sort', className: 'dshMacToolsMonitorProcessSort' }, [
        h('div', {
          key: 'seg',
          className: 'dshMacToolsMonitorSegmented',
          role: 'group',
          'aria-label': t('monitor.processes.sortAria'),
        }, sortButtons),
        h('span', { key: 'hint', className: 'dshMacToolsMonitorMuted' }, t('monitor.processes.hint', {
          sort: t(`monitor.processes.sort.${sort}`),
        })),
        processes.status === 'loading' && value === null
          ? h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true })
          : null,
      ])

      const headerRow = h('li', {
        key: 'columns',
        className: 'dshMacToolsMonitorProcessRow dshMacToolsMonitorProcessRowHead',
        'aria-hidden': true,
      }, [
        h('span', { key: 'name' }, t('monitor.processes.name')),
        h('span', { key: 'cpu', className: 'dshMacToolsMonitorProcessValue' }, t('monitor.processes.cpu')),
        h('span', { key: 'memory', className: 'dshMacToolsMonitorProcessValue' }, t('monitor.processes.memory')),
        h('span', {
          key: 'rss',
          className: 'dshMacToolsMonitorProcessValue dshMacToolsMonitorProcessValueRss',
        }, t('monitor.processes.rss')),
        h('span', { key: 'actions' }),
      ])

      const rowNodes = rows.map((row, index) => {
        const pid = Number.isFinite(row.pid) ? row.pid : null
        const name = typeof row.name === 'string' && row.name !== '' ? row.name : t('monitor.unknown')
        const cpuPercent = Number.isFinite(row.cpuPercent) ? row.cpuPercent : 0
        const memoryPercent = Number.isFinite(row.memoryPercent) ? row.memoryPercent : 0
        const killable = row.killable !== false
          && pid !== null
          && Number.isInteger(pid)
          && pid > 1
          && row.protected !== true
        const armed = pid !== null && armedPid === pid
        const killing = pid !== null && killingPid === pid
        let action
        if (killable !== true || pid === null) {
          action = h('span', {
            key: 'protected',
            className: 'dshMacToolsMonitorProtected',
            title: t('monitor.processes.killProtected'),
          }, t('monitor.processes.killProtected'))
        } else {
          action = h('button', {
            key: 'kill',
            type: 'button',
            className: armed ? 'dshMacToolsMonitorKill dshMacToolsMonitorKillArmed' : 'dshMacToolsMonitorKill',
            disabled: killing === true,
            'aria-label': t('monitor.processes.killAria', { name, pid }),
            onClick: () => {
              if (armed === true) void store.killMonitorProcess(pid)
              else store.armProcessKill(pid)
            },
          }, killing === true
            ? t('monitor.processes.killing')
            : armed === true
              ? t('monitor.processes.killArmed')
              : t('monitor.processes.kill'))
        }
        return h('li', {
          key: pid === null ? `row-${index}` : `row-${pid}-${index}`,
          className: 'dshMacToolsMonitorProcessRow',
        }, [
          h('span', { key: 'name', className: 'dshMacToolsMonitorProcessName' }, [
            h('span', { key: 'label', className: 'dshMacToolsMonitorProcessLabel', title: name }, name),
            h('span', {
              key: 'pid',
              className: 'dshMacToolsMonitorProcessPid',
            }, pid === null ? '' : t('monitor.processes.pid', { pid })),
          ]),
          h('span', { key: 'cpu', className: 'dshMacToolsMonitorProcessValue' }, `${formatPercent(cpuPercent)}%`),
          h('span', { key: 'memory', className: 'dshMacToolsMonitorProcessValue' }, `${formatPercent(memoryPercent)}%`),
          h('span', {
            key: 'rss',
            className: 'dshMacToolsMonitorProcessValue dshMacToolsMonitorProcessValueRss',
          }, monitorSizeText(row.rssBytes)),
          h('span', { key: 'actions', className: 'dshMacToolsMonitorProcessActions' }, action),
        ])
      })

      const actionErrorNotice = actionError === null || actionError === undefined
        ? null
        : h('div', { key: 'action-error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, monitorProcessErrorText(t, actionError)),
          h('button', {
            key: 'dismiss',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact',
            onClick: () => store.dismissMonitorProcessError(),
          }, t('common.dismiss')),
        ])
      const staleErrorNotice = listError === null || listError === undefined
        ? null
        : h('p', { key: 'list-error', className: 'dshMacToolsMonitorAlertError', role: 'alert' }, t('monitor.processes.error', {
          message: listError.message !== undefined && listError.message !== null ? listError.message : '',
        }))

      let listBody
      if (value === null) {
        if (processes.status === 'error' && listError !== null && listError !== undefined) {
          listBody = h('div', { key: 'error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
            h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
            h('p', { key: 'text' }, t('monitor.processes.error', {
              message: listError.message !== undefined && listError.message !== null ? listError.message : '',
            })),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => { void store.loadMonitorProcesses() },
            }, t('common.retry')),
          ])
        } else {
          listBody = h('p', { key: 'loading', className: 'dshMacToolsMonitorMuted', role: 'status' }, [
            h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }),
            ' ',
            t('monitor.processes.loading'),
          ])
        }
      } else if (rows.length === 0) {
        listBody = h('p', { key: 'empty', className: 'dshMacToolsMonitorMuted' }, t('monitor.processes.empty'))
      } else {
        listBody = h('ul', {
          key: 'table',
          className: 'dshMacToolsMonitorProcessTable',
          'aria-label': t('monitor.processes.title'),
        }, [headerRow].concat(rowNodes))
      }

      return h('section', {
        className: 'dshMacToolsMonitorSection',
        'aria-label': t('monitor.processes.title'),
      }, [
        head,
        h('div', { key: 'body', className: 'dshMacToolsMonitorSectionBody' }, [
          sortRow,
          actionErrorNotice,
          value === null ? null : staleErrorNotice,
          listBody,
        ]),
      ])
    }

    /**
     * 告警. Enabled/notify switches, the three threshold fields, the cooldown,
     * save/test buttons and the recent events list (newest first, localized).
     *
     * @param {object} props - store, snapshot and translator.
     * @returns {object} the section element.
     */
    function MonitorAlertsSection({ store, snapshot, t }) {
      const monitor = snapshot.monitor
      const value = monitor.value
      const alertsState = monitor.alerts
      const block = value !== null && typeof value === 'object' && value.alerts !== null && typeof value.alerts === 'object'
        ? value.alerts
        : null
      const settings = block !== null && block.settings !== null && typeof block.settings === 'object' ? block.settings : null
      const events = block !== null && Array.isArray(block.events) ? block.events : []
      const sensors = value !== null && typeof value === 'object'
        && value.sample !== null && typeof value.sample === 'object'
        && value.sample.sensors !== null && typeof value.sample.sensors === 'object'
        ? value.sample.sensors
        : null
      // §6: without SMC there is no temperature to alert on, so the field is
      // disabled and the reason is explained instead of silently saving.
      const temperatureDisabled = sensors !== null && sensors.available === false
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), MONITOR_ALERT_NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      /**
       * Turn an alerts settings block into editable string fields.
       *
       * @param {object} source - the Host's settings.
       * @returns {object} the form draft.
       */
      function draftFrom(source) {
        return {
          enabled: source.enabled === true,
          cpuPercent: Number.isFinite(source.cpuPercent) ? String(source.cpuPercent) : '90',
          temperatureCelsius: Number.isFinite(source.temperatureCelsius) ? String(source.temperatureCelsius) : '95',
          memoryPercent: Number.isFinite(source.memoryPercent) ? String(source.memoryPercent) : '90',
          cooldownSeconds: Number.isFinite(source.cooldownSeconds) ? String(source.cooldownSeconds) : '300',
          notify: source.notify === true,
        }
      }

      const form = draft !== null ? draft : (settings === null ? null : draftFrom(settings))
      const numericValues = {}
      let invalid = false
      if (form !== null) {
        const fields = ['cpuPercent', 'temperatureCelsius', 'memoryPercent', 'cooldownSeconds']
        for (let index = 0; index < fields.length; index += 1) {
          const raw = form[fields[index]]
          const parsed = Number(raw)
          numericValues[fields[index]] = parsed
          if (raw === '' || raw === null || raw === undefined || !Number.isFinite(parsed)) invalid = true
        }
      }

      const updateField = (field, next) => {
        const base = form === null ? {} : form
        setDraft(Object.assign({}, base, { [field]: next }))
      }
      const save = () => {
        if (form === null) return
        if (invalid === true) {
          setNotice({ kind: 'error', text: t('monitor.alerts.error.invalid') })
          return
        }
        void store.saveMonitorAlerts({
          enabled: form.enabled === true,
          cpuPercent: numericValues.cpuPercent,
          temperatureCelsius: numericValues.temperatureCelsius,
          memoryPercent: numericValues.memoryPercent,
          cooldownSeconds: numericValues.cooldownSeconds,
          notify: form.notify === true,
        }).then((result) => {
          if (result !== null && result.ok === true) {
            const saved = result.settings
            setDraft(saved !== null && typeof saved === 'object' ? draftFrom(saved) : null)
            setNotice({ kind: 'ok', text: t('monitor.alerts.saved') })
            return
          }
          const failure = result !== null && result.error !== null ? result.error : null
          setNotice({
            kind: 'error',
            text: failure === null ? t('monitor.alerts.error.invalid') : monitorAlertErrorText(t, failure),
          })
        })
      }
      const test = () => {
        void store.testMonitorAlerts().then((result) => {
          if (result === null) return
          if (result.ok !== true) {
            const failure = result.error
            setNotice({
              kind: 'error',
              text: failure === null
                ? t('monitor.alerts.testUnavailable')
                : (failure.code === 'host_missing' || failure.code === 'host_unreachable'
                  ? monitorAlertErrorText(t, failure)
                  : t('monitor.alerts.testFailed', { message: failure.message !== undefined ? failure.message : '' })),
            })
            return
          }
          setNotice({
            kind: result.notified === true ? 'ok' : 'error',
            text: result.notified === true ? t('monitor.alerts.testSent') : t('monitor.alerts.testUnavailable'),
          })
        })
      }

      const head = h('div', { key: 'head', className: 'dshMacToolsMonitorSectionHead' }, [
        h('h2', { key: 'title', className: 'dshMacToolsMonitorSectionTitle' }, t('monitor.alerts.title')),
        h('span', { key: 'hint', className: 'dshMacToolsMonitorSectionMeta' }, t('monitor.alerts.hint')),
      ])

      if (block === null || form === null) {
        return h('section', {
          className: 'dshMacToolsMonitorSection',
          'aria-label': t('monitor.alerts.title'),
        }, [
          head,
          h('p', { key: 'unavailable', className: 'dshMacToolsMonitorMuted' }, t('monitor.alerts.unavailable')),
        ])
      }

      const switchButton = (field, labelKey, checked) => h('button', {
        key: field,
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        className: checked
          ? 'dshMacToolsMonitorSwitch dshMacToolsMonitorSwitchOn'
          : 'dshMacToolsMonitorSwitch',
        onClick: () => updateField(field, !checked),
      }, [
        h('span', { key: 'dot', className: 'dshMacToolsMonitorSwitchDot', 'aria-hidden': true }),
        h('span', { key: 'label' }, t(labelKey)),
      ])
      const numericField = (field, labelKey, disabled) => h('label', {
        key: field,
        className: 'dshMacToolsMonitorField',
      }, [
        h('span', { key: 'label', className: 'dshMacToolsMonitorFieldLabel' }, t(labelKey)),
        h('input', {
          key: 'input',
          type: 'number',
          inputMode: 'numeric',
          className: 'dshMacToolsMonitorFieldInput',
          value: form[field],
          'aria-label': t(labelKey),
          disabled: disabled === true,
          onChange: (event) => updateField(field, event.target.value),
        }),
      ])

      const eventNodes = events.map((event, index) => {
        const record = event !== null && typeof event === 'object' ? event : {}
        const metric = typeof record.metric === 'string' ? record.metric : ''
        const temperature = metric === 'temperature'
        const valueText = temperature ? monitorCelsiusText(record.value) : `${formatPercent(Number.isFinite(record.value) ? record.value : 0)}%`
        const thresholdText = temperature ? monitorCelsiusText(record.threshold) : `${formatPercent(Number.isFinite(record.threshold) ? record.threshold : 0)}%`
        return h('li', {
          key: typeof record.id === 'string' ? record.id : `event-${index}`,
          className: 'dshMacToolsMonitorEventRow',
        }, [
          h('span', { key: 'metric', className: 'dshMacToolsMonitorEventMetric' }, monitorAlertMetricLabel(t, metric)),
          h('span', { key: 'detail', className: 'dshMacToolsMonitorEventDetail' }, t('monitor.alerts.eventRow', {
            value: valueText,
            threshold: thresholdText,
          })),
          h('span', { key: 'time', className: 'dshMacToolsMonitorEventTime' }, formatDateTime(record.at)),
        ])
      })

      const noticeNode = notice === null
        ? null
        : h('span', {
          key: 'notice',
          className: notice.kind === 'error' ? 'dshMacToolsMonitorAlertError' : 'dshMacToolsMonitorAlertNotice',
          role: notice.kind === 'error' ? 'alert' : undefined,
        }, notice.text)

      const body = h('div', { key: 'body', className: 'dshMacToolsMonitorAlerts' }, [
        h('div', { key: 'switches', className: 'dshMacToolsMonitorSwitchRow' }, [
          switchButton('enabled', 'monitor.alerts.enabled', form.enabled === true),
          switchButton('notify', 'monitor.alerts.notify', form.notify === true),
        ]),
        h('div', { key: 'grid', className: 'dshMacToolsMonitorAlertGrid' }, [
          numericField('cpuPercent', 'monitor.alerts.cpu'),
          numericField('temperatureCelsius', 'monitor.alerts.temperature', temperatureDisabled),
          numericField('memoryPercent', 'monitor.alerts.memory'),
          numericField('cooldownSeconds', 'monitor.alerts.cooldown'),
        ]),
        temperatureDisabled === true
          ? h('p', { key: 'temperature-disabled', className: 'dshMacToolsMonitorAlertNotice' }, t('monitor.alerts.temperatureUnavailable'))
          : null,
        h('p', { key: 'cooldown-hint', className: 'dshMacToolsMonitorAlertNotice' }, t('monitor.alerts.cooldownHint')),
        invalid === true
          ? h('p', { key: 'invalid', className: 'dshMacToolsMonitorAlertError', role: 'alert' }, t('monitor.alerts.error.invalid'))
          : null,
        h('div', { key: 'actions', className: 'dshMacToolsMonitorAlertActions' }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonPrimary',
            disabled: alertsState.saving === true || invalid === true,
            onClick: save,
          }, alertsState.saving === true ? t('monitor.alerts.saving') : t('monitor.alerts.save')),
          h('button', {
            key: 'test',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
            disabled: alertsState.testing === true,
            onClick: test,
          }, alertsState.testing === true ? t('monitor.alerts.testing') : t('monitor.alerts.test')),
          noticeNode,
        ]),
        h('div', { key: 'events' }, [
          h('p', { key: 'title', className: 'dshMacToolsMonitorAlertNotice' }, t('monitor.alerts.events')),
          eventNodes.length === 0
            ? h('p', { key: 'empty', className: 'dshMacToolsMonitorAlertNotice' }, t('monitor.alerts.eventsEmpty'))
            : h('ul', { key: 'list', className: 'dshMacToolsMonitorEventList' }, eventNodes),
        ]),
      ])

      return h('section', {
        className: 'dshMacToolsMonitorSection',
        'aria-label': t('monitor.alerts.title'),
      }, [head, body])
    }

    /**
     * 运行状态 / Status tab — a State-inspired live dashboard. It polls the
     * Host snapshot only while visible (deduped, aborted on tab switch or
     * unmount), polls the process ranking only while that section is expanded,
     * and freezes everything while paused.
     *
     * @param {object} props - store, snapshot, translator and visibility.
     * @returns {object} the element.
     */
    function MonitorTab({ store, snapshot, t, active }) {
      const monitor = snapshot.monitor
      const value = monitor.value
      const processes = monitor.processes
      const intervalMs = MONITOR_INTERVALS.indexOf(monitor.intervalMs) >= 0 ? monitor.intervalMs : MONITOR_POLL_MS
      const paused = monitor.paused === true
      const capabilities = value !== null && typeof value === 'object'
        && value.capabilities !== null && typeof value.capabilities === 'object'
        ? value.capabilities
        : null
      const platform = capabilities !== null && typeof capabilities.platform === 'string'
        ? capabilities.platform
        : 'darwin'
      const unsupported = value !== null && platform !== 'darwin'

      React.useEffect(() => {
        if (active !== true || paused === true || unsupported === true) return undefined
        // The signal belongs to the poll currently in flight, so switching the
        // tab (or unmounting the panel) aborts the request itself, not just the
        // timer. Store-level dedupe keeps at most one request in flight.
        let controller = null
        let inFlight = false
        const start = () => {
          if (inFlight === true) return
          inFlight = true
          controller = typeof AbortController === 'function' ? new AbortController() : null
          const signal = controller === null ? undefined : controller.signal
          const settle = () => {
            inFlight = false
            controller = null
          }
          store.loadMonitor({ signal }).then(settle, settle)
        }
        start()
        const timer = setInterval(start, intervalMs)
        return () => {
          clearInterval(timer)
          if (controller !== null) controller.abort()
        }
      }, [active, paused, unsupported, intervalMs, store])

      React.useEffect(() => {
        if (active !== true || paused === true || unsupported === true) return undefined
        if (processes.open !== true) return undefined
        let controller = null
        let inFlight = false
        const start = () => {
          if (inFlight === true) return
          inFlight = true
          controller = typeof AbortController === 'function' ? new AbortController() : null
          const signal = controller === null ? undefined : controller.signal
          const settle = () => {
            inFlight = false
            controller = null
          }
          store.loadMonitorProcesses({ signal }).then(settle, settle)
        }
        start()
        const timer = setInterval(start, MONITOR_PROCESS_POLL_MS)
        return () => {
          clearInterval(timer)
          if (controller !== null) controller.abort()
        }
      }, [active, paused, unsupported, processes.open, store])

      // --- toolbar -------------------------------------------------------
      const sampledAt = value !== null && typeof value === 'object' && typeof value.sampledAt === 'string' && value.sampledAt !== ''
        ? value.sampledAt
        : null
      const intervalButtons = MONITOR_INTERVALS.map((option) => h('button', {
        key: option,
        type: 'button',
        className: intervalMs === option
          ? 'dshMacToolsMonitorInterval dshMacToolsMonitorIntervalActive'
          : 'dshMacToolsMonitorInterval',
        'aria-pressed': intervalMs === option,
        onClick: () => store.setMonitorInterval(option),
      }, t('monitor.interval.option', { n: option / 1000 })))
      const badges = []
      if (capabilities !== null) {
        const sensorsInfo = capabilities.sensors !== null && typeof capabilities.sensors === 'object' ? capabilities.sensors : null
        const sensorsOk = sensorsInfo === null || sensorsInfo.supported !== false
        badges.push(h('span', {
          key: 'sensors',
          className: sensorsOk
            ? 'dshMacToolsMonitorBadge dshMacToolsMonitorBadgeOk'
            : 'dshMacToolsMonitorBadge dshMacToolsMonitorBadgeWarn',
          title: sensorsOk
            ? t('monitor.available')
            : (sensorsInfo !== null && sensorsInfo.reason !== null && sensorsInfo.reason !== undefined
              ? monitorSensorReasonText(t, sensorsInfo.reason)
              : t('monitor.unavailable')),
        }, t('monitor.badge.sensors')))
        const fansInfo = capabilities.fanControl !== null && typeof capabilities.fanControl === 'object' ? capabilities.fanControl : null
        const fansOk = fansInfo === null || fansInfo.supported !== false
        badges.push(h('span', {
          key: 'fans',
          className: fansOk
            ? 'dshMacToolsMonitorBadge dshMacToolsMonitorBadgeOk'
            : 'dshMacToolsMonitorBadge dshMacToolsMonitorBadgeWarn',
          title: fansOk
            ? t('monitor.available')
            : (fansInfo !== null && fansInfo.reason !== null && fansInfo.reason !== undefined
              ? monitorFanReasonText(t, fansInfo.reason, null)
              : t('monitor.unavailable')),
        }, t('monitor.badge.fans')))
        if (capabilities.battery === true) {
          badges.push(h('span', {
            key: 'battery',
            className: 'dshMacToolsMonitorBadge dshMacToolsMonitorBadgeOk',
            title: t('monitor.available'),
          }, t('monitor.badge.battery')))
        }
      }
      const toolbar = h('div', {
        key: 'toolbar',
        className: 'dshMacToolsMonitorToolbar',
        role: 'toolbar',
        'aria-label': t('monitor.toolbarAria'),
      }, [
        h('p', { key: 'sampled', className: 'dshMacToolsMonitorSampledAt' }, sampledAt === null
          ? t('monitor.loading')
          : t('monitor.sampledAt', { time: formatDateTime(sampledAt) })),
        paused ? h('span', { key: 'paused', className: 'dshMacToolsMonitorBadge dshMacToolsMonitorBadgePaused' }, t('monitor.paused')) : null,
        badges.length === 0 ? null : h('div', {
          key: 'badges',
          className: 'dshMacToolsMonitorBadges',
          'aria-label': t('monitor.badgesAria'),
        }, badges),
        h('div', {
          key: 'intervals',
          className: 'dshMacToolsMonitorIntervals',
          role: 'group',
          'aria-label': t('monitor.intervalAria'),
        }, intervalButtons),
        h('button', {
          key: 'pause',
          type: 'button',
          role: 'switch',
          'aria-checked': paused,
          className: paused
            ? 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline dshMacToolsToggleOn'
            : 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          onClick: () => store.setMonitorPaused(!paused),
        }, paused ? t('monitor.resume') : t('monitor.pause')),
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
          onClick: () => { void store.refreshMonitor() },
        }, [glyph('refresh', 13, 'icon'), h('span', { key: 'label' }, t('monitor.refresh'))]),
      ])

      if (unsupported === true) {
        return h('div', { className: 'dshMacToolsMonitor' }, [
          toolbar,
          h('section', { key: 'unsupported', className: 'dshMacToolsMonitorSection' }, [
            h('h2', { key: 'title', className: 'dshMacToolsMonitorSectionTitle' }, t('monitor.unsupported.title')),
            h('p', { key: 'hint', className: 'dshMacToolsMonitorInstallMeta' }, t('monitor.unsupported.hint', { platform })),
          ]),
        ])
      }

      if (value === null) {
        const failure = monitor.error
        return h('div', { className: 'dshMacToolsMonitor' }, [
          toolbar,
          failure === null || failure === undefined
            ? h('div', { key: 'skeleton', className: 'dshMacToolsLoading', 'aria-busy': 'true' }, [
              h('span', { key: 'sr', className: 'dshMacToolsSrOnly' }, t('monitor.loading')),
              h('div', { key: 'one', className: 'dshMacToolsSkeleton dshMacToolsMonitorSkeleton' }),
            ])
            : h('div', { key: 'error', className: 'dshMacToolsNotice dshMacToolsNoticeError', role: 'alert' }, [
              h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
              h('p', { key: 'text' }, monitorErrorText(t, failure)),
              h('button', {
                key: 'retry',
                type: 'button',
                className: 'dshMacToolsButton dshMacToolsButtonCompact',
                onClick: () => { void store.refreshMonitor() },
              }, t('common.retry')),
            ]),
        ])
      }

      // --- overview cards -------------------------------------------------
      const sample = value.sample !== null && typeof value.sample === 'object' ? value.sample : {}
      const host = sample.host !== null && typeof sample.host === 'object' ? sample.host : {}
      const cpu = sample.cpu !== null && typeof sample.cpu === 'object' ? sample.cpu : {}
      const memory = sample.memory !== null && typeof sample.memory === 'object' ? sample.memory : {}
      const disk = sample.disk !== null && typeof sample.disk === 'object' ? sample.disk : {}
      const network = sample.network !== null && typeof sample.network === 'object' ? sample.network : {}
      const history = value.history !== null && typeof value.history === 'object' ? value.history : {}
      const battery = sample.battery !== null && typeof sample.battery === 'object' ? sample.battery : null

      const legendItem = (label, percent, color) => h('li', {
        key: label,
        className: 'dshMacToolsMonitorLegendItem',
      }, [
        h(MonitorLegendDot, { key: 'dot', color }),
        h('span', { key: 'text' }, `${label} ${formatPercent(Number.isFinite(percent) ? percent : 0)}%`),
      ])

      const cpuChip = typeof host.cpuModel === 'string' && host.cpuModel !== '' ? host.cpuModel : t('monitor.unknown')
      const temperature = Number.isFinite(cpu.temperatureCelsius) ? cpu.temperatureCelsius : null
      const loadAverage = Array.isArray(cpu.loadAverage)
        ? cpu.loadAverage.filter((entry) => Number.isFinite(entry)).map((entry) => entry.toFixed(1)).join(' / ')
        : ''
      const coreSummary = [
        Number.isFinite(host.cpuCores) ? t('monitor.cpu.cores', { count: host.cpuCores }) : null,
        loadAverage === '' ? null : t('monitor.cpu.loadAverage', { load: loadAverage }),
      ].filter((entry) => entry !== null).join(' · ')
      const cpuCard = h(MonitorCard, { key: 'cpu', title: t('monitor.cpu.title'), meta: cpuChip }, [
        h('div', { key: 'temp', className: 'dshMacToolsMonitorBig' }, [
          h('p', { key: 'value', className: 'dshMacToolsMonitorBigValue' }, monitorCelsiusText(temperature)),
          h('span', { key: 'unit', className: 'dshMacToolsMonitorBigUnit' }, t('monitor.cpu.temperature')),
        ]),
        temperature === null
          ? h('p', { key: 'no-temp', className: 'dshMacToolsMonitorMuted' }, t('monitor.cpu.noTemperature'))
          : h(MonitorSparkline, {
            key: 'temp-spark',
            series: [{ points: history.cpuTemperature, color: MONITOR_SERIES_COLORS.cpuTemperature, area: false }],
            ariaLabel: t('monitor.cpu.temperature'),
          }),
        h(MonitorSparkline, {
          key: 'spark',
          series: [{ points: history.cpu, color: MONITOR_SERIES_COLORS.cpu, area: true }],
          fixedMin: 0,
          fixedMax: 100,
          ariaLabel: t('monitor.cpu.title'),
        }),
        h('ul', { key: 'legend', className: 'dshMacToolsMonitorLegend' }, [
          legendItem(t('monitor.cpu.user'), cpu.userPercent, MONITOR_SERIES_COLORS.cpuUser),
          legendItem(t('monitor.cpu.system'), cpu.systemPercent, MONITOR_SERIES_COLORS.cpuSystem),
          legendItem(t('monitor.cpu.idle'), cpu.idlePercent, MONITOR_SERIES_COLORS.cpuIdle),
        ]),
        coreSummary === '' ? null : h('p', { key: 'cores-meta', className: 'dshMacToolsMonitorMuted' }, coreSummary),
        h(MonitorCores, { key: 'cores', t, cores: cpu.perCorePercent }),
      ])

      const memorySegments = monitorMemorySegments(memory)
      const pressure = monitorPressureInfo(t, typeof memory.pressure === 'string' ? memory.pressure : null)
      const memoryPercent = Number.isFinite(memory.usedPercent) ? memory.usedPercent : null
      const memoryCard = h(MonitorCard, {
        key: 'memory',
        title: t('monitor.memory.title'),
        meta: h('span', {
          className: pressure.className,
          title: t('monitor.memory.pressure'),
        }, pressure.label),
      }, [
        h('p', { key: 'available', className: 'dshMacToolsMonitorRowLine' }, t('monitor.memory.available', {
          available: monitorSizeText(memory.availableBytes),
          total: monitorSizeText(memory.totalBytes),
        })),
        memoryPercent === null
          ? null
          : h('p', { key: 'used', className: 'dshMacToolsMonitorMuted' }, t('monitor.memory.usedPercent', {
            percent: formatPercent(memoryPercent),
          })),
        memorySegments.length === 0
          ? null
          : h('div', {
            key: 'stack',
            className: 'dshMacToolsMonitorStack',
            role: 'img',
            'aria-label': t('monitor.memory.breakdown'),
          }, memorySegments.map((segment) => h('span', {
            key: segment.key,
            className: 'dshMacToolsMonitorStackPart',
            style: {
              width: `${clampNumber(segment.percent, 0, 100)}%`,
              background: segment.color,
            },
          }))),
        memorySegments.length === 0
          ? null
          : h('ul', { key: 'legend', className: 'dshMacToolsMonitorLegend' }, memorySegments
            .filter((segment) => segment.labelKey !== null)
            .map((segment) => h('li', {
              key: `legend-${segment.key}`,
              className: 'dshMacToolsMonitorLegendItem',
            }, [
              h(MonitorLegendDot, { key: 'dot', color: segment.color }),
              h('span', { key: 'text' }, `${t(segment.labelKey)} ${monitorSizeText(segment.bytes)}`),
            ]))),
        Number.isFinite(memory.swapUsedBytes) && memory.swapUsedBytes > 0
          ? h('p', { key: 'swap', className: 'dshMacToolsMonitorMuted' }, t('monitor.memory.swap', {
            size: monitorSizeText(memory.swapUsedBytes),
          }))
          : null,
      ])

      const diskPercent = Number.isFinite(disk.usedPercent)
        ? disk.usedPercent
        : (Number.isFinite(disk.totalBytes) && disk.totalBytes > 0 && Number.isFinite(disk.usedBytes)
          ? (disk.usedBytes / disk.totalBytes) * 100
          : null)
      const diskCard = h(MonitorCard, {
        key: 'disk',
        title: t('monitor.disk.title'),
        meta: typeof disk.name === 'string' && disk.name !== '' ? disk.name : null,
      }, [
        h('p', { key: 'available', className: 'dshMacToolsMonitorRowLine' }, t('monitor.disk.available', {
          available: monitorSizeText(disk.freeBytes),
          total: monitorSizeText(disk.totalBytes),
        })),
        h(MeterBar, {
          key: 'bar',
          percent: diskPercent === null ? 0 : diskPercent,
          tone: 'disk',
          label: t('monitor.disk.usedPercent', { percent: formatPercent(diskPercent === null ? 0 : diskPercent) }),
        }),
        diskPercent === null && (typeof disk.mount !== 'string' || disk.mount === '')
          ? null
          : h('p', { key: 'meta', className: 'dshMacToolsMonitorMuted' }, [
            diskPercent === null ? null : t('monitor.disk.usedPercent', { percent: formatPercent(diskPercent) }),
            diskPercent !== null && typeof disk.mount === 'string' && disk.mount !== '' ? ' · ' : null,
            typeof disk.mount === 'string' && disk.mount !== ''
              ? t('monitor.disk.mount', { mount: disk.mount })
              : null,
          ]),
      ])

      const networkCard = h(MonitorCard, {
        key: 'network',
        title: t('monitor.network.title'),
        meta: typeof network.interface === 'string' && network.interface !== ''
          ? t('monitor.network.interface', { name: network.interface })
          : null,
      }, [
        h('p', { key: 'ip', className: 'dshMacToolsMonitorRowLine' }, [
          h('span', { key: 'label' }, t('monitor.network.ip')),
          h('span', {
            key: 'value',
          }, typeof network.localIp === 'string' && network.localIp !== '' ? network.localIp : t('monitor.network.none')),
        ]),
        h(MonitorSparkline, {
          key: 'spark',
          series: [
            { points: history.networkDown, color: MONITOR_SERIES_COLORS.networkDown, area: true },
            { points: history.networkUp, color: MONITOR_SERIES_COLORS.networkUp, area: false },
          ],
          fixedMin: 0,
          tall: true,
          ariaLabel: t('monitor.network.title'),
        }),
        h('ul', { key: 'legend', className: 'dshMacToolsMonitorLegend' }, [
          h('li', { key: 'down', className: 'dshMacToolsMonitorLegendItem' }, [
            h(MonitorLegendDot, { key: 'dot', color: MONITOR_SERIES_COLORS.networkDown }),
            h('span', {
              key: 'text',
            }, `${t('monitor.network.down')} ${monitorRateText(network.receivedBytesPerSecond)}`),
          ]),
          h('li', { key: 'up', className: 'dshMacToolsMonitorLegendItem' }, [
            h(MonitorLegendDot, { key: 'dot', color: MONITOR_SERIES_COLORS.networkUp }),
            h('span', {
              key: 'text',
            }, `${t('monitor.network.up')} ${monitorRateText(network.sentBytesPerSecond)}`),
          ]),
        ]),
        Number.isFinite(network.receivedTotalBytes) || Number.isFinite(network.sentTotalBytes)
          ? h('p', { key: 'total', className: 'dshMacToolsMonitorMuted' }, t('monitor.network.total', {
            down: monitorSizeText(network.receivedTotalBytes),
            up: monitorSizeText(network.sentTotalBytes),
          }))
          : null,
      ])

      let batteryCard = null
      if (battery !== null) {
        const batteryPercent = Number.isFinite(battery.percent) ? battery.percent : null
        const charging = battery.charging === true
        const remainingMinutes = Number.isFinite(battery.timeRemainingMinutes) ? battery.timeRemainingMinutes : null
        const health = Number.isFinite(battery.healthPercent) ? battery.healthPercent : null
        const cycles = Number.isFinite(battery.cycleCount) ? battery.cycleCount : null
        let statusText = null
        if (charging === true) {
          if (batteryPercent !== null && batteryPercent >= 100) statusText = t('monitor.battery.charged')
        } else if (remainingMinutes !== null) {
          statusText = t('monitor.battery.remaining', { duration: durationText(t, remainingMinutes * 60) })
        } else {
          statusText = t('monitor.battery.remainingUnknown')
        }
        batteryCard = h(MonitorCard, {
          key: 'battery',
          title: t('monitor.battery.title'),
          meta: charging === true ? t('monitor.battery.charging') : t('monitor.battery.discharging'),
        }, [
          batteryPercent === null
            ? null
            : h('div', { key: 'level', className: 'dshMacToolsMonitorBig' }, [
              h('p', { key: 'value', className: 'dshMacToolsMonitorBigValue' }, `${formatPercent(batteryPercent)}%`),
            ]),
          h(MeterBar, {
            key: 'bar',
            percent: batteryPercent === null ? 0 : batteryPercent,
            tone: 'battery',
            label: t('monitor.battery.level', { percent: formatPercent(batteryPercent === null ? 0 : batteryPercent) }),
          }),
          statusText === null
            ? null
            : h('p', { key: 'status', className: 'dshMacToolsMonitorRowLine' }, statusText),
          health === null ? null : h('p', { key: 'health', className: 'dshMacToolsMonitorMuted' }, t('monitor.battery.health', {
            percent: formatPercent(health),
          })),
          cycles === null ? null : h('p', { key: 'cycles', className: 'dshMacToolsMonitorMuted' }, t('monitor.battery.cycles', { count: cycles })),
        ])
      }

      const footer = h('div', { key: 'footer', className: 'dshMacToolsMonitorFooter' }, [
        h('span', { key: 'uptime' }, t('monitor.footer.uptime', {
          duration: durationText(t, Number.isFinite(host.uptimeSeconds) ? host.uptimeSeconds : 0),
        })),
        h('span', { key: 'host' }, t('monitor.footer.host', {
          model: typeof host.modelName === 'string' && host.modelName !== ''
            ? host.modelName
            : (typeof host.cpuModel === 'string' && host.cpuModel !== '' ? host.cpuModel : t('monitor.unknown')),
          hostname: typeof host.hostname === 'string' && host.hostname !== '' ? host.hostname : t('monitor.unknown'),
        })),
        typeof host.osName === 'string' && host.osName !== ''
          ? h('span', { key: 'os' }, t('monitor.footer.os', {
            os: host.osName,
            version: typeof host.osVersion === 'string' ? host.osVersion : '',
          }))
          : null,
      ])

      const overview = h('div', { key: 'overview', className: 'dshMacToolsMonitorOverview' }, [
        cpuCard,
        memoryCard,
        diskCard,
        networkCard,
        batteryCard,
        footer,
      ])

      const staleError = monitor.error === null || monitor.error === undefined
        ? null
        : h('div', { key: 'stale', className: 'dshMacToolsNotice', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, monitorErrorText(t, monitor.error)),
          h('button', {
            key: 'retry',
            type: 'button',
            className: 'dshMacToolsButton dshMacToolsButtonCompact',
            onClick: () => { void store.refreshMonitor() },
          }, t('common.retry')),
        ])

      return h('div', { className: 'dshMacToolsMonitor' }, [
        toolbar,
        staleError,
        overview,
        h(MonitorSensorsSection, { key: 'sensors', t, sensors: sample.sensors }),
        h(MonitorSystemSection, { key: 'system', snapshot, t }),
        h(MonitorFanSection, { key: 'fan', store, snapshot, t }),
        h(MonitorProcessSection, { key: 'processes', store, snapshot, t }),
        h(MonitorAlertsSection, { key: 'alerts', store, snapshot, t }),
      ])
    }

    // ---------------------------------------------------------------------
    // Host status pill, panel shell, rail icon
    // ---------------------------------------------------------------------

    /**
     * The Host connection pill in the heading. It is the only always-visible
     * signal that the browser is talking to the Host half, so it carries the
     * transport failure in its title text and offers a single reconnect action.
     *
     * @param {object} props - pill props.
     * @returns {object} the element.
     */
    function HostStatusPill({ host, t, onRetry }) {
      const ready = host.kind === 'ready' && host.value !== null
      let className = 'dshMacToolsStatusPill'
      let text
      let title
      if (host.kind === 'loading') {
        className += ' dshMacToolsStatusLoading'
        text = t('host.loading')
        title = t('host.loading')
      } else if (ready) {
        className += ' dshMacToolsStatusReady'
        text = t('host.ready', { version: typeof host.value.version === 'string' ? host.value.version : '?' })
        title = t('host.readyHint', {
          directory: typeof host.value.saveDirectory === 'string' && host.value.saveDirectory !== ''
            ? host.value.saveDirectory
            : t('system.unknown'),
        })
      } else if (host.kind === 'missing') {
        className += ' dshMacToolsStatusMissing'
        text = t('host.missing', { status: host.http || 404 })
        title = t('host.missingHint')
      } else {
        className += ' dshMacToolsStatusError'
        text = t('host.unreachable', { message: host.message })
        title = host.message
      }
      return h('div', {
        className,
        role: 'status',
        'aria-live': 'polite',
        'aria-label': t('hostAria'),
        title,
      }, [
        h('span', { key: 'dot', className: 'dshMacToolsStatusDot', 'aria-hidden': true }),
        h('span', { key: 'text', className: 'dshMacToolsStatusText' }, text),
        ready || host.kind === 'loading'
          ? null
          : h('button', {
            key: 'retry',
            type: 'button',
            className: 'dshMacToolsStatusRetry',
            title: t('host.retry'),
            'aria-label': t('host.retry'),
            onClick: onRetry,
          }, glyph('refresh', 12)),
      ])
    }

    /**
     * The panel page, rendered by the `main` slot while this panel is active.
     *
     * All four tabs stay mounted and inactive ones are hidden with the
     * `hidden` attribute, so an in-progress annotation set, the calculator's
     * expression and history, the live status snapshot and the transfer session
     * all survive a tab switch. Only the visible tab polls: the live status
     * every 1 / 2 / 5 s and the phone-transfer session/lists every 2 s / 4 s.
     * The old System tab's still-unique facts are rendered inside the status
     * tab's 系统信息 section instead of being polled separately.
     *
     * @param {object} props - slot props: the injected store plus the translator.
     * @returns {object} the page element.
     */
    function MacToolsPanel({ store, t }) {
      const snapshot = useStoreSnapshot(store)
      const activeTab = snapshot.tab
      const tabRefs = React.useRef({})

      React.useEffect(() => {
        void store.loadHost()
      }, [store])

      const onTabsKeyDown = (event) => {
        const index = TABS.indexOf(activeTab)
        let next = -1
        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = TABS.length - 1
        if (next < 0) return
        event.preventDefault()
        const id = TABS[next]
        store.selectTab(id)
        const node = tabRefs.current[id]
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }

      const tabButtons = TABS.map((id) => h('button', {
        key: id,
        ref: (node) => {
          tabRefs.current[id] = node
        },
        type: 'button',
        role: 'tab',
        id: `${NS}-tab-${id}`,
        'aria-selected': activeTab === id,
        'aria-controls': `${NS}-panel-${id}`,
        tabIndex: activeTab === id ? 0 : -1,
        className: activeTab === id ? 'dshMacToolsTab dshMacToolsTabActive' : 'dshMacToolsTab',
        onClick: () => store.selectTab(id),
      }, t(`tab.${id}`)))

      const heading = h('header', { key: 'heading', className: 'dshMacToolsHeading' }, [
        h('div', { key: 'main', className: 'dshMacToolsHeadingMain' }, [
          h('span', { key: 'mark', className: 'dshMacToolsBrandMark', 'aria-hidden': true }, h(MacToolsIcon, { size: 22 })),
          h('div', { key: 'text', className: 'dshMacToolsHeadingText' }, [
            h('h1', { key: 'title' }, t('title')),
            h('p', { key: 'subtitle', className: 'dshMacToolsSubtitle' }, t('subtitle')),
          ]),
        ]),
        h('div', { key: 'right', className: 'dshMacToolsHeadingRight' }, h(HostStatusPill, {
          host: snapshot.host,
          t,
          onRetry: () => { void store.loadHost() },
        })),
      ])

      const tablist = h('div', {
        key: 'tabs',
        className: 'dshMacToolsTabs',
        role: 'tablist',
        'aria-label': t('tabs.aria'),
        onKeyDown: onTabsKeyDown,
      }, tabButtons)

      const panels = TABS.map((id) => {
        const active = activeTab === id
        let content
        if (id === 'screenshot') content = h(ScreenshotTab, { store, snapshot, t, active })
        else if (id === 'calculator') content = h(CalculatorTab, { store, snapshot, t })
        else if (id === 'monitor') content = h(MonitorTab, { store, snapshot, t, active })
        else content = h(TransferTab, { store, snapshot, t, active })
        return h('section', {
          key: id,
          id: `${NS}-panel-${id}`,
          role: 'tabpanel',
          'aria-labelledby': `${NS}-tab-${id}`,
          hidden: !active,
          className: 'dshMacToolsTabPanel',
        }, content)
      })

      return h('section', {
        className: 'dshMacToolsPage',
        'aria-label': t('title'),
        'data-testid': 'mac-tools-page',
      }, h('div', { key: 'scroll', className: 'dshMacToolsScroll' }, h('div', {
        key: 'content',
        className: 'dshMacToolsContent',
      }, [heading, tablist, h('div', { key: 'panels' }, panels)])))
    }

    /**
     * The rail glyph. The sidebar sizes and colors it through the row's own
     * state, so it draws in `currentColor` only. It is also the panel's brand
     * mark in the heading.
     *
     * @param {object} props - slot props, including `size`.
     * @returns {object} the icon element.
     */
    function MacToolsIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        className: 'dshMacToolsIcon',
        width: edge,
        height: edge,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, [
        h('path', { key: 'frame', d: 'M2.5 5.5 H12.5 V14.5 H2.5 Z' }),
        h('circle', { key: 'lens', cx: 7.5, cy: 10, r: 2.3 }),
        h('path', { key: 'top', d: 'M4.8 5.5 L5.8 3.8 H9.2 L10.2 5.5' }),
        h('path', { key: 'calc', d: 'M14.2 8.5 H17.5 V16.5 H14.2 Z' }),
        h('path', { key: 'dot1', d: 'M15 11.2 H15.02 M16.7 11.2 H16.72 M15 13.6 H15.02 M16.7 13.6 H16.72' }),
      ])
    }

    // ---------------------------------------------------------------------
    // Shortcuts and registration
    // ---------------------------------------------------------------------

    /**
     * The shortcut defaults.
     *
     * `primary+alt+KeyM` and `primary+shift+KeyA` are free on every combination
     * the shell can run: shipped commands claim B, O, P, T, Slash and Comma, and
     * the registry refuses a conflicting default rather than silently stealing
     * a key. `web:linux` is deliberately absent — a browser on Linux accepts
     * only three bindings (`primary+Slash`, `primary+shift+Comma`,
     * `primary+shift+Period`), and declaring a rejected one would make the whole
     * registration throw and leave the command with no default at all; there
     * the user binds it from the shortcuts page instead.
     *
     * @param {string} code - the KeyboardEvent.code.
     * @param {string[]} modifiers - modifier names.
     * @returns {Record<string, object>} the `defaults` map.
     */
    function shortcutDefaults(code, modifiers) {
      const defaults = {}
      const runtimes = ['desktop', 'web']
      const platforms = ['macos', 'windows', 'linux']
      for (let runtimeIndex = 0; runtimeIndex < runtimes.length; runtimeIndex += 1) {
        for (let platformIndex = 0; platformIndex < platforms.length; platformIndex += 1) {
          const runtime = runtimes[runtimeIndex]
          const platform = platforms[platformIndex]
          if (runtime === 'web' && platform === 'linux') continue
          defaults[`${runtime}:${platform}`] = { code, modifiers: modifiers.slice() }
        }
      }
      return defaults
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the panel, the rail entry and the two global shortcuts.
       *
       * @param {any} ctx - the Client root context.
       * @returns {void}
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
        ctx.effect(() => installStyles(), `${NS}: styles`)
        const t = ctx.locale.bind(NS)
        const host = createHostClient()
        const store = createMacToolsStore(host)

        // A pinned window can ask for its image to be edited in the panel. That
        // request has no page event behind it, so poll for it while the page is
        // visible and bring the panel forward when one lands.
        ctx.inject(['layout'], (scope) => {
          try {
            scope.effect(() => {
              // No polling outside a real page (unit tests provide a stub
              // document without a visibility state).
              if (typeof document === 'undefined' || typeof document.visibilityState !== 'string') return () => {}
              const timer = setInterval(() => {
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
                void store.pollPendingEditor().then((adopted) => {
                  if (adopted === true) scope.layout.selectPanel(PANEL_ID)
                })
              }, 1500)
              return () => clearInterval(timer)
            }, `${NS}: pinned edit requests`)
          } catch (error) {
            console.warn(`[${NS}] could not start the pinned-edit poller:`, error)
          }
        })

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ store }),
        }, MacToolsPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 14,
          locale: NS,
          label: () => t('panel'),
        }, MacToolsIcon))

        // The rail entry is the mouse path; these are the keyboard ones. Both
        // services are optional, so a shell without them keeps the panel and
        // only loses the keys.
        ctx.inject(['shortcuts', 'layout'], (scope) => {
          try {
            scope.effect(() => scope.shortcuts.register({
              id: SHORTCUT_TOGGLE,
              label: () => t('shortcut.toggle'),
              aliases: ['mac tools', 'toolbox', 'screenshots', 'calculator', 'system information', 'status monitor'],
              defaults: shortcutDefaults('KeyM', ['primary', 'alt']),
              regions: ['page'],
              modals: [],
              resolve: () => ({
                status: 'handled',
                run: () => {
                  const activePanelId = scope.layout?.panelInfo?.getSnapshot?.()?.activePanelId
                  scope.layout.selectPanel(activePanelId === PANEL_ID ? null : PANEL_ID)
                },
              }),
            }), `${NS}: shortcut toggle`)
          } catch (error) {
            console.warn(`[${NS}] could not register the toggle shortcut:`, error)
          }

          try {
            scope.effect(() => scope.shortcuts.register({
              id: SHORTCUT_SHOT,
              label: () => t('shortcut.screenshot'),
              aliases: ['screenshot', 'capture', 'snip', 'quick screenshot'],
              defaults: shortcutDefaults('KeyA', ['primary', 'shift']),
              regions: ['page', 'editable'],
              modals: [],
              resolve: () => ({
                status: 'handled',
                run: () => {
                  // The store is the bridge: the panel may not be mounted yet,
                  // but it adopts the shot when it appears.
                  store.selectTab('screenshot')
                  scope.layout.selectPanel(PANEL_ID)
                  void store.capture({ mode: 'interactive' })
                },
              }),
            }), `${NS}: shortcut screenshot`)
          } catch (error) {
            console.warn(`[${NS}] could not register the screenshot shortcut:`, error)
          }
        })
      },
    }
  },
})
