/**
 * The phone-side single page served by the transfer HTTP server
 * (`GET /t/<token>/`, see docs/TRANSFER-CONTRACT.md §3.6 and §4).
 *
 * The page is completely static: no arguments, no token interpolation, no
 * user data. The inline script extracts the session token from
 * `location.pathname` (`/t/([A-Za-z0-9_-]+)/?`) and talks to the server over
 * same-origin paths only (`location.origin + '/t/' + token + '/api/...'`).
 *
 * Everything the browser needs is inline — CSS and JavaScript — because the
 * server sends a strict CSP (`default-src 'none'`, inline scripts/styles
 * allowed) and the phone may be on a LAN with no internet access. There are
 * no external URLs, fonts, images, `eval`, or `innerHTML` writes anywhere in
 * the generated document; all user-provided text is rendered through
 * `textContent`/text nodes.
 *
 * @module dsh-mac-tools/transfer-page
 */

/* -------------------------------------------------------------------------
 * Styles: mobile first, safe-area aware, dark mode via prefers-color-scheme.
 * ---------------------------------------------------------------------- */
const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f2f4f7;
  --surface: #ffffff;
  --surface-2: #f8fafc;
  --text: #101828;
  --muted: #667085;
  --border: #d0d5dd;
  --accent: #2563eb;
  --accent-strong: #1d4ed8;
  --on-accent: #ffffff;
  --ok: #12b76a;
  --warn: #f79009;
  --danger: #d92d20;
  --radius: 14px;
  --radius-sm: 10px;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 10px 28px rgba(16, 24, 40, 0.06);
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f14;
    --surface: #141b23;
    --surface-2: #1a2330;
    --text: #e7ecf2;
    --muted: #98a2b3;
    --border: #263241;
    --accent: #60a5fa;
    --accent-strong: #3b82f6;
    --on-accent: #06101c;
    --ok: #32d583;
    --warn: #fdb022;
    --danger: #f97066;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.45), 0 12px 32px rgba(0, 0, 0, 0.35);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
button, input, textarea { font: inherit; }
textarea, input[type="file"] { font-size: 16px; }
button { cursor: pointer; touch-action: manipulation; }
button:disabled { cursor: not-allowed; opacity: 0.55; }
.app {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: calc(10px + var(--safe-top)) calc(16px + var(--safe-right)) calc(28px + var(--safe-bottom)) calc(16px + var(--safe-left));
}
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0 12px; }
.device { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--muted); }
.dot[data-state="online"] { background: var(--ok); }
.dot[data-state="checking"] { background: var(--accent); animation: dot-pulse 1.2s ease-in-out infinite; }
.dot[data-state="offline"], .dot[data-state="error"] { background: var(--danger); }
.dot[data-state="expired"] { background: var(--warn); }
@keyframes dot-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.device-text { display: flex; flex-direction: column; min-width: 0; }
.device-name { font-size: 15px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46vw; }
.muted { color: var(--muted); font-size: 12.5px; }
.countdown { display: flex; flex-direction: column; align-items: flex-end; flex: none; }
.countdown strong { font-size: 19px; font-variant-numeric: tabular-nums; letter-spacing: 0.3px; }
.tabs { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); box-shadow: var(--shadow); }
.tab { flex: 1 1 0; min-height: 44px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font-size: 15px; font-weight: 650; transition: background-color 120ms ease, color 120ms ease; }
.tab[aria-selected="true"] { background: var(--accent); color: var(--on-accent); }
.tab:focus-visible, .btn:focus-visible, textarea:focus-visible, a.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.banner { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--warn); border-radius: var(--radius-sm); background: rgba(247, 144, 9, 0.12); font-size: 14px; }
.panel { display: flex; flex-direction: column; gap: 12px; padding-top: 14px; }
.card { padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
.field-label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 13px; font-weight: 650; }
textarea { display: block; width: 100%; min-height: 108px; padding: 12px; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); line-height: 1.5; }
textarea::placeholder { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.row-end { display: flex; align-items: center; gap: 8px; }
.hint { color: var(--muted); font-size: 12.5px; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); color: var(--text); font-size: 15px; font-weight: 600; text-decoration: none; touch-action: manipulation; }
.btn.primary { border-color: transparent; background: var(--accent); color: var(--on-accent); }
.btn.primary:active { background: var(--accent-strong); }
.btn.small { min-height: 36px; padding: 0 12px; font-size: 13.5px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.section-title { margin: 0; font-size: 15px; font-weight: 650; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.queue-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 16px 0 10px; }
.queue { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.queue-item { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.queue-item[data-status="done"] { border-color: var(--ok); }
.queue-item[data-status="error"] { border-color: var(--danger); }
.queue-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.queue-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.queue-size { flex: none; color: var(--muted); font-size: 12.5px; }
.queue-status { flex: none; font-size: 12.5px; }
.queue-retry { flex: none; min-height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--accent); font-size: 12.5px; font-weight: 700; }
.queue-item[data-status="pending"] .queue-status, .queue-item[data-status="uploading"] .queue-status { color: var(--muted); }
.queue-item[data-status="done"] .queue-status { color: var(--ok); }
.queue-item[data-status="error"] .queue-status { color: var(--danger); }
progress { display: block; width: 100%; height: 6px; margin-top: 8px; overflow: hidden; border: 0; border-radius: 999px; background: var(--border); -webkit-appearance: none; appearance: none; }
progress::-webkit-progress-bar { border-radius: 999px; background: var(--border); }
progress::-webkit-progress-value { border-radius: 999px; background: var(--accent); }
progress::-moz-progress-bar { border-radius: 999px; background: var(--accent); }
.outbox { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.outbox-item { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
.outbox-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.badge { flex: none; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); color: var(--muted); font-size: 11.5px; font-weight: 700; letter-spacing: 0.02em; }
.outbox-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14.5px; font-weight: 600; }
.outbox-meta { flex: none; color: var(--muted); font-size: 12px; }
.outbox-text { max-height: 40vh; margin: 10px 0 0; padding: 10px 12px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.outbox-item .btn { margin-top: 10px; }
.outbox-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 10px; }
.outbox-image { display: block; width: 100%; max-height: 300px; object-fit: contain; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.empty { padding: 22px 16px; border: 1px dashed var(--border); border-radius: var(--radius); color: var(--muted); font-size: 14px; text-align: center; }
.footer { display: flex; flex-direction: column; gap: 6px; margin-top: 20px; color: var(--muted); font-size: 12.5px; }
.footer p { margin: 0; }
.toasts { position: fixed; left: 50%; bottom: calc(18px + var(--safe-bottom)); z-index: 20; display: flex; flex-direction: column; align-items: center; gap: 8px; width: max-content; max-width: min(92vw, 520px); transform: translateX(-50%); pointer-events: none; }
/* The toast nodes intentionally stay in the accessibility tree: a live region
   that is display:none when text arrives is not reliably announced. Visibility
   is driven by opacity/data-visible instead of the hidden attribute. */
.toast { max-width: 100%; padding: 11px 16px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); font-size: 14px; text-align: center; opacity: 0; }
.toast[data-visible="true"] { opacity: 1; }
.toast-alert { border-color: var(--danger); }
@media (prefers-reduced-motion: reduce) {
  .dot[data-state="checking"] { animation: none; }
  * { transition: none !important; }
}
@media (min-width: 640px) {
  .app { padding-top: calc(24px + var(--safe-top)); }
}
`

/* -------------------------------------------------------------------------
 * Static markup: ids only, every visible label is filled in by the inline
 * script from the i18n dictionary.
 * ---------------------------------------------------------------------- */
const PAGE_BODY = `
<main class="app" id="app">
  <h1 class="visually-hidden" id="pageTitle"></h1>
  <header class="top">
    <div class="device">
      <span class="dot" id="connDot" data-state="checking" aria-hidden="true"></span>
      <div class="device-text">
        <span class="device-name" id="deviceName">Mac</span>
        <span class="muted" id="connLabel"></span>
      </div>
    </div>
    <div class="countdown">
      <span class="muted" id="remainingLabel"></span>
      <strong id="countdown">--:--</strong>
    </div>
  </header>

  <div class="tabs" id="tabs" role="tablist">
    <button type="button" class="tab" id="tabSend" role="tab" aria-selected="true" aria-controls="panelSend"></button>
    <button type="button" class="tab" id="tabReceive" role="tab" aria-selected="false" aria-controls="panelReceive"></button>
  </div>

  <div class="banner" id="expiredBanner" hidden></div>

  <section class="panel" id="panelSend" role="tabpanel" aria-labelledby="tabSend">
    <div class="card">
      <label class="field-label" id="textLabel" for="textInput"></label>
      <textarea id="textInput" rows="4" autocomplete="off" autocapitalize="sentences" spellcheck="false"></textarea>
      <div class="row">
        <span class="hint" id="shortcutHint"></span>
        <button type="button" class="btn primary" id="sendBtn"></button>
      </div>
    </div>
    <div class="card">
      <div class="row">
        <button type="button" class="btn" id="pickFilesBtn"></button>
        <button type="button" class="btn" id="takePhotoBtn"></button>
      </div>
      <input type="file" id="fileInput" class="visually-hidden" multiple>
      <input type="file" id="cameraInput" class="visually-hidden" accept="image/*" capture="environment">
      <div class="queue-title-row">
        <h2 class="section-title" id="queueTitle"></h2>
        <button type="button" class="btn small" id="clearQueueBtn" disabled></button>
      </div>
      <ul class="queue" id="uploadQueue"></ul>
    </div>
  </section>

  <section class="panel" id="panelReceive" role="tabpanel" aria-labelledby="tabReceive" hidden>
    <div class="card-head">
      <h2 class="section-title" id="receiveTitle"></h2>
      <div class="row-end">
        <span class="muted" id="outboxCount">0</span>
        <button type="button" class="btn small" id="refreshBtn"></button>
      </div>
    </div>
    <div class="empty" id="outboxEmpty" hidden></div>
    <ul class="outbox" id="outboxList"></ul>
  </section>

  <footer class="footer">
    <p id="p2pHint"></p>
    <p id="expireHint"></p>
    <p id="networkHint"></p>
  </footer>
</main>

<div class="toasts">
  <div class="toast" id="statusInfo" role="status" aria-live="polite" aria-atomic="true"></div>
  <div class="toast toast-alert" id="statusAlert" role="alert" aria-live="assertive" aria-atomic="true"></div>
</div>
`

/* -------------------------------------------------------------------------
 * Inline client: i18n dictionary, DOM building, same-origin API calls and
 * event wiring. Written as plain ES5-style code — no build step, no eval.
 * ---------------------------------------------------------------------- */
const PAGE_SCRIPT = `
(function () {
  'use strict';

  /* =====================================================================
   * 1. i18n dictionary — every visible string lives here (zh + en).
   * ================================================================== */
  var STRINGS = {
    en: {
      title: 'Phone Transfer',
      p2pHint: 'Files and text only travel inside your local Wi-Fi network.',
      networkHint: 'Cannot connect? Make sure the phone and the Mac are on the same Wi-Fi and that the firewall allows this app.',
      expireHint: 'The link stops working when the timer runs out. Keep this page open while you transfer.',
      unknownDevice: 'Mac',
      statusChecking: 'Connecting…',
      statusOnline: 'Connected',
      statusOffline: 'Offline',
      statusExpired: 'Session ended',
      remaining: 'Time left',
      tabSend: 'Send to Mac',
      tabReceive: 'From Mac',
      textLabel: 'Text',
      textPlaceholder: 'Type something for your Mac…',
      textEmpty: 'Type some text first.',
      send: 'Send',
      sending: 'Sending…',
      textSent: 'Text sent to Mac.',
      shortcutHint: 'Tip: Cmd/Ctrl + Enter sends instantly.',
      pickFiles: 'Choose files',
      takePhoto: 'Take photo',
      uploadQueue: 'Upload queue',
      clearQueue: 'Clear queue',
      uploadPending: 'Waiting',
      uploading: 'Uploading…',
      uploadDone: 'Uploaded',
      uploadFailed: 'Upload failed',
      retry: 'Retry',
      fileTooLarge: 'That file is larger than this session allows.',
      textTooLarge: 'That text is too long for this session. Shorten it and try again.',
      forbidden: 'The Mac rejected this address. Open the page again with the link from the QR code.',
      tooManyRequests: 'Too many attempts. Wait a minute and try again.',
      invalidRequest: 'The Mac rejected that request.',
      requestFailed: 'Request failed. Check the connection and try again.',
      unnamedFile: 'Untitled file',
      receiveTitle: 'Received from Mac',
      refresh: 'Refresh',
      emptyOutbox: 'Nothing from your Mac yet. Send something from the panel and it shows up here.',
      copy: 'Copy',
      copying: 'Loading…',
      copied: 'Copied to clipboard.',
      copyFailed: 'Copy failed — long-press the text to select it.',
      download: 'Download',
      uploadTimeout: 'Upload timed out: the browser sent no data. Tap Retry.',
      kindText: 'Text',
      kindFile: 'File',
      kindScreenshot: 'Screenshot',
      sessionExpired: 'This transfer session has ended. Reopen phone transfer on the Mac and scan a new QR code to continue.',
      tokenMissing: 'This link has no session token. Scan the QR code on the Mac again.',
      offline: 'The phone is offline. Reconnect to Wi-Fi to continue.',
      retryHint: 'Tap Refresh to try again.'
    },
    zh: {
      title: '手机互传',
      p2pHint: '文件与文字只在同一局域网内传输，不经过互联网。',
      networkHint: '连不上？请确认手机与 Mac 连的是同一个 Wi-Fi，并在防火墙中允许本应用。',
      expireHint: '倒计时结束后链接会失效，传输期间请保持本页打开。',
      unknownDevice: 'Mac',
      statusChecking: '连接中…',
      statusOnline: '已连接',
      statusOffline: '未连接',
      statusExpired: '会话已结束',
      remaining: '剩余时间',
      tabSend: '发给 Mac',
      tabReceive: '从 Mac 接收',
      textLabel: '文字',
      textPlaceholder: '输入要发给 Mac 的文字…',
      textEmpty: '请先输入一些文字。',
      send: '发送',
      sending: '发送中…',
      textSent: '文字已发送到 Mac。',
      shortcutHint: '提示：Cmd/Ctrl + Enter 可直接发送。',
      pickFiles: '选择文件',
      takePhoto: '拍照',
      uploadQueue: '上传队列',
      clearQueue: '清空队列',
      uploadPending: '等待上传',
      uploading: '上传中…',
      uploadDone: '已上传',
      uploadFailed: '上传失败',
      retry: '重试',
      fileTooLarge: '文件超出本次会话允许的大小。',
      textTooLarge: '文字超出本次会话的长度上限，请缩短后再试。',
      forbidden: 'Mac 拒绝了当前访问地址，请用二维码里的链接重新打开页面。',
      tooManyRequests: '尝试过于频繁，请稍等一分钟再试。',
      invalidRequest: 'Mac 拒绝了这次请求。',
      requestFailed: '请求失败，请检查连接后重试。',
      unnamedFile: '未命名文件',
      receiveTitle: '从 Mac 收到',
      refresh: '刷新',
      emptyOutbox: 'Mac 还没有发来内容。在面板里发送后，这里会自动出现。',
      copy: '复制',
      copying: '加载中…',
      copied: '已复制到剪贴板。',
      copyFailed: '复制失败，请长按文本手动选择复制。',
      download: '下载',
      uploadTimeout: '上传超时：浏览器没有发送数据，请重试。',
      kindText: '文字',
      kindFile: '文件',
      kindScreenshot: '截图',
      sessionExpired: '本次互传会话已过期。请在 Mac 上重新开启手机互传并扫描新的二维码。',
      tokenMissing: '链接中缺少会话令牌，请重新扫描 Mac 上的二维码。',
      offline: '手机当前离线，请重新连接 Wi-Fi。',
      retryHint: '点击「刷新」重试。'
    }
  };

  var lang = (navigator.language || 'en').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';

  function t(key) {
    var table = STRINGS[lang] || STRINGS.en;
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    if (Object.prototype.hasOwnProperty.call(STRINGS.en, key)) return STRINGS.en[key];
    return key;
  }

  /* =====================================================================
   * 2. Session token + same-origin API endpoints (contract §3.6).
   * ================================================================== */
  var TOKEN_PATTERN = new RegExp('/t/([A-Za-z0-9_-]+)/?');
  var token = '';
  var tokenMatch = TOKEN_PATTERN.exec(location.pathname);
  if (tokenMatch) token = tokenMatch[1];

  function apiStateUrl() { return location.origin + '/t/' + token + '/api/state'; }
  function apiTextUrl() { return location.origin + '/t/' + token + '/api/text'; }
  function apiUploadUrl(name) { return location.origin + '/t/' + token + '/api/upload?name=' + encodeURIComponent(name || 'file'); }
  function apiItemUrl(id) { return location.origin + '/t/' + token + '/api/items/' + encodeURIComponent(id || ''); }
  function apiPreviewUrl(id) { return apiItemUrl(id) + '?inline=1'; }
  function apiDownloadUrl(id) { return apiItemUrl(id) + '?download=1'; }
  function apiDiagUrl() { return location.origin + '/t/' + token + '/api/diag'; }

  /* =====================================================================
   * 3. Runtime state.
   * ================================================================== */
  var POLL_INTERVAL_MS = 2000;
  var COUNTDOWN_INTERVAL_MS = 1000;
  var REQUEST_TIMEOUT_MS = 12000;
  var UPLOAD_TIMEOUT_MS = 180000;
  var UPLOAD_STALL_MS = 30000;
  var DOWNLOAD_BLOB_LIMIT_BYTES = 64 * 1024 * 1024;
  var TOAST_INFO_MS = 2600;
  var TOAST_ALERT_MS = 5200;

  var session = { deviceName: '', expiresAt: 0, clockOffset: 0, expired: false, pollFailed: false };
  var outbox = [];
  var outboxSignature = null;
  var queue = [];
  var queueBusy = false;
  var sendingText = false;
  var pollTimer = null;
  var countdownTimer = null;
  var pollBusy = false;
  var nodes = {};

  function byId(id) { return document.getElementById(id); }

  function collectNodes() {
    var ids = [
      'pageTitle', 'deviceName', 'connDot', 'connLabel', 'countdown', 'remainingLabel',
      'tabs', 'tabSend', 'tabReceive', 'panelSend', 'panelReceive', 'expiredBanner',
      'textLabel', 'textInput', 'shortcutHint', 'sendBtn', 'pickFilesBtn',
      'takePhotoBtn', 'fileInput', 'cameraInput', 'queueTitle', 'clearQueueBtn',
      'uploadQueue', 'receiveTitle', 'outboxCount', 'refreshBtn', 'outboxEmpty',
      'outboxList', 'p2pHint', 'expireHint', 'networkHint', 'statusInfo', 'statusAlert'
    ];
    for (var i = 0; i < ids.length; i += 1) nodes[ids[i]] = byId(ids[i]);
  }

  /* =====================================================================
   * 4. Formatting helpers.
   * ================================================================== */
  function pad2(value) { return value < 10 ? '0' + value : String(value); }

  function formatDuration(milliseconds) {
    var total = Math.max(0, Math.floor(milliseconds / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    if (hours > 0) return hours + ':' + pad2(minutes) + ':' + pad2(seconds);
    return minutes + ':' + pad2(seconds);
  }

  function formatBytes(bytes) {
    var value = Number(bytes);
    if (!isFinite(value) || value <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value = value / 1024;
      index += 1;
    }
    var rounded = index === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return rounded + ' ' + units[index];
  }

  function formatTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  }

  /* =====================================================================
   * 5. Toasts, connection indicator, countdown and session expiry.
   * ================================================================== */
  function showToast(node, message, milliseconds) {
    if (!node) return;
    // The node is always attached to the accessibility tree (opacity, not
    // the hidden attribute), so writing the text here reliably reaches the
    // live region.
    node.textContent = message;
    node.setAttribute('data-visible', 'true');
    if (node.__hideTimer) clearTimeout(node.__hideTimer);
    node.__hideTimer = setTimeout(function () {
      node.removeAttribute('data-visible');
      node.textContent = '';
      node.__hideTimer = null;
    }, milliseconds);
  }

  function announceInfo(message) { showToast(nodes.statusInfo, message, TOAST_INFO_MS); }
  function announceError(message) { showToast(nodes.statusAlert, message, TOAST_ALERT_MS); }

  function setConnection(state) {
    if (nodes.connDot) nodes.connDot.setAttribute('data-state', state);
    var key = 'statusOffline';
    if (state === 'online') key = 'statusOnline';
    else if (state === 'checking') key = 'statusChecking';
    else if (state === 'expired') key = 'statusExpired';
    if (nodes.connLabel) nodes.connLabel.textContent = t(key);
  }

  function serverNow() { return Date.now() + session.clockOffset; }

  function tickCountdown() {
    if (!nodes.countdown) return;
    if (session.expired) {
      nodes.countdown.textContent = '00:00';
      return;
    }
    if (!session.expiresAt) {
      nodes.countdown.textContent = '--:--';
      return;
    }
    var remaining = session.expiresAt - serverNow();
    if (remaining <= 0) {
      markExpired();
      nodes.countdown.textContent = '00:00';
      return;
    }
    nodes.countdown.textContent = formatDuration(remaining);
  }

  function disableComposer() {
    var ids = ['sendBtn', 'pickFilesBtn', 'takePhotoBtn'];
    for (var i = 0; i < ids.length; i += 1) {
      if (nodes[ids[i]]) nodes[ids[i]].disabled = true;
    }
    if (nodes.textInput) nodes.textInput.disabled = true;
  }

  /**
   * A session that has ended can never accept the remaining queued files, so
   * turn every not-yet-started row into a visible terminal state instead of
   * leaving it on "Waiting" forever.
   */
  function failQueuedUploads() {
    for (var i = 0; i < queue.length; i += 1) {
      var row = queue[i];
      if (row.retryNode) row.retryNode.hidden = true;
      if (row.status === 'pending') setRowStatus(row, 'error', t('sessionExpired'));
    }
  }

  function markExpired() {
    if (session.expired) return;
    session.expired = true;
    stopPolling();
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    setConnection('expired');
    if (nodes.countdown) nodes.countdown.textContent = '00:00';
    disableComposer();
    failQueuedUploads();
    if (nodes.expiredBanner) {
      nodes.expiredBanner.hidden = false;
      nodes.expiredBanner.textContent = t('sessionExpired');
    }
    announceError(t('sessionExpired'));
  }

  /* =====================================================================
   * 6. API wrapper: same-origin fetch with readable failure mapping.
   * ================================================================== */
  function fetchWithTimeout(url, options) {
    var opts = options || {};
    if (typeof AbortController !== 'function') return fetch(url, opts);
    var controller = new AbortController();
    opts.signal = controller.signal;
    var timer = setTimeout(function () {
      try {
        controller.abort();
      } catch (error) {
        // Abort is best effort; the request already finished or was never sent.
      }
    }, REQUEST_TIMEOUT_MS);
    return fetch(url, opts).then(function (response) {
      clearTimeout(timer);
      return response;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  function apiFetch(url, options) {
    return fetchWithTimeout(url, options || {}).then(function (response) {
      if (response.status === 404) {
        markExpired();
        var expiredError = new Error('session_expired');
        expiredError.status = 404;
        throw expiredError;
      }
      if (!response.ok) {
        var failure = new Error('http_' + response.status);
        failure.status = response.status;
        throw failure;
      }
      return response.json();
    });
  }

  /**
   * Fetch a text item as plain text. The state payload only inlines a preview
   * of long texts, so the full body comes from GET api/items/<id>.
   *
   * @param {string} url - same-origin items URL.
   * @returns {Promise<string>} the complete text body.
   */
  function apiFetchText(url) {
    return fetchWithTimeout(url, { cache: 'no-store', headers: { accept: 'text/plain' } }).then(function (response) {
      if (response.status === 404) {
        markExpired();
        var expiredError = new Error('session_expired');
        expiredError.status = 404;
        throw expiredError;
      }
      if (!response.ok) {
        var failure = new Error('http_' + response.status);
        failure.status = response.status;
        throw failure;
      }
      return response.text();
    });
  }

  function reportRequestError(error) {
    if (session.expired) return;
    var status = error && error.status;
    if (status === 404) return;
    if (status === 413) {
      announceError(t('textTooLarge'));
      return;
    }
    if (status === 403) {
      announceError(t('forbidden'));
      return;
    }
    if (status === 429) {
      announceError(t('tooManyRequests'));
      return;
    }
    if (status === 400) {
      announceError(t('invalidRequest'));
      return;
    }
    if (!status && navigator.onLine === false) {
      setConnection('offline');
      announceError(t('offline'));
      return;
    }
    if (!status) setConnection('error');
    announceError(t('requestFailed'));
  }

  /**
   * Best-effort report of a browser-side failure to the Mac.
   *
   * The phone cannot be remote-debugged, so an uncaught exception, a stalled
   * XHR or a failed fetch is written to the Host's local diagnostics log
   * (state/transfer/diagnostics.log) and can be inspected there.
   */
  function reportClientEvent(kind, message, detail) {
    try {
      if (typeof fetch !== 'function') return;
      fetch(apiDiagUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: String(kind || '').slice(0, 120),
          message: String(message == null ? '' : message).slice(0, 1200),
          source: String(location.pathname || '').slice(0, 400),
          line: null,
          detail: String(detail == null ? '' : detail).slice(0, 1200)
        }),
        keepalive: true
      }).catch(function () {});
    } catch (error) {
      // Diagnostics are best effort and must never break a transfer.
    }
  }

  /* =====================================================================
   * 7. Polling api/state and rendering the outbox.
   * ================================================================== */
  function startPolling() {
    if (!token || session.expired || pollTimer) return;
    pollState();
    pollTimer = setInterval(function () {
      if (!document.hidden) pollState();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollState() {
    if (session.expired || pollBusy) return;
    pollBusy = true;
    apiFetch(apiStateUrl(), { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(applyState)
      .catch(function (error) {
        if (session.expired) return;
        var online = navigator.onLine !== false;
        setConnection(online ? 'error' : 'offline');
        if (session.pollFailed) return;
        session.pollFailed = true;
        var status = error && error.status;
        if (!online) announceError(t('offline'));
        else if (status === 403) announceError(t('forbidden'));
        else if (status === 429) announceError(t('tooManyRequests'));
        else announceError(t('requestFailed') + ' ' + t('retryHint'));
      })
      .then(function () { pollBusy = false; });
  }

  function applyState(payload) {
    var data = payload && typeof payload === 'object' ? payload : {};
    var serverIso = typeof data.now === 'string' ? Date.parse(data.now) : NaN;
    if (!isNaN(serverIso)) session.clockOffset = serverIso - Date.now();
    var expiresIso = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
    if (!isNaN(expiresIso)) session.expiresAt = expiresIso;
    var deviceName = data.device && typeof data.device.name === 'string' ? data.device.name : '';
    session.deviceName = deviceName;
    if (nodes.deviceName) nodes.deviceName.textContent = deviceName || t('unknownDevice');
    outbox = data.outbox && Array.isArray(data.outbox.items) ? data.outbox.items : [];
    renderOutbox();
    session.pollFailed = false;
    setConnection('online');
    tickCountdown();
    if (session.expiresAt && session.expiresAt - serverNow() <= 0) markExpired();
  }

  function outboxKey(items) {
    var key = '';
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i] && typeof items[i] === 'object' ? items[i] : {};
      key += (item.id || '?') + ':' + (item.createdAt || '') + '|';
    }
    return key;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function renderOutbox() {
    if (!nodes.outboxList) return;
    if (nodes.outboxCount) nodes.outboxCount.textContent = String(outbox.length);
    if (nodes.outboxEmpty) nodes.outboxEmpty.hidden = outbox.length > 0;
    var key = outboxKey(outbox);
    if (key === outboxSignature) return;
    outboxSignature = key;
    clearNode(nodes.outboxList);
    for (var i = 0; i < outbox.length; i += 1) {
      nodes.outboxList.appendChild(buildOutboxItem(outbox[i]));
    }
  }

  function kindLabel(kind) {
    if (kind === 'text') return t('kindText');
    if (kind === 'history') return t('kindScreenshot');
    return t('kindFile');
  }

  function isImage(item) {
    if (item.previewable === true) return true;
    return typeof item.mime === 'string' && item.mime.indexOf('image/') === 0;
  }

  function buildOutboxItem(raw) {
    var item = raw && typeof raw === 'object' ? raw : {};
    var listItem = document.createElement('li');
    listItem.className = 'outbox-item';

    var head = document.createElement('div');
    head.className = 'outbox-head';

    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = kindLabel(item.kind);
    head.appendChild(badge);

    var name = document.createElement('span');
    name.className = 'outbox-name';
    name.textContent = typeof item.name === 'string' && item.name ? item.name : t('unnamedFile');
    head.appendChild(name);

    var meta = document.createElement('span');
    meta.className = 'outbox-meta';
    var sizeText = formatBytes(item.size);
    var timeText = formatTime(item.createdAt);
    meta.textContent = timeText ? sizeText + ' · ' + timeText : sizeText;
    head.appendChild(meta);

    listItem.appendChild(head);

    if (item.kind === 'text' && typeof item.text === 'string') {
      var truncated = item.textTruncated === true;
      var textBlock = document.createElement('p');
      textBlock.className = 'outbox-text';
      // api/state only inlines a preview of long texts; the ellipsis signals
      // that copying fetches the complete text from the items endpoint.
      textBlock.textContent = truncated ? item.text + '…' : item.text;
      listItem.appendChild(textBlock);
      var copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'btn small';
      copyButton.textContent = t('copy');
      copyButton.addEventListener('click', function () {
        copyOutboxItem(item, textBlock, copyButton);
      });
      listItem.appendChild(copyButton);
      return listItem;
    }

    var actions = document.createElement('div');
    actions.className = 'outbox-actions';
    if (isImage(item) && item.id) {
      var image = document.createElement('img');
      image.className = 'outbox-image';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.alt = typeof item.name === 'string' && item.name ? item.name : t('unnamedFile');
      image.src = apiPreviewUrl(item.id);
      image.addEventListener('error', function () { image.hidden = true; });
      actions.appendChild(image);
    }
    if (item.id) {
      var link = document.createElement('a');
      link.className = 'btn small';
      link.href = apiDownloadUrl(item.id);
      link.setAttribute('download', typeof item.name === 'string' && item.name ? item.name : 'download');
      link.textContent = t('download');
      actions.appendChild(link);
    }
    listItem.appendChild(actions);
    return listItem;
  }

  /* =====================================================================
   * 8. Clipboard with a textarea + execCommand fallback (non-secure LAN).
   * ================================================================== */
  function copyText(value, done) {
    var text = typeof value === 'string' ? value : String(value == null ? '' : value);
    var fallback = function () {
      var helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.top = '0';
      helper.style.left = '0';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.focus();
      helper.select();
      helper.setSelectionRange(0, text.length);
      var copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (error) {
        copied = false;
      }
      document.body.removeChild(helper);
      done(copied);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  /**
   * Copy one outbox text item. When the state payload only carries a truncated
   * preview (textTruncated === true), the complete text is fetched first so
   * the clipboard never receives a cut-off text. A failed fetch reports an
   * error instead of silently copying the preview.
   *
   * @param {object} item - outbox item (text kind).
   * @param {HTMLElement|null} textBlock - the rendered preview element.
   * @param {HTMLButtonElement|null} button - the copy button, disabled meanwhile.
   */
  function copyOutboxItem(item, textBlock, button) {
    var inlineText = typeof item.text === 'string' ? item.text : '';
    var finish = function (copied) {
      if (copied) announceInfo(t('copied'));
      else announceError(t('copyFailed'));
    };
    if (item.textTruncated !== true || !item.id) {
      copyText(inlineText, finish);
      return;
    }
    var label = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = t('copying');
    }
    apiFetchText(apiItemUrl(item.id)).then(function (fullText) {
      var full = typeof fullText === 'string' ? fullText : '';
      item.text = full;
      item.textTruncated = false;
      if (textBlock) textBlock.textContent = full;
      copyText(full, finish);
    }).catch(reportRequestError).then(function () {
      if (button) {
        button.disabled = false;
        button.textContent = label;
      }
    });
  }

  /* =====================================================================
   * 9. Sending text to the Mac.
   * ================================================================== */
  function sendText() {
    if (session.expired) {
      announceError(t('sessionExpired'));
      return;
    }
    if (sendingText) return;
    var text = nodes.textInput ? nodes.textInput.value : '';
    if (!text || !text.trim()) {
      announceError(t('textEmpty'));
      if (nodes.textInput) nodes.textInput.focus();
      return;
    }
    sendingText = true;
    if (nodes.sendBtn) {
      nodes.sendBtn.disabled = true;
      nodes.sendBtn.textContent = t('sending');
    }
    apiFetch(apiTextUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function () {
      // Only clear the box when it still holds exactly what was sent: if the
      // user kept typing while the request was in flight, that text is kept.
      if (nodes.textInput && nodes.textInput.value === text) nodes.textInput.value = '';
      announceInfo(t('textSent'));
    }).catch(function (error) {
      reportClientEvent('text-failed', error && error.message ? error.message : String(error), 'status=' + (error && error.status ? error.status : 0));
      reportRequestError(error);
    }).then(function () {
      sendingText = false;
      if (nodes.sendBtn) {
        nodes.sendBtn.textContent = t('send');
        if (!session.expired) nodes.sendBtn.disabled = false;
      }
    });
  }

  /* =====================================================================
   * 10. Upload queue: one XMLHttpRequest per file, sequential, with
   *     per-item progress from xhr.upload.onprogress.
   * ================================================================== */
  function enqueueFiles(fileList) {
    if (session.expired) {
      announceError(t('sessionExpired'));
      return;
    }
    if (!fileList || !fileList.length) return;
    for (var i = 0; i < fileList.length; i += 1) {
      if (fileList[i]) addQueueRow(fileList[i]);
    }
    updateQueueControls();
    processQueue();
  }

  function addQueueRow(file) {
    var row = {
      file: file,
      status: 'pending',
      node: null,
      statusNode: null,
      bar: null,
      retryNode: null,
      xhr: null,
      progressBytes: 0,
      lastProgressAt: 0,
      fallbackTried: false
    };
    var listItem = document.createElement('li');
    listItem.className = 'queue-item';
    listItem.setAttribute('data-status', 'pending');

    var head = document.createElement('div');
    head.className = 'queue-head';

    var name = document.createElement('span');
    name.className = 'queue-name';
    name.textContent = typeof file.name === 'string' && file.name ? file.name : t('unnamedFile');
    head.appendChild(name);

    var size = document.createElement('span');
    size.className = 'queue-size';
    size.textContent = formatBytes(file.size);
    head.appendChild(size);

    var status = document.createElement('span');
    status.className = 'queue-status';
    head.appendChild(status);

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'queue-retry';
    retry.textContent = t('retry');
    retry.hidden = true;
    retry.addEventListener('click', function () { retryUpload(row); });
    head.appendChild(retry);

    var bar = document.createElement('progress');
    bar.max = 100;
    bar.value = 0;
    bar.setAttribute('aria-hidden', 'true');

    listItem.appendChild(head);
    listItem.appendChild(bar);
    if (nodes.uploadQueue) nodes.uploadQueue.appendChild(listItem);

    row.node = listItem;
    row.statusNode = status;
    row.bar = bar;
    row.retryNode = retry;
    queue.push(row);
    setRowStatus(row, 'pending');
    return row;
  }

  function setRowStatus(row, status, detail) {
    row.status = status;
    if (row.node) row.node.setAttribute('data-status', status);
    if (row.retryNode && status !== 'error') row.retryNode.hidden = true;
    if (!row.statusNode) return;
    if (status === 'pending') row.statusNode.textContent = t('uploadPending');
    else if (status === 'uploading') row.statusNode.textContent = t('uploading');
    else if (status === 'done') row.statusNode.textContent = t('uploadDone');
    else row.statusNode.textContent = detail || t('uploadFailed');
    if (row.bar) {
      if (status === 'done') row.bar.value = 100;
      if (status === 'pending') row.bar.value = 0;
    }
  }

  /** Show or hide the per-row retry affordance (only for transient failures). */
  function setRetryable(row, retryable) {
    if (row.retryNode) row.retryNode.hidden = !retryable;
  }

  /** Requeue one failed row and let the sequential worker pick it up again. */
  function retryUpload(row) {
    if (!row || session.expired) return;
    if (row.status !== 'error') return;
    if (row.bar) row.bar.value = 0;
    row.progressBytes = 0;
    row.lastProgressAt = 0;
    row.fallbackTried = false;
    setRowStatus(row, 'pending');
    updateQueueControls();
    processQueue();
  }

  function updateQueueControls() {
    if (!nodes.clearQueueBtn) return;
    nodes.clearQueueBtn.disabled = queue.length === 0;
    nodes.clearQueueBtn.textContent = queue.length ? t('clearQueue') + ' (' + queue.length + ')' : t('clearQueue');
  }

  function processQueue() {
    if (session.expired || queueBusy) return;
    var next = null;
    for (var i = 0; i < queue.length; i += 1) {
      if (queue[i].status === 'pending') {
        next = queue[i];
        break;
      }
    }
    if (!next) return;
    queueBusy = true;
    uploadOne(next, function () {
      queueBusy = false;
      processQueue();
    });
  }

  function failUpload(row, status) {
    if (status === 404) {
      setRowStatus(row, 'error', t('sessionExpired'));
      setRetryable(row, false);
      markExpired();
      return;
    }
    if (status === 413) {
      setRowStatus(row, 'error', t('fileTooLarge'));
      setRetryable(row, false);
      announceError(t('fileTooLarge'));
      return;
    }
    if (status === 403) {
      setRowStatus(row, 'error', t('forbidden'));
      setRetryable(row, false);
      announceError(t('forbidden'));
      return;
    }
    if (status === 429) {
      setRowStatus(row, 'error', t('tooManyRequests'));
      setRetryable(row, true);
      announceError(t('tooManyRequests'));
      return;
    }
    if (status === 400) {
      setRowStatus(row, 'error', t('invalidRequest'));
      setRetryable(row, false);
      announceError(t('invalidRequest'));
      return;
    }
    setRowStatus(row, 'error', status ? t('uploadFailed') + ' (' + status + ')' : t('uploadFailed'));
    setRetryable(row, !status || status === 429 || status >= 500);
    announceError(t('uploadFailed'));
  }

  /** Upload the same File with fetch(); used when XHR cannot send it. */
  function uploadViaFetch(row) {
    return fetch(apiUploadUrl(row.file.name), {
      method: 'POST',
      headers: { 'content-type': row.file.type || 'application/octet-stream' },
      body: row.file
    }).then(function (response) {
      if (response.status === 404) {
        markExpired();
        var expiredError = new Error('session_expired');
        expiredError.status = 404;
        throw expiredError;
      }
      if (!response.ok) {
        var failure = new Error('http_' + response.status);
        failure.status = response.status;
        throw failure;
      }
      return response.json();
    });
  }

  /**
   * Retry one upload with fetch() when XMLHttpRequest could not send it.
   *
   * Some Android browser builds stall an XHR carrying a large File body while
   * plain fetch requests keep working; this fallback is also what turns an
   * otherwise silent "stuck at 0 %" row into a real success or a real error.
   */
  function fallbackUpload(row, finish) {
    if (row.fallbackTried) {
      setRowStatus(row, 'error', t('uploadFailed'));
      setRetryable(row, true);
      announceError(t('uploadFailed'));
      finish();
      return;
    }
    row.fallbackTried = true;
    if (row.statusNode) row.statusNode.textContent = t('uploading');
    uploadViaFetch(row).then(function (payload) {
      var item = payload && payload.item ? payload.item : null;
      if (row.bar) row.bar.value = 100;
      setRowStatus(row, 'done');
      announceInfo(t('uploadDone') + ': ' + (item && item.name ? item.name : (row.file.name || t('unnamedFile'))));
      finish();
    }, function (error) {
      var status = error && error.status ? error.status : 0;
      reportClientEvent('upload-fetch-failed', error && error.message ? error.message : String(error), 'name=' + (row.file.name || '') + ' size=' + (row.file.size || 0) + ' status=' + status);
      if (status === 404) {
        setRowStatus(row, 'error', t('sessionExpired'));
        markExpired();
      } else {
        setRowStatus(row, 'error', status ? t('uploadFailed') + ' (' + status + ')' : t('uploadFailed'));
        setRetryable(row, true);
        announceError(t('uploadFailed'));
      }
      finish();
    });
  }

  function uploadOne(row, done) {
    var finished = false;
    var stalled = false;
    var watchdog = null;
    var finish = function () {
      if (finished) return;
      finished = true;
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      row.xhr = null;
      updateQueueControls();
      done();
    };
    setRowStatus(row, 'uploading');
    var xhr;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('POST', apiUploadUrl(row.file.name));
      xhr.setRequestHeader('Content-Type', row.file.type || 'application/octet-stream');
    } catch (error) {
      reportClientEvent('upload-setup', error && error.message ? error.message : String(error), error && error.stack ? error.stack : '');
      fallbackUpload(row, finish);
      return;
    }
    row.xhr = xhr;
    row.progressBytes = 0;
    row.lastProgressAt = Date.now();
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = function (event) {
      if (!event) return;
      if (typeof event.loaded === 'number') {
        row.progressBytes = event.loaded;
        row.lastProgressAt = Date.now();
      }
      if (!event.lengthComputable || !event.total) return;
      var percent = Math.round((event.loaded / event.total) * 100);
      if (row.bar) row.bar.value = percent;
      if (row.statusNode) row.statusNode.textContent = t('uploading') + ' ' + percent + '%';
    };
    xhr.onload = function () {
      if (finished) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        if (row.bar) row.bar.value = 100;
        setRowStatus(row, 'done');
        announceInfo(t('uploadDone') + ': ' + (row.file.name || t('unnamedFile')));
        finish();
        return;
      }
      failUpload(row, xhr.status);
      finish();
    };
    xhr.onerror = function () {
      if (finished || stalled) return;
      if (navigator.onLine === false) {
        setRowStatus(row, 'error', t('offline'));
        setRetryable(row, true);
        setConnection('offline');
        announceError(t('offline'));
        finish();
        return;
      }
      reportClientEvent('upload-xhr-error', 'xhr error', 'name=' + (row.file.name || '') + ' size=' + (row.file.size || 0) + ' status=' + xhr.status);
      setConnection('error');
      fallbackUpload(row, finish);
    };
    xhr.ontimeout = function () {
      if (finished || stalled) return;
      reportClientEvent('upload-timeout', 'no upload within ' + UPLOAD_TIMEOUT_MS + 'ms', 'name=' + (row.file.name || '') + ' size=' + (row.file.size || 0));
      fallbackUpload(row, finish);
    };
    xhr.onabort = function () {
      if (finished || stalled) return;
      setRowStatus(row, 'error', t('uploadFailed'));
      finish();
    };
    // Some Android WebViews accept the request but never send a single byte and
    // never fire an error event. Treat a long quiet period as a stall, abort,
    // and immediately try the fetch fallback with the same body.
    watchdog = setInterval(function () {
      if (finished || row.xhr !== xhr) return;
      if (Date.now() - row.lastProgressAt < UPLOAD_STALL_MS) return;
      stalled = true;
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      reportClientEvent('upload-stalled', 'no upload progress for ' + UPLOAD_STALL_MS + 'ms', 'name=' + (row.file.name || '') + ' size=' + (row.file.size || 0) + ' progress=' + row.progressBytes);
      try {
        xhr.abort();
      } catch (error) {
        // The request already finished.
      }
      fallbackUpload(row, finish);
    }, 5000);
    try {
      xhr.send(row.file);
    } catch (error) {
      reportClientEvent('upload-send', error && error.message ? error.message : String(error), error && error.stack ? error.stack : '');
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      fallbackUpload(row, finish);
    }
  }

  function clearQueue() {
    var inFlight = [];
    for (var i = 0; i < queue.length; i += 1) {
      if (queue[i].xhr) inFlight.push(queue[i].xhr);
    }
    queue = [];
    if (nodes.uploadQueue) clearNode(nodes.uploadQueue);
    updateQueueControls();
    for (var j = 0; j < inFlight.length; j += 1) {
      try {
        inFlight[j].abort();
      } catch (error) {
        // The request already finished; nothing to abort.
      }
    }
  }

  /* =====================================================================
   * 11. Static labels + event wiring.
   * ================================================================== */
  function setNodeText(id, value) {
    var node = nodes[id] || byId(id);
    if (node) node.textContent = value;
  }

  function applyStrings() {
    document.title = t('title');
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    setNodeText('pageTitle', t('title'));
    if (nodes.tabs) nodes.tabs.setAttribute('aria-label', t('title'));
    setNodeText('remainingLabel', t('remaining'));
    setNodeText('tabSend', t('tabSend'));
    setNodeText('tabReceive', t('tabReceive'));
    setNodeText('textLabel', t('textLabel'));
    setNodeText('shortcutHint', t('shortcutHint'));
    setNodeText('sendBtn', t('send'));
    setNodeText('pickFilesBtn', t('pickFiles'));
    setNodeText('takePhotoBtn', t('takePhoto'));
    setNodeText('queueTitle', t('uploadQueue'));
    setNodeText('receiveTitle', t('receiveTitle'));
    setNodeText('refreshBtn', t('refresh'));
    setNodeText('outboxEmpty', t('emptyOutbox'));
    setNodeText('p2pHint', t('p2pHint'));
    setNodeText('expireHint', t('expireHint'));
    setNodeText('networkHint', t('networkHint'));
    setNodeText('deviceName', t('unknownDevice'));
    if (nodes.textInput) {
      nodes.textInput.setAttribute('placeholder', t('textPlaceholder'));
      nodes.textInput.setAttribute('aria-label', t('textLabel'));
    }
    if (nodes.connLabel) nodes.connLabel.textContent = t('statusChecking');
    if (nodes.countdown) nodes.countdown.textContent = '--:--';
    updateQueueControls();
  }

  function selectTab(name) {
    var sendActive = name === 'send';
    if (nodes.tabSend) nodes.tabSend.setAttribute('aria-selected', sendActive ? 'true' : 'false');
    if (nodes.tabReceive) nodes.tabReceive.setAttribute('aria-selected', sendActive ? 'false' : 'true');
    if (nodes.panelSend) nodes.panelSend.hidden = !sendActive;
    if (nodes.panelReceive) nodes.panelReceive.hidden = sendActive;
    if (!sendActive) pollState();
  }

  function bindEvents() {
    if (nodes.tabSend) nodes.tabSend.addEventListener('click', function () { selectTab('send'); });
    if (nodes.tabReceive) nodes.tabReceive.addEventListener('click', function () { selectTab('receive'); });
    if (nodes.sendBtn) nodes.sendBtn.addEventListener('click', sendText);
    if (nodes.textInput) {
      nodes.textInput.addEventListener('keydown', function (event) {
        if (event.isComposing) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          sendText();
        }
      });
    }
    if (nodes.pickFilesBtn && nodes.fileInput) {
      nodes.pickFilesBtn.addEventListener('click', function () { nodes.fileInput.click(); });
    }
    if (nodes.takePhotoBtn && nodes.cameraInput) {
      nodes.takePhotoBtn.addEventListener('click', function () { nodes.cameraInput.click(); });
    }
    if (nodes.fileInput) {
      nodes.fileInput.addEventListener('change', function () {
        enqueueFiles(nodes.fileInput.files);
        nodes.fileInput.value = '';
      });
    }
    if (nodes.cameraInput) {
      nodes.cameraInput.addEventListener('change', function () {
        enqueueFiles(nodes.cameraInput.files);
        nodes.cameraInput.value = '';
      });
    }
    if (nodes.clearQueueBtn) nodes.clearQueueBtn.addEventListener('click', clearQueue);
    if (nodes.refreshBtn) nodes.refreshBtn.addEventListener('click', function () { pollState(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling();
      else startPolling();
    });
    window.addEventListener('online', function () {
      session.pollFailed = false;
      setConnection('checking');
      startPolling();
    });
    window.addEventListener('offline', function () {
      setConnection('offline');
      stopPolling();
      if (!session.pollFailed) {
        session.pollFailed = true;
        announceError(t('offline'));
      }
    });
    window.addEventListener('error', function (event) {
      var message = event && event.message ? event.message : 'unknown error';
      var where = event && event.filename ? (event.filename + ':' + (event.lineno || 0) + ':' + (event.colno || 0)) : '';
      var stack = event && event.error && event.error.stack ? event.error.stack : '';
      reportClientEvent('page-error', message, where + (stack ? ' ' + stack : ''));
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      reportClientEvent('unhandled-rejection', reason && reason.message ? reason.message : String(reason), reason && reason.stack ? reason.stack : '');
    });
  }

  function init() {
    collectNodes();
    applyStrings();
    bindEvents();
    if (!token) {
      setConnection('error');
      disableComposer();
      if (nodes.expiredBanner) {
        nodes.expiredBanner.hidden = false;
        nodes.expiredBanner.textContent = t('tokenMissing');
      }
      announceError(t('tokenMissing'));
      return;
    }
    countdownTimer = setInterval(tickCountdown, COUNTDOWN_INTERVAL_MS);
    tickCountdown();
    setConnection('checking');
    startPolling();
  }

  init();
})();
`

/**
 * Render the complete phone-side HTML document.
 *
 * The result is static (identical on every call) and safe to serve with the
 * CSP from the contract: only inline script/style, only same-origin requests.
 *
 * @returns {string} a complete HTML document.
 */
export function renderTransferPage() {
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<meta name="format-detection" content="telephone=no">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    '<meta name="theme-color" content="#f2f4f7" media="(prefers-color-scheme: light)">\n' +
    '<meta name="theme-color" content="#0b0f14" media="(prefers-color-scheme: dark)">\n' +
    '<title>Phone Transfer</title>\n' +
    '<style>\n' +
    PAGE_STYLE +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    PAGE_BODY +
    '<script>\n' +
    PAGE_SCRIPT +
    '</script>\n' +
    '</body>\n' +
    '</html>\n'
  )
}
