/**
 * Phone transfer page tests (docs/TRANSFER-CONTRACT.md §4).
 *
 * `renderTransferPage()` returns a self-contained document: these assertions
 * pin the contract surface (doctype, viewport, file/camera inputs, XHR
 * uploads, same-origin API paths, clipboard fallback, aria-live regions,
 * bilingual copy) and pin the safety properties (no external URLs, no
 * external scripts, no innerHTML/document.write).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { renderTransferPage } from '../src/transfer-page.js'

const page = renderTransferPage()
const SCRIPT_START = '<script>\n'
const inlineScript = page.slice(page.indexOf(SCRIPT_START) + SCRIPT_START.length, page.lastIndexOf('</script>'))
const styleBlock = page.slice(page.indexOf('<style>\n') + '<style>\n'.length, page.lastIndexOf('</style>'))
const bodyMarkup = page.slice(page.indexOf('<body>') + '<body>'.length, page.indexOf(SCRIPT_START))

test('returns one complete, deterministic HTML document', () => {
  assert.equal(typeof page, 'string')
  assert.ok(page.startsWith('<!doctype html>'), 'starts with the HTML doctype')
  assert.ok(page.trimEnd().endsWith('</html>'), 'ends with the closing html tag')
  assert.equal(page, renderTransferPage(), 'the page is static and identical on every call')
  assert.equal(renderTransferPage.length, 0, 'renderTransferPage takes no arguments')
  assert.match(page, /<html[^>]*lang="/)
  assert.match(page, /<meta charset="utf-8">/)
  assert.ok(page.includes('<style>'), 'styles are inline')
  assert.ok(page.includes('<script>'), 'the client script is inline')
  assert.equal((page.match(/<\/style>/g) || []).length, 1)
  assert.equal((page.match(/<\/script>/g) || []).length, 1)
})

test('is mobile first: viewport, safe areas, 16px inputs and dark mode', () => {
  assert.ok(page.includes('name="viewport"'))
  assert.ok(page.includes('width=device-width'))
  assert.ok(page.includes('viewport-fit=cover'))
  assert.ok(page.includes('env(safe-area-inset-top'), 'respects the top safe area')
  assert.ok(page.includes('env(safe-area-inset-bottom'), 'respects the bottom safe area')
  assert.ok(page.includes('font-size: 16px'), '16px inputs keep iOS from zooming')
  assert.ok(page.includes('prefers-color-scheme: dark'), 'follows the system theme')
  assert.ok(page.includes('prefers-color-scheme: light'))
  assert.ok(page.includes('prefers-reduced-motion: reduce'))
})

test('loads no external resources and uses no unsafe HTML APIs', () => {
  assert.ok(!page.includes('http://'), 'no plain external URL')
  assert.ok(!page.includes('https://'), 'no secure external URL')
  assert.ok(!page.includes('<script src='), 'no external script')
  assert.ok(!page.includes('<link '), 'no external stylesheet or icon')
  assert.ok(!page.includes('@import'), 'no CSS imports')
  assert.ok(!page.includes('@font-face'), 'no webfonts')
  assert.ok(!page.includes('url('), 'no CSS url() resources')
  assert.ok(!page.includes('innerHTML'), 'user data is never injected as markup')
  assert.ok(!page.includes('insertAdjacentHTML'))
  assert.ok(!page.includes('outerHTML'))
  assert.ok(!page.includes('document.write'), 'document.write is forbidden')
  assert.ok(!/\beval\s*\(/.test(page), 'no eval')
  assert.ok(!/\bnew Function\s*\(/.test(page), 'no Function constructor')
})

test('extracts the token from the URL and builds same-origin API paths', () => {
  assert.ok(page.includes('location.pathname'), 'token comes from the current path')
  assert.ok(page.includes("new RegExp('/t/([A-Za-z0-9_-]+)/?')"), 'contract token pattern')
  assert.ok(page.includes("location.origin + '/t/' + token + '/api/state'"))
  assert.ok(page.includes("location.origin + '/t/' + token + '/api/text'"))
  assert.ok(page.includes("location.origin + '/t/' + token + '/api/upload?name='"))
  assert.ok(page.includes("location.origin + '/t/' + token + '/api/items/'"))
  assert.ok(page.includes('api/state'), 'polls the state endpoint')
  assert.ok(page.includes('api/text'), 'posts text to the text endpoint')
  assert.ok(page.includes('api/upload'), 'uploads files to the upload endpoint')
  assert.ok(page.includes('api/items/'), 'links outbox items through the items endpoint')
})

test('send pane: textarea, shortcut send, multiple files, camera capture and XHR', () => {
  assert.ok(page.includes('<textarea'), 'has a textarea')
  assert.ok(page.includes('id="sendBtn"'), 'has a send button')
  assert.ok(page.includes('event.metaKey') && page.includes('event.ctrlKey'), 'Cmd/Ctrl+Enter sends')
  assert.ok(page.includes('<input type="file"'), 'has a file input')
  assert.ok(page.includes(' multiple'), 'the file input accepts multiple files')
  assert.ok(page.includes('accept="image/*" capture="environment"'), 'camera input opens the rear camera')
  assert.ok(page.includes('XMLHttpRequest'), 'uploads use XMLHttpRequest')
  assert.ok(page.includes('xhr.upload.onprogress'), 'uploads report per-item progress')
  assert.ok(page.includes("document.createElement('progress')"), 'uploads render a progress element')
  assert.ok(page.includes("method: 'POST'"))
  assert.ok(page.includes("headers: { 'content-type': 'application/json' }"))
  assert.ok(page.includes('JSON.stringify({ text: text })'))
  assert.ok(page.includes('clearQueue'), 'the queue can be cleared')
})

test('receive pane: 2s polling paused while hidden, manual refresh and outbox rendering', () => {
  assert.ok(page.includes('POLL_INTERVAL_MS = 2000'), 'polls every two seconds')
  assert.ok(page.includes('document.hidden'), 'pauses polling in a hidden document')
  assert.ok(page.includes('visibilitychange'), 'resumes polling on visibility change')
  assert.ok(page.includes('id="refreshBtn"'), 'has a manual refresh button')
  assert.ok(page.includes('id="outboxList"'), 'has an outbox list')
  assert.ok(page.includes('renderOutbox'))
  assert.ok(page.includes("document.createElement('img')"), 'image entries are previewed with img')
  assert.ok(page.includes('apiItemUrl'), 'previews and downloads use the items endpoint')
  assert.ok(page.includes('setAttribute(\'download\''), 'file entries get a download link')
  assert.ok(page.includes('navigator.clipboard.writeText'), 'text entries copy via the Clipboard API')
  assert.ok(page.includes("document.execCommand('copy')"), 'clipboard fallback for plain-http LAN pages')
  assert.ok(page.includes("document.createElement('textarea')"), 'fallback uses a temporary textarea')
})

test('renders user content through text nodes only', () => {
  assert.ok(page.includes('.textContent ='), 'labels and user text are assigned with textContent')
  assert.ok(page.includes('createElement'), 'elements are built with createElement')
  assert.ok(!page.includes('innerHTML'))
  assert.ok(!page.includes('document.write'))
})

test('localizes all copy into English and Chinese from navigator.language', () => {
  assert.ok(page.includes('navigator.language'))
  assert.ok(page.includes("indexOf('zh') === 0"), 'zh* browsers get Chinese')
  assert.ok(page.includes('en: {') && page.includes('zh: {'), 'both dictionaries are in one place')
  assert.ok(page.includes("'Send to Mac'") && page.includes("'From Mac'"))
  assert.ok(page.includes("'Choose files'") && page.includes("'Take photo'"))
  assert.ok(page.includes("'Copy'") && page.includes("'Download'") && page.includes("'Refresh'"))
  assert.ok(page.includes("'发给 Mac'") && page.includes("'从 Mac 接收'"))
  assert.ok(page.includes("'选择文件'") && page.includes("'拍照'"))
  assert.ok(page.includes("'复制'") && page.includes("'下载'") && page.includes("'刷新'"))
})

test('announces connection, errors and status through aria-live regions', () => {
  assert.ok(page.includes('aria-live="polite"'))
  assert.ok(page.includes('aria-live="assertive"'))
  assert.ok(page.includes('role="status"'))
  assert.ok(page.includes('role="alert"'))
  assert.ok(page.includes('aria-atomic="true"'))
  assert.ok(page.includes('id="connDot"'), 'has a connection status dot')
  assert.ok(page.includes('data-state="checking"'))
})

test('explains upload limits and session expiry with a rescan prompt', () => {
  assert.ok(page.includes('status === 413'), 'handles the too-large response')
  assert.ok(page.includes('status === 404'), 'handles an invalid or expired token')
  assert.ok(page.includes('sessionExpired'), 'has an expired-session message')
  assert.ok(page.includes('fileTooLarge'), 'has a file-too-large message')
  assert.ok(page.includes('textTooLarge'), 'has a text-too-long message')
  assert.ok(page.includes('forbidden'), 'has a rejected-address message')
  assert.ok(page.includes('disabled = true'), 'disables the composer after expiry')
  assert.ok(page.includes('expiredBanner'))
  assert.ok(page.includes('重新开启手机互传'), 'tells the user to reopen the session on the Mac')
  assert.ok(page.includes('scan a new QR code'), 'tells the user to scan a new QR code')
})

test('shows the session hints required by the contract', () => {
  assert.ok(page.includes('p2pHint') && page.includes('networkHint') && page.includes('expireHint'))
  assert.ok(page.includes('same Wi-Fi'), 'network troubleshooting hint')
  assert.ok(page.includes('local Wi-Fi'), 'LAN-only transfer hint')
  assert.ok(page.includes('同一个 Wi-Fi'), 'Chinese network hint')
  assert.ok(page.includes('局域网'), 'Chinese LAN hint')
  assert.ok(page.includes('countdown'), 'shows the remaining-session countdown')
  assert.ok(page.includes('expiresAt'), 'countdown is derived from the state expiresAt')
  assert.ok(page.includes('device.name'), 'device name comes from the state payload')
})

test('is one valid document: inline JS parses, CSS braces balance, no inline handlers', () => {
  assert.doesNotThrow(() => new vm.Script(inlineScript, { filename: 'transfer-page.inline.js' }))
  const open = (styleBlock.match(/{/g) || []).length
  const close = (styleBlock.match(/}/g) || []).length
  assert.equal(open, close, 'the inline stylesheet is balanced')
  assert.ok(!/\son[a-z]+\s*=/i.test(bodyMarkup), 'event wiring is addEventListener only, never inline handlers')
  assert.ok(!/\bjavascript:/i.test(page), 'no javascript: URLs')
})

test('keeps both live regions in the accessibility tree and stacks them', () => {
  assert.ok(page.includes('<div class="toasts">'), 'the toasts share one fixed container')
  const info = /<div class="toast" id="statusInfo"[^>]*>/.exec(page)
  const alert = /<div class="toast toast-alert" id="statusAlert"[^>]*>/.exec(page)
  assert.ok(info !== null, 'polite status toast exists')
  assert.ok(alert !== null, 'assertive alert toast exists')
  assert.ok(!info[0].includes('hidden'), 'the polite live region is not display:none at load')
  assert.ok(!alert[0].includes('hidden'), 'the assertive live region is not display:none at load')
  assert.ok(page.includes('.toast[data-visible="true"]'), 'visibility is toggled with an attribute, not hidden')
  assert.ok(page.includes("setAttribute('data-visible', 'true')"))
  assert.ok(page.includes("removeAttribute('data-visible')"))
  assert.ok(page.includes('flex-direction: column'), 'simultaneous notices stack instead of overlapping')
  assert.equal((page.match(/role="alert"/g) || []).length, 1, 'the expiry banner does not double-announce')
})

test('times out state requests so a hung poll cannot wedge the page', () => {
  assert.ok(page.includes('REQUEST_TIMEOUT_MS = 12000'), 'state requests have a hard timeout')
  assert.ok(page.includes('AbortController'), 'the timeout aborts through AbortController')
  assert.ok(page.includes('controller.abort()'))
  assert.ok(page.includes('fetchWithTimeout'), 'apiFetch goes through the timeout wrapper')
  assert.ok(page.includes('pollBusy = false'), 'a failed/timed-out poll always releases the in-flight flag')
})

test('keeps text typed while a send is in flight', () => {
  assert.ok(page.includes('nodes.textInput.value === text'), 'only the sent text is cleared on success')
})

test('lets the user retry transient upload failures', () => {
  assert.ok(page.includes("retry: 'Retry'") && page.includes("retry: '重试'"), 'retry copy is bilingual')
  assert.ok(page.includes('queue-retry'), 'failed rows expose a retry button')
  assert.ok(page.includes('retryUpload'), 'retry requeues the failed file')
  assert.ok(page.includes('setRetryable(row, true)'), 'transient failures are retryable')
  assert.ok(page.includes('setRetryable(row, false)'), 'permanent failures are not retryable')
  assert.ok(page.includes('!status || status === 429 || status >= 500'), 'network/5xx failures are retryable')
})

test('queued uploads end in a terminal state when the session expires', () => {
  assert.ok(page.includes('failQueuedUploads'), 'pending rows are finalised on expiry')
  assert.ok(page.includes("setRowStatus(row, 'error', t('sessionExpired'))"), 'waiting rows show the expiry reason')
  assert.ok(page.includes('clearInterval(countdownTimer)'), 'the one-second countdown timer stops after expiry')
})

test('poll failures show actionable copy instead of a generic error', () => {
  assert.ok(page.includes("announceError(t('offline'))"), 'offline polls use the offline copy')
  assert.ok(page.includes("announceError(t('forbidden'))"), '403 (rejected host) tells the user to rescan')
  assert.ok(page.includes("announceError(t('tooManyRequests'))"), '429 explains the rate limit')
})

test('exposes a page heading and a labelled tab list', () => {
  assert.ok(page.includes('id="pageTitle"'), 'an accessible page heading exists')
  assert.ok(page.includes("setNodeText('pageTitle', t('title'))"))
  assert.ok(page.includes('id="tabs"'))
  assert.ok(page.includes("nodes.tabs.setAttribute('aria-label'"), 'the tab list has an accessible name')
  assert.ok(page.includes('event.isComposing'), 'IME composition does not trigger Cmd/Ctrl+Enter send')
})

test('keeps the zh and en dictionaries complete and in sync', () => {
  const zhStart = inlineScript.indexOf('zh: {')
  assert.ok(zhStart > 0)
  const enBlock = inlineScript.slice(inlineScript.indexOf('en: {'), zhStart)
  const zhBlock = inlineScript.slice(zhStart, inlineScript.indexOf('\n  };', zhStart))
  const keys = (block) => [...block.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*):\s*'/gm)].map((match) => match[1])
  const enKeys = keys(enBlock)
  const zhKeys = keys(zhBlock)
  assert.ok(enKeys.length > 40, 'the English dictionary is populated')
  assert.deepEqual([...enKeys].sort(), [...zhKeys].sort(), 'both dictionaries define exactly the same keys')
  assert.equal(new Set(enKeys).size, enKeys.length, 'no duplicate keys')
  // Dynamic status keys are selected by setConnection and must exist too.
  const dynamic = ['statusOnline', 'statusOffline', 'statusExpired']
  const used = new Set([...inlineScript.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]))
  for (const key of [...used, ...dynamic]) {
    assert.ok(enKeys.includes(key), `en dictionary has the key used by the page: ${key}`)
    assert.ok(zhKeys.includes(key), `zh dictionary has the key used by the page: ${key}`)
  }
  for (const key of dynamic) assert.ok(page.includes(`'${key}'`), `dynamic status key is wired: ${key}`)
})

test('renders an api/state preview with an ellipsis when the text is truncated', () => {
  const textRegion = page.slice(
    page.indexOf("if (item.kind === 'text'"),
    page.indexOf("var actions = document.createElement('div')")
  )
  assert.ok(textRegion.includes('item.textTruncated === true'), 'reads the server truncation flag')
  assert.ok(textRegion.includes("item.text + '…'"), 'the preview ends with an ellipsis')
  assert.ok(textRegion.includes('textBlock.textContent'), 'the preview is written through textContent')
  assert.ok(!textRegion.includes('innerHTML'), 'the preview is never markup')
})

test('copies truncated texts by lazily fetching the full body from api/items', () => {
  const lazyRegion = page.slice(
    page.indexOf('function copyOutboxItem'),
    page.indexOf('* 9. Sending text')
  )
  assert.ok(lazyRegion.includes('item.textTruncated !== true'), 'untruncated texts keep the old inline copy path')
  assert.ok(lazyRegion.includes('copyText(inlineText, finish)'), 'untruncated texts copy the inline body')
  assert.ok(lazyRegion.includes('apiFetchText(apiItemUrl(item.id))'), 'truncated texts fetch the items endpoint')
  assert.ok(lazyRegion.indexOf('apiFetchText(') < lazyRegion.indexOf('copyText(full, finish)'), 'the fetch completes before copying')
  assert.ok(lazyRegion.includes('.catch(reportRequestError)'), 'a failed fetch reports an error instead of copying the preview')
  assert.ok(!lazyRegion.includes('copyText(item.text'), 'the possibly-truncated text is never copied directly')
  assert.ok(lazyRegion.includes('copyText(full, finish)'), 'the fetched full text is what reaches the clipboard')
  assert.ok(lazyRegion.includes('item.textTruncated = false'), 'a fetched text is not fetched again')
  assert.ok(lazyRegion.includes('textBlock.textContent = full'), 'the preview is upgraded to the full text')
  assert.ok(lazyRegion.includes("t('copying')"), 'the button shows a loading label while fetching')
  assert.ok(lazyRegion.includes('button.disabled = true') && lazyRegion.includes('button.disabled = false'), 'the button is disabled during the fetch')
})

test('has plain-text fetch support and bilingual loading copy', () => {
  const fetchRegion = page.slice(
    page.indexOf('function apiFetchText'),
    page.indexOf('function reportRequestError')
  )
  assert.ok(fetchRegion.includes('response.text()'), 'the full item body is read as text, not JSON')
  assert.ok(fetchRegion.includes('response.status === 404'), 'an expired token aborts the lazy copy')
  assert.ok(fetchRegion.includes("headers: { accept: 'text/plain' }"), 'asks for plain text')
  assert.ok(page.includes("copying: 'Loading…'") && page.includes("copying: '加载中…'"), 'the loading label is bilingual')
  assert.ok(!page.includes('innerHTML'), 'the fetched text is never injected as markup')
})

test('downloads use the native attachment URL and previews use inline mode', () => {
  assert.ok(inlineScript.includes('function apiDownloadUrl('), 'builds a dedicated download URL')
  assert.ok(inlineScript.includes("apiItemUrl(id) + '?download=1'"), 'downloads ask the server for attachment mode')
  assert.ok(inlineScript.includes("apiItemUrl(id) + '?inline=1'"), 'thumbnails ask for inline preview mode')
  assert.ok(inlineScript.includes('image.src = apiPreviewUrl(item.id)'), 'the preview image uses inline mode')
  assert.ok(inlineScript.includes('link.href = apiDownloadUrl(item.id)'), 'the download link uses attachment mode')
  assert.ok(inlineScript.includes("link.setAttribute('download'"), 'the link also carries a download attribute')
  assert.ok(!inlineScript.includes('startDownload'), 'the download click is never intercepted, so browsers keep their download manager')
  assert.ok(!page.includes('innerHTML'), 'downloads never inject markup')
})

test('reports browser-side failures to the local diagnostics endpoint', () => {
  assert.ok(inlineScript.includes('function apiDiagUrl('), 'the diagnostics URL is same-origin')
  assert.ok(inlineScript.includes("'/api/diag'"), 'the diagnostics endpoint path is pinned')
  assert.ok(inlineScript.includes('function reportClientEvent('), 'one reporting helper exists')
  assert.ok(inlineScript.includes("addEventListener('error'"), 'uncaught page errors are reported')
  assert.ok(inlineScript.includes("addEventListener('unhandledrejection'"), 'rejected promises are reported')
  assert.ok(inlineScript.includes("reportClientEvent('upload-stalled'"), 'a stalled XHR upload is reported')
  assert.ok(inlineScript.includes("reportClientEvent('upload-timeout'"), 'an XHR timeout is reported')
  assert.ok(inlineScript.includes('keepalive: true'), 'the report survives page navigation')
})

test('survives a browser that never sends the upload body', () => {
  assert.ok(inlineScript.includes('var UPLOAD_TIMEOUT_MS'), 'XHR uploads have a hard timeout')
  assert.ok(inlineScript.includes('xhr.timeout = UPLOAD_TIMEOUT_MS'), 'the timeout is applied')
  assert.ok(inlineScript.includes('var UPLOAD_STALL_MS'), 'a stall watchdog exists')
  assert.ok(inlineScript.includes('function fallbackUpload('), 'a fetch fallback exists for stuck XHR uploads')
  assert.ok(inlineScript.includes('function uploadViaFetch('), 'the fallback posts the exact same file')
  assert.ok(inlineScript.includes('xhr.abort()'), 'a stalled request is aborted before the fallback')
  assert.ok(inlineScript.includes("reportClientEvent('upload-stalled'"), 'the stall is diagnosed')
  assert.ok(inlineScript.lastIndexOf('fallbackUpload(row, finish);') > inlineScript.indexOf('function uploadOne('), 'the fallback is wired into the upload worker')
})
