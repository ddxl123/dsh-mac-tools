/**
 * dsh-mac-tools — browser half.
 *
 * ## What it registers
 *
 *   - `sidebar.panellist` — the toolbox entry in the left rail (`id: 'mac-tools'`),
 *     which the shell opens through `layout.selectPanel(id)`.
 *   - `main` keyed by the same id — the panel page itself: a QQ-style screenshot
 *     tab (native capture, window picker, crop and annotation editor), a
 *     calculator driven by the Host's own evaluator, and a system-information
 *     dashboard.
 *   - two global shortcuts: `primary+alt+KeyM` toggles the panel, and
 *     `primary+shift+KeyA` starts an interactive capture and brings the panel
 *     forward with the editor already mounted.
 *
 * ## Where state lives
 *
 * The Host half owns every durable thing: the temporary shot registry, the
 * calculator engine, the clipboard, system facts and the `/api/dsh-mac-tools`
 * route. This half owns only view state — this plugin is panel-only and
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
    const TABS = ['screenshot', 'calculator', 'system']
    /** How many successful evaluations the calculator remembers. */
    const CALC_HISTORY_LIMIT = 10
    /** How often the system tab refreshes while it is the visible tab. */
    const SYSTEM_POLL_MS = 10000

    const zh = {
      'panel': 'Mac 工具箱',
      'title': 'Mac 工具箱',
      'subtitle': '截图与标注、计算器、系统信息 —— 全部在本机完成。',
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
      'tab.system': '系统信息',
      'common.close': '关闭',
      'common.retry': '重试',
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
      'system.refresh': '刷新',
      'system.refreshing': '正在刷新…',
      'system.loading': '正在读取系统信息…',
      'system.error': '无法读取系统信息：{message}',
      'system.os': '系统',
      'system.cpu': 'CPU',
      'system.memory': '内存',
      'system.disk': '磁盘',
      'system.battery': '电池',
      'system.uptime': '运行时间',
      'system.host': 'Host',
      'system.hostname': '主机名',
      'system.arch': '架构',
      'system.version': '版本',
      'system.cores': '{count} 核',
      'system.model': '型号',
      'system.coresLabel': '核心数',
      'system.used': '已用',
      'system.level': '电量',
      'system.memoryUsed': '已用 {used} / 共 {total}',
      'system.diskUsed': '已用 {used} / 共 {total}',
      'system.diskFree': '可用 {free}',
      'system.mount': '挂载点 {mount}',
      'system.usedPercent': '已用 {percent}%',
      'system.batteryCharging': '正在充电',
      'system.batteryRemaining': '剩余 {duration}',
      'system.batteryCharged': '已充满',
      'system.batteryUnknown': '剩余时间未知',
      'system.uptimeValue': '已运行 {duration}',
      'system.capabilityScreenshot': '截图能力',
      'system.available': '可用',
      'system.unavailable': '不可用',
      'system.saveDirectory': '保存目录',
      'system.capturedAt': '取样于 {time}',
      'system.unknown': '未知',
      'system.empty': '暂无数据',
      'duration.day': '{n} 天',
      'duration.hour': '{n} 小时',
      'duration.minute': '{n} 分',
      'duration.second': '{n} 秒',
      'shortcut.toggle': '打开或关闭 Mac 工具箱',
      'shortcut.screenshot': '快速截图（区域 / 窗口）',
    }

    const en = {
      'panel': 'Mac Tools',
      'title': 'Mac Tools',
      'subtitle': 'Screenshots and annotations, a calculator, and system information — all local.',
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
      'tab.system': 'System',
      'common.close': 'Close',
      'common.retry': 'Retry',
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
      'system.refresh': 'Refresh',
      'system.refreshing': 'Refreshing…',
      'system.loading': 'Reading system information…',
      'system.error': 'Cannot read system information: {message}',
      'system.os': 'System',
      'system.cpu': 'CPU',
      'system.memory': 'Memory',
      'system.disk': 'Disk',
      'system.battery': 'Battery',
      'system.uptime': 'Uptime',
      'system.host': 'Host',
      'system.hostname': 'Hostname',
      'system.arch': 'Architecture',
      'system.version': 'Version',
      'system.cores': '{count} cores',
      'system.model': 'Model',
      'system.coresLabel': 'Cores',
      'system.used': 'Used',
      'system.level': 'Level',
      'system.memoryUsed': '{used} used of {total}',
      'system.diskUsed': '{used} used of {total}',
      'system.diskFree': '{free} free',
      'system.mount': 'Mounted at {mount}',
      'system.usedPercent': '{percent}% used',
      'system.batteryCharging': 'Charging',
      'system.batteryRemaining': '{duration} remaining',
      'system.batteryCharged': 'Fully charged',
      'system.batteryUnknown': 'Remaining time unknown',
      'system.uptimeValue': 'Up {duration}',
      'system.capabilityScreenshot': 'Screenshot capability',
      'system.available': 'Available',
      'system.unavailable': 'Unavailable',
      'system.saveDirectory': 'Save folder',
      'system.capturedAt': 'Sampled {time}',
      'system.unknown': 'Unknown',
      'system.empty': 'No data yet',
      'duration.day': '{n}d',
      'duration.hour': '{n}h',
      'duration.minute': '{n}m',
      'duration.second': '{n}s',
      'shortcut.toggle': 'Toggle Mac Tools',
      'shortcut.screenshot': 'Quick screenshot (region / window)',
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
@media (max-width:760px){
.dshMacToolsContent{padding:0 20px 32px}
.dshMacToolsHeading{padding-top:20px;align-items:flex-start;flex-wrap:wrap}
.dshMacToolsHeadingRight{max-width:100%}
.dshMacToolsToolLabel{display:none}
.dshMacToolsCalc{max-width:none}
.dshMacToolsCanvasStage{padding:8px}
.dshMacToolsEditorHint{display:none}
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
     * @returns {{ post: Function, shotUrl: Function }} the request helpers.
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

      return { post, shotUrl, historyUrl }
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
     * @param {{ post: Function, shotUrl: Function }} host - the transport.
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
        system: { status: 'idle', value: null, refreshing: false, error: null },
        calc: { expression: '', status: 'idle', result: null, error: null, history: [] },
      }
      let hostRequest = null
      let windowsRequest = null
      let systemRequest = null
      let historyRequest = null
      /** Whether the user changed the hide-while-capturing toggle this session. */
      let hideAppTouched = false

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
       * Read system facts. Polled by the visible system tab every 10 s; a poll
       * never stacks on an in-flight request and never flashes the loading
       * skeleton over data already on screen.
       *
       * @param {{ signal?: AbortSignal }} [options] - transport options.
       * @returns {Promise<boolean>} whether the facts are current.
       */
      function loadSystem(options) {
        if (systemRequest !== null) return systemRequest
        const firstLoad = snapshot.system.value === null
        publish({
          system: Object.assign({}, snapshot.system, {
            status: firstLoad ? 'loading' : 'ready',
            refreshing: true,
            error: null,
          }),
        })
        const run = host.post('system', {}, options).then((value) => {
          const next = value !== null && typeof value === 'object' ? value : {}
          publish({ system: { status: 'ready', value: next, refreshing: false, error: null } })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (failure.code === 'aborted') {
            publish({ system: Object.assign({}, snapshot.system, { status: snapshot.system.value === null ? 'idle' : 'ready', refreshing: false }) })
            return false
          }
          publish({
            system: Object.assign({}, snapshot.system, {
              status: snapshot.system.value === null ? 'error' : 'ready',
              refreshing: false,
              error: failure,
            }),
          })
          return false
        }).then((result) => {
          systemRequest = null
          return result
        }, (error) => {
          systemRequest = null
          throw error
        })
        systemRequest = run
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
        loadSystem,
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
    // System information tab
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

    /**
     * The system tab. It reads facts on mount, again whenever the refresh button
     * is pressed, and every 10 s only while the tab is visible — the effect is
     * torn down on tab switch or panel unmount, so nothing polls in the
     * background.
     *
     * @param {object} props - tab props.
     * @returns {object} the element.
     */
    function SystemTab({ store, snapshot, t, active }) {
      const [manualTick, setManualTick] = React.useState(0)

      React.useEffect(() => {
        if (!active) return () => {}
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const signal = controller === null ? undefined : controller.signal
        void store.loadSystem({ signal })
        const timer = setInterval(() => {
          void store.loadSystem()
        }, SYSTEM_POLL_MS)
        return () => {
          clearInterval(timer)
          if (controller !== null) controller.abort()
        }
      }, [active, store])

      // A manual refresh is a one-shot read; the tick only exists to force the
      // component to look at the store after the click handler returns.
      React.useEffect(() => {
        if (manualTick === 0) return
        void store.loadSystem()
      }, [manualTick, store])

      const system = snapshot.system
      const value = system.value
      const hostValue = snapshot.host.value
      const refreshing = system.refreshing || system.status === 'loading'

      const refreshButton = h('button', {
        key: 'refresh',
        type: 'button',
        className: 'dshMacToolsButton dshMacToolsButtonCompact dshMacToolsButtonOutline',
        disabled: refreshing,
        onClick: () => setManualTick((tick) => tick + 1),
      }, refreshing
        ? [h('span', { key: 'spinner', className: 'dshMacToolsSpinner', 'aria-hidden': true }), t('system.refreshing')]
        : [glyph('refresh', 13, 'icon'), h('span', { key: 'label' }, t('system.refresh'))])

      const header = h('div', { key: 'header', className: 'dshMacToolsSysHeader' }, [
        value === null
          ? h('span', { key: 'meta', className: 'dshMacToolsSysMeta' })
          : h('p', { key: 'meta', className: 'dshMacToolsSysMeta' }, t('system.capturedAt', { time: formatDateTime(value.capturedAt) })),
        refreshButton,
      ])

      const children = [header]

      if (value === null) {
        if (system.status === 'error' && system.error !== null) {
          children.push(h('div', {
            key: 'error',
            className: 'dshMacToolsNotice dshMacToolsNoticeError',
            role: 'alert',
          }, [
            h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
            h('p', { key: 'text' }, hostErrorText(t, system.error, 'system.error')),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'dshMacToolsButton dshMacToolsButtonCompact',
              onClick: () => setManualTick((tick) => tick + 1),
            }, t('common.retry')),
          ]))
        } else {
          children.push(h('div', { key: 'loading', className: 'dshMacToolsLoading', 'aria-busy': 'true' }, [
            h('span', { key: 'sr', className: 'dshMacToolsSrOnly' }, t('system.loading')),
            h('div', { key: 'one', className: 'dshMacToolsSkeleton' }),
            h('div', { key: 'two', className: 'dshMacToolsSkeleton' }),
            h('div', { key: 'three', className: 'dshMacToolsSkeleton' }),
          ]))
        }
        return h('div', null, children)
      }

      if (system.error !== null) {
        children.push(h('div', {
          key: 'stale',
          className: 'dshMacToolsNotice',
          role: 'alert',
        }, [
          h('span', { key: 'icon', className: 'dshMacToolsNoticeIcon', 'aria-hidden': true }, glyph('alert', 15)),
          h('p', { key: 'text' }, hostErrorText(t, system.error, 'system.error')),
        ]))
      }

      const os = value.os !== null && typeof value.os === 'object' ? value.os : {}
      const cpu = value.cpu !== null && typeof value.cpu === 'object' ? value.cpu : {}
      const memory = value.memory !== null && typeof value.memory === 'object' ? value.memory : {}
      const disk = value.disk !== null && typeof value.disk === 'object' ? value.disk : {}
      const battery = value.battery !== null && typeof value.battery === 'object' ? value.battery : null

      const memoryTotal = Number.isFinite(memory.totalBytes) ? memory.totalBytes : NaN
      const memoryFree = Number.isFinite(memory.freeBytes) ? memory.freeBytes : NaN
      const memoryUsed = Number.isFinite(memoryTotal) && Number.isFinite(memoryFree) ? Math.max(0, memoryTotal - memoryFree) : NaN
      const memoryPercent = Number.isFinite(memory.usedPercent)
        ? memory.usedPercent
        : Number.isFinite(memoryTotal) && memoryTotal > 0 && Number.isFinite(memoryUsed)
          ? (memoryUsed / memoryTotal) * 100
          : 0

      const diskTotal = Number.isFinite(disk.totalBytes) ? disk.totalBytes : NaN
      const diskUsed = Number.isFinite(disk.usedBytes) ? disk.usedBytes : NaN
      const diskPercent = Number.isFinite(diskTotal) && diskTotal > 0 && Number.isFinite(diskUsed) ? (diskUsed / diskTotal) * 100 : 0

      const batteryPercent = battery !== null && Number.isFinite(battery.percent) ? battery.percent : NaN
      const batteryMinutes = battery !== null && Number.isFinite(battery.timeRemainingMinutes) ? battery.timeRemainingMinutes : null
      let batteryStatusText = t('system.batteryUnknown')
      if (battery !== null) {
        if (battery.charging === true) {
          batteryStatusText = batteryPercent >= 100 ? t('system.batteryCharged') : t('system.batteryCharging')
        } else if (batteryMinutes !== null) {
          batteryStatusText = t('system.batteryRemaining', { duration: durationText(t, batteryMinutes * 60) })
        } else if (batteryPercent >= 100) {
          batteryStatusText = t('system.batteryCharged')
        }
      }

      const capabilities = hostValue !== null && typeof hostValue === 'object' && hostValue.capabilities !== null && typeof hostValue.capabilities === 'object'
        ? hostValue.capabilities
        : {}
      const saveDirectory = hostValue !== null && typeof hostValue === 'object' && typeof hostValue.saveDirectory === 'string' && hostValue.saveDirectory !== ''
        ? hostValue.saveDirectory
        : t('system.unknown')

      const cards = [
        h(SystemCard, { key: 'os', title: t('system.os'), icon: 'system' }, [
          h(KeyValue, {
            key: 'version',
            label: t('system.version'),
            value: `${os.name === undefined ? t('system.unknown') : os.name} ${os.version === undefined ? '' : os.version}`.trim(),
          }),
          h(KeyValue, { key: 'hostname', label: t('system.hostname'), value: os.hostname === undefined ? t('system.unknown') : os.hostname }),
          h(KeyValue, { key: 'arch', label: t('system.arch'), value: os.arch === undefined ? t('system.unknown') : os.arch }),
        ]),
        h(SystemCard, { key: 'cpu', title: t('system.cpu'), icon: 'settings' }, [
          h(KeyValue, { key: 'model', label: t('system.model'), value: cpu.model === undefined ? t('system.unknown') : cpu.model }),
          h(KeyValue, {
            key: 'cores',
            label: t('system.coresLabel'),
            value: cpu.cores === undefined ? t('system.unknown') : t('system.cores', { count: cpu.cores }),
          }),
        ]),
        h(SystemCard, { key: 'memory', title: t('system.memory'), icon: 'system' }, [
          h(KeyValue, {
            key: 'used',
            label: t('system.used'),
            value: t('system.memoryUsed', { used: formatBytes(memoryUsed), total: formatBytes(memoryTotal) }),
          }),
          h(MeterBar, {
            key: 'bar',
            percent: memoryPercent,
            label: t('system.usedPercent', { percent: formatPercent(memoryPercent) }),
          }),
          h('p', { key: 'meta', className: 'dshMacToolsBarMeta' }, [
            h('span', { key: 'percent' }, t('system.usedPercent', { percent: formatPercent(memoryPercent) })),
            h('span', { key: 'total' }, formatBytes(memoryTotal)),
          ]),
        ]),
        h(SystemCard, { key: 'disk', title: t('system.disk'), icon: 'save' }, [
          h(KeyValue, {
            key: 'used',
            label: t('system.used'),
            value: t('system.diskUsed', { used: formatBytes(diskUsed), total: formatBytes(diskTotal) }),
          }),
          h(MeterBar, {
            key: 'bar',
            percent: diskPercent,
            tone: 'disk',
            label: t('system.usedPercent', { percent: formatPercent(diskPercent) }),
          }),
          h('p', { key: 'meta', className: 'dshMacToolsBarMeta' }, [
            h('span', { key: 'free' }, t('system.diskFree', { free: formatBytes(disk.freeBytes) })),
            h('span', { key: 'mount' }, t('system.mount', { mount: disk.mount === undefined ? t('system.unknown') : disk.mount })),
          ]),
        ]),
      ]

      if (battery !== null) {
        cards.push(h(SystemCard, { key: 'battery', title: t('system.battery'), icon: 'settings' }, [
          h(KeyValue, { key: 'percent', label: t('system.level'), value: `${formatPercent(batteryPercent)}%` }),
          h(MeterBar, {
            key: 'bar',
            percent: Number.isFinite(batteryPercent) ? batteryPercent : 0,
            tone: 'battery',
            label: `${formatPercent(batteryPercent)}%`,
          }),
          h('p', { key: 'status', className: 'dshMacToolsBarMeta' }, [
            h('span', { key: 'state' }, batteryStatusText),
          ]),
        ]))
      }

      cards.push(h(SystemCard, { key: 'uptime', title: t('system.uptime'), icon: 'refresh' }, [
        h(KeyValue, {
          key: 'value',
          label: t('system.uptime'),
          value: t('system.uptimeValue', { duration: durationText(t, value.uptimeSeconds) }),
        }),
      ]))

      cards.push(h(SystemCard, { key: 'host', title: t('system.host'), icon: 'camera', wide: true }, [
        h(KeyValue, {
          key: 'capability',
          label: t('system.capabilityScreenshot'),
          value: capabilities.screenshot === true ? t('system.available') : t('system.unavailable'),
        }),
        h(KeyValue, { key: 'save', label: t('system.saveDirectory'), value: saveDirectory, mono: true }),
      ]))

      children.push(h('div', { key: 'grid', className: 'dshMacToolsSysGrid' }, cards))
      return h('div', null, children)
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
     * All three tabs stay mounted and inactive ones are hidden with the
     * `hidden` attribute, so an in-progress annotation set, the calculator's
     * expression and history, and the system snapshot all survive a tab
     * switch. Only the system tab polls, and only while it is visible.
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
        else content = h(SystemTab, { store, snapshot, t, active })
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
              aliases: ['mac tools', 'toolbox', 'screenshots', 'calculator', 'system information'],
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
