/**
 * The LAN phone-transfer server (scheme A).
 *
 * A short-lived HTTP server on the local network that lets a phone browser —
 * opened from a QR code — exchange text and files with this Mac:
 *
 * - the phone sends text (`POST …/api/text`) or raw file bytes
 *   (`POST …/api/upload?name=…`); both land in the `inbox`, and files are
 *   written to the configured directory;
 * - this Mac fills the `outbox` (`addText` / `addFile` / `addHistory`), and the
 *   phone downloads the entries through `GET …/api/items/<id>`.
 *
 * Every session is protected by a random token embedded in the URL. The token
 * is compared in constant time and a mismatch is answered with a plain 404;
 * requests whose `Host` header is not one of this session's own addresses are
 * refused with 403 (DNS-rebinding protection), and an address that keeps
 * guessing tokens is rate-limited. The server only listens while the session is
 * active and stops itself when the session expires.
 *
 * This module deliberately depends on Node built-ins only — `qr`, `notify`,
 * `copyText` and `history` are injected by the caller, so it stays testable
 * without the rest of the plugin (and without macOS tooling).
 *
 * @module dsh-mac-tools/transfer
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { hostname as systemHostname, networkInterfaces } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream'

/** HTTP headers every response carries. */
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
})

/** Content-Security-Policy for the phone page. */
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Maximum size of a text item, both inbound and outbound. */
const TEXT_LIMIT_BYTES = 64 * 1024

/** Maximum number of retained text entries per list; older ones are dropped. */
const TEXT_ENTRY_LIMIT = 200

/** Maximum file size `readInboxFile()` will load for the panel preview. */
const INBOX_PREVIEW_LIMIT_BYTES = 32 * 1024 * 1024

/** Local diagnostics log cap; it is rotated once when this size is passed. */
const DIAGNOSTICS_LOG_LIMIT_BYTES = 256 * 1024

/** Maximum size of one client-reported diagnostic body. */
const DIAGNOSTIC_REPORT_LIMIT_BYTES = 16 * 1024

/** Query value that asks for an inline (previewable) response instead of a download. */
const INLINE_PREVIEW_QUERY = 'inline'

/** Token failures allowed per address inside one window before 429. */
const TOKEN_FAILURE_LIMIT = 20

/** Sliding window for the per-address token-failure limit. */
const TOKEN_FAILURE_WINDOW_MS = 60_000

/** Maximum file-name length kept from an upload. */
const MAX_FILE_NAME_LENGTH = 120

/**
 * Maximum number of Unicode code points of a text entry included in
 * list/state responses (at most 512 user-perceived characters; surrogate
 * pairs are never split).
 *
 * The phone polls `api/state` every two seconds and the panel refreshes
 * `listInbox()` / `listOutbox()` on a timer; inlining up to 200 full 64 KiB
 * texts would make every poll a multi-megabyte response. Entries longer than
 * this are sent with a truncated `text` plus `textTruncated: true`; the full
 * text is still available through `GET /api/items/<id>` (outbox entries) and
 * `copyInboxText()` (inbox entries). The stored data is not modified.
 */
const TEXT_PREVIEW_CHARS = 512

/** Characters removed from an upload file name (path separators included). */
const FORBIDDEN_FILE_CHARACTERS = /[/\\:*?"<>|]/gu

/** Control characters removed from an upload file name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu

/** Interface prefixes never advertised in the URL list. */
const IGNORED_INTERFACE_PREFIXES = ['utun', 'awdl', 'llw', 'bridge', 'lo']

/** Extensions we can name precisely; everything else is octet-stream. */
const MIME_TYPES = Object.freeze({
  avif: 'image/avif',
  bmp: 'image/bmp',
  csv: 'text/csv',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  html: 'text/html',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  wav: 'audio/wav',
  webp: 'image/webp',
  zip: 'application/zip',
})

/**
 * A transfer-layer failure with a stable code.
 */
export class TransferError extends Error {
  /**
   * @param {'unsupported' | 'port_unavailable' | 'invalid_request' | 'too_large' | 'not_found' | 'io_error' | 'not_active'} code - stable failure code.
   * @param {string} message - human-readable diagnostic.
   * @param {object} [details] - extra, JSON-serializable context.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'TransferError'
    this.code = code
    this.details = details
  }
}

/**
 * @param {unknown} failure - thrown value.
 * @returns {string} a diagnostic message.
 */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * @param {Date} date - the instant to format.
 * @returns {string} `YYYYMMDD-HHMMSS` in local time.
 */
function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * @param {'i' | 'o'} prefix - item kind prefix.
 * @returns {string} a fresh item id such as `i-0123456789abcdef`.
 */
function newItemId(prefix) {
  return `${prefix}-${randomBytes(8).toString('hex')}`
}

/**
 * Reduce a caller-supplied upload name to a safe basename.
 *
 * Percent escapes are decoded once more (the query string has already been
 * decoded once) so `..%2Fevil.png` cannot smuggle a separator through; the
 * path is then reduced to its last segment, stripped of forbidden and control
 * characters, trimmed, and truncated while keeping the extension.
 *
 * @param {unknown} input - the decoded `name` query parameter.
 * @returns {string} a safe file name (possibly empty).
 */
function sanitizeFileName(input) {
  if (typeof input !== 'string' || input === '') return ''
  let name = input
  try {
    name = decodeURIComponent(name)
  } catch {
    // A stray `%` is not an escape; keep the text as-is.
  }
  const segments = name.split(/[/\\]/u)
  name = segments[segments.length - 1] ?? ''
  name = name.replace(CONTROL_CHARACTERS, '').replace(FORBIDDEN_FILE_CHARACTERS, '')
  name = name.replace(/^[.\s]+/u, '').replace(/[.\s]+$/u, '')
  return truncateFileName(name, MAX_FILE_NAME_LENGTH)
}

/**
 * @param {string} name - candidate file name.
 * @param {number} maxLength - maximum characters kept.
 * @returns {string} the name shortened to `maxLength`, preserving the extension.
 */
function truncateFileName(name, maxLength) {
  if (name.length <= maxLength) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  if (extension.length >= maxLength) return name.slice(0, maxLength)
  return `${stem.slice(0, maxLength - extension.length)}${extension}`
}

/**
 * @returns {string} a fallback name for uploads that sanitized down to nothing.
 */
function fallbackFileName() {
  return `upload-${formatStamp(new Date())}.bin`
}

/**
 * Pick a name that is not yet used inside a directory.
 *
 * @param {string} directory - destination directory.
 * @param {string} name - sanitized name.
 * @returns {string} `name`, or `name (1)`, `name (2)`, … before the extension.
 */
function availableFileName(directory, name) {
  if (!existsSync(join(directory, name))) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = `${stem} (${index})${extension}`
    if (!existsSync(join(directory, candidate))) return candidate
  }
  return `${stem} (${Date.now()})${extension}`
}

/**
 * Move a completed upload into place without ever overwriting an existing file.
 *
 * A plain `rename()` silently replaces its target on POSIX, so two writers that
 * chose the same name would lose one file. A hard link to the temporary file
 * fails atomically with `EEXIST` instead; the link is then dropped and the next
 * free name is tried. Filesystems without hard-link support (SMB/exFAT shares)
 * fall back to rename after one last existence check.
 *
 * @param {string} tempPath - finished temporary upload inside `directory`.
 * @param {string} directory - destination directory.
 * @param {string} requestedName - sanitized preferred name.
 * @returns {string} the final name written inside `directory`.
 * @throws {TransferError} `io_error` when no name could be claimed.
 */
function placeUpload(tempPath, directory, requestedName) {
  let candidate = availableFileName(directory, requestedName)
  for (let attempt = 0; attempt <= 1000; attempt += 1) {
    const target = join(directory, candidate)
    try {
      linkSync(tempPath, target)
    } catch (failure) {
      const code = failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : ''
      if (code === 'EEXIST' || existsSync(target)) {
        candidate = availableFileName(directory, requestedName)
        continue
      }
      // Hard links may be unsupported on this volume; fall back to rename.
      renameSync(tempPath, target)
      return candidate
    }
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // The upload is in place; a leftover temporary file is harmless.
    }
    return candidate
  }
  throw new TransferError(
    'io_error',
    `could not find a free name for the upload ${JSON.stringify(requestedName)}`,
    { name: requestedName },
  )
}

/**
 * @param {string} name - file name.
 * @returns {string} its MIME type.
 */
function mimeForFile(name) {
  const extension = extname(name).slice(1).toLowerCase()
  return MIME_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Raster image types every phone browser renders inside an `<img>` element.
 * SVG is deliberately absent: it can carry script, and the panel renders
 * `previewable` entries with a plain `<img>` tag.
 */
const PREVIEWABLE_IMAGE_MIME_TYPES = Object.freeze(new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]))

/**
 * @param {string} mime - MIME type.
 * @returns {boolean} whether the phone can preview it as an image.
 */
function isImageMime(mime) {
  return typeof mime === 'string' && mime.startsWith('image/')
}

/**
 * @param {string} mime - MIME type.
 * @returns {boolean} whether the panel may safely preview it in an `<img>`.
 */
function isPreviewableMime(mime) {
  return typeof mime === 'string' && PREVIEWABLE_IMAGE_MIME_TYPES.has(mime.toLowerCase())
}

/**
 * Build an ASCII-only fallback file name for the `filename=` parameter.
 *
 * Older Android browsers and some download managers ignore RFC 5987
 * `filename*=UTF-8''…` and use this plain parameter instead, so it must never
 * contain quotes, backslashes or non-ASCII characters.
 *
 * @param {string} name - the original file name.
 * @returns {string} a header-safe fallback.
 */
function asciiFileName(name) {
  const cleaned = typeof name === 'string'
    ? name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_').trim()
    : ''
  return cleaned === '' ? 'download' : cleaned
}

/**
 * Build one `Content-Disposition` header carrying both a plain and an RFC 5987
 * file name, so every phone browser can name the saved file.
 *
 * @param {'inline' | 'attachment'} kind - disposition type.
 * @param {string} name - the original file name.
 * @returns {string} the header value.
 */
function contentDispositionHeader(kind, name) {
  const fallback = asciiFileName(name)
  const encoded = encodeURIComponent(name === '' ? fallback : name).replace(/'/gu, '%27')
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * @param {object} item - stored outbox entry.
 * @returns {object} the entry as exposed to the phone (no absolute path).
 */
function publicOutboxItem(item) {
  const copy = { ...item }
  delete copy.path
  return copy
}

/**
 * Take the first `maxCodePoints` Unicode code points of a string without
 * splitting a surrogate pair (which would render as a replacement character).
 *
 * @param {string} text - source text.
 * @param {number} maxCodePoints - maximum number of code points kept.
 * @returns {string} a prefix that never ends on a lone high surrogate.
 */
function codePointPrefix(text, maxCodePoints) {
  if (text.length <= maxCodePoints) return text
  let index = 0
  let count = 0
  while (index < text.length && count < maxCodePoints) {
    const code = text.charCodeAt(index)
    index += 1
    if (code >= 0xd800 && code <= 0xdbff && index < text.length) {
      const next = text.charCodeAt(index)
      if (next >= 0xdc00 && next <= 0xdfff) index += 1
    }
    count += 1
  }
  return text.slice(0, index)
}

/**
 * Copy a stored entry for a polling response, bounding the inline text.
 *
 * See {@link TEXT_PREVIEW_CHARS}: long texts carry only their first 512 code
 * points and `textTruncated: true`; short texts (and non-text entries) are
 * copied unchanged without the marker. The stored entry keeps the full text.
 *
 * @param {object} item - stored inbox/outbox entry.
 * @returns {object} a shallow copy safe for list/state responses.
 */
function withTextPreview(item) {
  const copy = { ...item }
  if (item.kind === 'text' && typeof item.text === 'string' && item.text.length > TEXT_PREVIEW_CHARS) {
    copy.text = codePointPrefix(item.text, TEXT_PREVIEW_CHARS)
    copy.textTruncated = true
  }
  return copy
}

/**
 * Constant-time token comparison. Both sides are hashed first so even the
 * comparison length does not depend on the presented token.
 *
 * @param {string | null} expected - the session token.
 * @param {string} provided - the token from the URL.
 * @returns {boolean} whether the tokens match.
 */
function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || expected === '' || typeof provided !== 'string') return false
  const left = createHash('sha256').update(expected).digest()
  const right = createHash('sha256').update(provided).digest()
  return timingSafeEqual(left, right)
}

/**
 * @param {string | undefined} address - `req.socket.remoteAddress`.
 * @returns {string} a stable per-client key.
 */
function normalizeRemote(address) {
  if (typeof address !== 'string' || address === '') return 'unknown'
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

/**
 * @param {string} name - network interface name.
 * @returns {boolean} whether the interface should never be advertised.
 */
function isIgnoredInterface(name) {
  return IGNORED_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Read a bounded request body.
 *
 * Over-limit bytes are drained and discarded so the client still receives a
 * readable 413 response instead of a reset connection.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} limit - maximum accepted bytes.
 * @returns {Promise<Buffer>} the body.
 * @throws {TransferError} `too_large` past the limit, `io_error` on abort.
 */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let overflow = false
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > limit) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) {
        reject(new TransferError('too_large', `the request body exceeds the ${limit} byte limit`, { limit }))
        return
      }
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (failure) => {
      reject(new TransferError('io_error', `could not read the request body: ${failureMessage(failure)}`))
    })
  })
}

/**
 * Wait for a writable stream to drain, rejecting when it errors.
 *
 * @param {import('node:fs').WriteStream} stream - the destination stream.
 * @returns {Promise<void>} resolves once writing may continue.
 */
function drainWritable(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('drain', onDrain)
      stream.removeListener('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (failure) => {
      cleanup()
      reject(failure)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

/**
 * Destroy a writable stream and wait until its file handle is closed, so the
 * caller can safely unlink the (possibly never-written) temporary file.
 *
 * @param {import('node:fs').WriteStream} stream - the stream to close.
 * @returns {Promise<void>} resolves once the stream is closed.
 */
function closeWritable(stream) {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve()
      return
    }
    stream.once('close', () => resolve())
    stream.destroy()
  })
}

/**
 * Stream an upload body into `filePath`, enforcing the size limit.
 *
 * Bytes past the limit are drained but not written; the request is fully
 * consumed so the caller can still answer 413 on a healthy connection.
 *
 * @param {import('node:http').IncomingMessage} req - the upload request.
 * @param {string} filePath - temporary destination path.
 * @param {number} limit - maximum accepted bytes.
 * @returns {Promise<number>} the number of bytes written.
 * @throws {TransferError} `too_large` past the limit, `io_error` on failure.
 */
async function streamUploadToFile(req, filePath, limit) {
  const output = createWriteStream(filePath, { mode: 0o600 })
  let streamFailure = null
  output.on('error', (failure) => {
    streamFailure = failure
  })
  let bytes = 0
  let overflow = false
  try {
    for await (const chunk of req) {
      bytes += chunk.length
      if (overflow || bytes > limit) {
        overflow = true
        continue
      }
      if (streamFailure !== null) throw streamFailure
      if (!output.write(chunk)) await drainWritable(output)
    }
    if (overflow) {
      throw new TransferError('too_large', `the upload exceeds the ${limit} byte limit`, { limit })
    }
    if (streamFailure !== null) throw streamFailure
    await new Promise((resolve, reject) => {
      output.once('error', reject)
      output.end(() => {
        output.removeListener('error', reject)
        resolve(undefined)
      })
    })
    return bytes
  } catch (failure) {
    await closeWritable(output)
    if (failure instanceof TransferError) throw failure
    throw new TransferError('io_error', `could not store the upload: ${failureMessage(failure)}`)
  }
}

/**
 * @param {object} item - stored entry.
 * @param {'inbox' | 'outbox'} list - the list it belongs to.
 * @returns {boolean} whether the entry survived a reload.
 */
function isValidStoredItem(item, list) {
  if (item === null || typeof item !== 'object') return false
  const kinds = list === 'inbox' ? ['text', 'file'] : ['text', 'file', 'history']
  if (!kinds.includes(item.kind)) return false
  if (typeof item.id !== 'string' || item.id === '') return false
  if (typeof item.name !== 'string') return false
  if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0) return false
  if (typeof item.mime !== 'string') return false
  if (typeof item.createdAt !== 'string') return false
  if (item.kind === 'text' && typeof item.text !== 'string') return false
  if (item.kind === 'file' && (typeof item.path !== 'string' || item.path === '' || !existsSync(item.path))) return false
  if (item.kind === 'history' && typeof item.historyId !== 'string') return false
  return true
}

/** Minimal phone page served when the caller injects no renderer. */
const FALLBACK_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DSH Phone Transfer</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--fg:#1d1d1f;--card:#fff;--accent:#0a84ff;--muted:#6e6e73}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--card:#2c2c2e;--muted:#98989d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,system-ui,sans-serif;padding:16px calc(16px + env(safe-area-inset-right)) 32px calc(16px + env(safe-area-inset-left))}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}p{margin:4px 0}.muted{color:var(--muted);font-size:13px}
section{background:var(--card);border-radius:12px;padding:14px;margin:12px 0}
textarea,input{width:100%;font:inherit;padding:10px;border-radius:8px;border:1px solid #8884;background:transparent;color:inherit}
button{margin-top:8px;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit}
button:disabled{opacity:.5}ul{list-style:none;padding:0;margin:0}li{padding:8px 0;border-top:1px solid #8883;font-size:14px}
li a{color:var(--accent);text-decoration:none}
</style>
</head>
<body>
<header><h1>DSH Phone Transfer</h1><p class="muted" id="device"></p><p class="muted" id="expiry"></p></header>
<p id="status" aria-live="polite" class="muted"></p>
<section><h2>Send to Mac</h2><textarea id="text" rows="4" placeholder="Type or paste text"></textarea>
<button id="send" type="button">Send text</button>
<label class="muted" style="display:block;margin-top:12px">Files / photos<input id="file" type="file" multiple style="margin-top:6px"></label></section>
<section><h2>From Mac</h2><button id="refresh" type="button">Refresh</button><ul id="items"></ul></section>
<script>
(function () {
  'use strict';
  var match = /^\\/t\\/([A-Za-z0-9_-]+)\\/?/.exec(location.pathname);
  var token = match ? match[1] : '';
  var statusNode = document.getElementById('status');
  var itemsNode = document.getElementById('items');
  function api(path) { return '/t/' + token + '/' + path; }
  function say(message) { statusNode.textContent = message; }
  function formatSize(bytes) { if (bytes < 1024) return bytes + ' B'; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'; return (bytes / 1048576).toFixed(1) + ' MB'; }
  function renderItem(item) {
    var row = document.createElement('li');
    var name = document.createElement('div');
    name.textContent = item.name;
    row.appendChild(name);
    var link = document.createElement('a');
    link.href = 'api/items/' + encodeURIComponent(item.id);
    link.textContent = item.kind === 'text' ? 'Download text' : 'Download (' + formatSize(item.size) + ')';
    row.appendChild(link);
    if (item.kind === 'text' && typeof item.text === 'string') {
      var preview = document.createElement('div');
      preview.className = 'muted';
      preview.textContent = item.text.slice(0, 280);
      row.appendChild(preview);
    }
    itemsNode.appendChild(row);
  }
  function refresh() {
    return fetch(api('api/state'), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }).then(function (state) {
      document.getElementById('device').textContent = state.device && state.device.name ? 'Device: ' + state.device.name : '';
      document.getElementById('expiry').textContent = state.expiresAt ? 'Session ends ' + new Date(state.expiresAt).toLocaleTimeString() : '';
      itemsNode.textContent = '';
      var items = state.outbox && state.outbox.items ? state.outbox.items : [];
      items.forEach(renderItem);
      if (items.length === 0) {
        var empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'Nothing from the Mac yet.';
        itemsNode.appendChild(empty);
      }
    }).catch(function (failure) { say('Could not reach the Mac: ' + failure.message); });
  }
  function sendText() {
    var text = document.getElementById('text').value;
    if (!text) { say('Type something first.'); return; }
    fetch(api('api/text'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text }) }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      document.getElementById('text').value = '';
      say('Text sent.');
    }).catch(function (failure) { say('Send failed: ' + failure.message); });
  }
  function uploadFiles(files) {
    var index = 0;
    function next() {
      if (index >= files.length) return;
      var file = files[index];
      index += 1;
      say('Sending ' + file.name + '...');
      fetch(api('api/upload?name=' + encodeURIComponent(file.name)), { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        say('Sent ' + file.name + '.');
        next();
      }).catch(function (failure) { say('Upload failed: ' + failure.message); });
    }
    next();
  }
  document.getElementById('send').addEventListener('click', sendText);
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('file').addEventListener('change', function (event) {
    uploadFiles(event.target.files || []);
    event.target.value = '';
  });
  if (!token) { say('This page needs a transfer link; scan the QR code again.'); }
  else { refresh(); setInterval(refresh, 2000); }
}());
</script>
</body>
</html>
`

/**
 * One phone-transfer session: an HTTP listener, an inbox, an outbox and the
 * persisted index behind both.
 */
export class TransferServer {
  /**
   * @param {object} options - server options.
   * @param {string} options.directory - absolute directory that receives phone uploads.
   * @param {string} options.stateDirectory - absolute directory that holds `index.json`.
   * @param {number} [options.port] - preferred port; `0` picks a random one.
   * @param {string} [options.bindHost] - address to listen on.
   * @param {number} [options.sessionMinutes] - session lifetime in minutes.
   * @param {number} [options.maxFileBytes] - largest accepted upload.
   * @param {boolean} [options.autoCopyText] - copy received phone text to the clipboard.
   * @param {string} [options.hostName] - this Mac's name, shown to the phone.
   * @param {(text: string) => Promise<string>} [options.qr] - QR encoder for the main URL.
   * @param {(message: { title: string, body: string }) => Promise<void>} [options.notify] - best-effort notification sink.
   * @param {(text: string) => Promise<void>} [options.copyText] - best-effort clipboard writer.
   * @param {object} [options.history] - screenshot history store (`get` / `read`).
   * @param {boolean} [options.keepAwake] - keep the Mac awake while the session runs.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {string | (() => (string | Promise<string>))} [options.page] - phone page renderer injection.
   */
  constructor({
    directory,
    stateDirectory,
    port = 8791,
    bindHost = '0.0.0.0',
    sessionMinutes = 30,
    maxFileBytes = 512 * 1024 * 1024,
    autoCopyText = false,
    hostName = systemHostname(),
    qr = undefined,
    notify = undefined,
    copyText = undefined,
    history = undefined,
    keepAwake = true,
    warn = () => {},
    page = undefined,
  } = {}) {
    if (typeof directory !== 'string' || directory === '') {
      throw new TransferError('invalid_request', 'the transfer directory is required')
    }
    if (typeof stateDirectory !== 'string' || stateDirectory === '') {
      throw new TransferError('invalid_request', 'the transfer state directory is required')
    }
    this.directory = directory
    this.stateDirectory = stateDirectory
    this.indexPath = join(stateDirectory, 'index.json')
    /** Bounded local diagnostics log (client errors + transfer request summaries). */
    this.diagnosticsPath = join(stateDirectory, 'diagnostics.log')
    this.preferredPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 8791
    this.bindHost = typeof bindHost === 'string' && bindHost !== '' ? bindHost : '0.0.0.0'
    this.sessionMinutes = Number.isFinite(sessionMinutes) && sessionMinutes > 0 ? Number(sessionMinutes) : 30
    this.maxFileBytes = Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? Math.floor(Number(maxFileBytes)) : 512 * 1024 * 1024
    this.autoCopyText = autoCopyText === true
    this.hostName = typeof hostName === 'string' && hostName !== '' ? hostName : systemHostname()
    this.qr = typeof qr === 'function' ? qr : undefined
    this.notify = typeof notify === 'function' ? notify : undefined
    this.copyText = typeof copyText === 'function' ? copyText : undefined
    this.history = history !== undefined && history !== null ? history : undefined
    this.keepAwake = keepAwake === true
    this.warn = typeof warn === 'function' ? warn : () => {}
    this.page = page

    /** @type {import('node:http').Server | null} */
    this.server = null
    /** @type {import('node:child_process').ChildProcess | null} */
    this.caffeinate = null
    /** @type {NodeJS.Timeout | null} */
    this.expiryTimer = null
    /** @type {Promise<object> | null} */
    this.startPromise = null
    /** @type {string | null} */
    this.token = null
    /** @type {number | null} */
    this.port = null
    /** @type {string | null} */
    this.url = null
    /** @type {string[]} */
    this.urls = []
    /** @type {Set<string>} */
    this.allowedHosts = new Set()
    /** @type {string | null} */
    this.qrPngBase64 = null
    /** @type {string | null} */
    this.qrError = null
    /** @type {string | null} */
    this.startedAt = null
    /** @type {string | null} */
    this.expiresAt = null
    /** @type {string[]} */
    this.warnings = []
    this.disposed = false
    /** Monotonic epoch: bumped by `stop()` so an in-flight `start()` can notice it was cancelled. */
    this.sessionGeneration = 0
    /** Epoch the currently pending `start()` was launched in. */
    this.startGeneration = 0
    /** @type {Map<string, number[]>} recent token failures per client address. */
    this.tokenFailures = new Map()
    /** @type {object[]} newest first. */
    this.inbox = []
    /** @type {object[]} newest first. */
    this.outbox = []

    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
    } catch (failure) {
      throw new TransferError('io_error', `could not prepare the transfer directories: ${failureMessage(failure)}`)
    }
    this.load()
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Start a session. Idempotent while active (the token never changes).
   *
   * A `stop()`/`dispose()` that lands while a start is still binding its
   * listener or compiling the QR code cancels that start: the freshly created
   * listener is closed again and the settled status is inactive.
   *
   * @returns {Promise<object>} the settled status.
   * @throws {TransferError} `port_unavailable`, `io_error` or `not_active`.
   */
  async start() {
    if (this.disposed) throw new TransferError('not_active', 'the transfer server has been disposed')
    if (this.isActive()) return this.status()
    if (this.startPromise !== null) {
      if (this.startGeneration === this.sessionGeneration) return this.startPromise
      // The pending start was cancelled by stop()/dispose(); let it unwind and
      // then honour this newer call instead of returning its inactive result.
      try {
        await this.startPromise
      } catch {
        // The cancelled attempt's failure is no longer interesting.
      }
      return this.start()
    }
    this.startPromise = this.startSession()
    this.startGeneration = this.sessionGeneration
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  /**
   * @returns {Promise<object>} the settled status.
   */
  async startSession() {
    this.stop()
    const generation = this.sessionGeneration
    const token = randomBytes(18).toString('base64url')
    let listening
    try {
      listening = await this.listen()
    } catch (failure) {
      throw failure instanceof TransferError
        ? failure
        : new TransferError('io_error', `could not start the transfer server: ${failureMessage(failure)}`)
    }
    if (generation !== this.sessionGeneration) {
      // stop()/dispose() ran while the listener was binding: never revive it.
      try {
        listening.server.close()
      } catch {
        // The stale listener is already closed.
      }
      return this.abandonedStart()
    }
    this.server = listening.server
    this.port = listening.port
    this.token = token
    try {
      this.buildUrls()
      // Publish a complete active snapshot before the (possibly slow) QR step:
      // the panel polls transferStatus while a first session compiles Swift, and
      // an active status with a null expiry would confuse its countdown.
      this.startedAt = new Date().toISOString()
      this.expiresAt = new Date(Date.now() + this.sessionMinutes * 60_000).toISOString()
      this.expiryTimer = setTimeout(() => {
        this.stop()
      }, this.sessionMinutes * 60_000)
      this.expiryTimer.unref?.()
      if (this.keepAwake && process.platform === 'darwin') this.startCaffeinate()
      let qrPngBase64 = null
      let qrError = null
      try {
        if (this.qr !== undefined) {
          const encoded = await this.qr(this.url)
          qrPngBase64 = typeof encoded === 'string' && encoded !== '' ? encoded : null
          if (qrPngBase64 === null) qrError = 'the QR helper returned no image'
        }
      } catch (failure) {
        qrPngBase64 = null
        qrError = failureMessage(failure)
      }
      if (generation !== this.sessionGeneration) return this.abandonedStart()
      this.qrPngBase64 = qrPngBase64
      this.qrError = qrError
    } catch (failure) {
      this.stop()
      throw failure instanceof TransferError
        ? failure
        : new TransferError('io_error', `could not start the transfer session: ${failureMessage(failure)}`)
    }
    return this.status()
  }

  /**
   * Tear down resources of a start that was cancelled by `stop()`/`dispose()`.
   *
   * @returns {object} the inactive status.
   * @throws {TransferError} `not_active` when the server has been disposed.
   */
  abandonedStart() {
    this.stop()
    if (this.disposed) throw new TransferError('not_active', 'the transfer server has been disposed')
    return this.status()
  }

  /**
   * Bind the HTTP listener, walking up to ten ports when the preferred one is
   * taken.
   *
   * @returns {Promise<{ server: import('node:http').Server, port: number }>} the listening server.
   * @throws {TransferError} `port_unavailable` or `io_error`.
   */
  async listen() {
    const preferred = this.preferredPort
    const attempts = preferred === 0
      ? [0]
      : Array.from({ length: 10 }, (_value, index) => preferred + index).filter((candidate) => candidate <= 65_535)
    let lastFailure
    for (const attempt of attempts) {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      try {
        const port = await new Promise((resolve, reject) => {
          const onError = (failure) => {
            server.removeListener('listening', onListening)
            reject(failure)
          }
          const onListening = () => {
            server.removeListener('error', onError)
            const address = server.address()
            resolve(address !== null && typeof address === 'object' ? address.port : attempt)
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(attempt, this.bindHost)
        })
        // A 512 MB upload over slow Wi-Fi easily outlives Node's 300 s default
        // request timeout. The session itself is the real bound (its expiry
        // timer closes every connection), so give a request the whole session
        // plus a minute instead of aborting a legitimate upload early.
        server.requestTimeout = Math.floor(this.sessionMinutes * 60_000) + 60_000
        // Browsers reuse keep-alive connections across the 2 s polling gap. The
        // Node default (5 s) lets the server close a socket at almost the same
        // moment a phone sends its next request, which some Android browser
        // builds surface as a request that never makes progress. Keep the
        // connection comfortably longer than any poll interval, and keep
        // headersTimeout above it as Node requires.
        server.keepAliveTimeout = 65_000
        server.headersTimeout = 66_000
        server.on('error', (failure) => {
          this.warn('transfer server error', failure)
        })
        return { server, port }
      } catch (failure) {
        lastFailure = failure
        try {
          server.close()
        } catch {
          // The failed server has no resources left to release.
        }
        const code = failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : ''
        if (code !== 'EADDRINUSE') {
          throw new TransferError('io_error', `could not listen on ${this.bindHost}:${attempt}: ${failureMessage(failure)}`, { port: attempt })
        }
      }
    }
    const detail = failureMessage(lastFailure)
    throw new TransferError(
      'port_unavailable',
      `could not find a free port in ${preferred}..${preferred + 9}: ${detail}`,
      { port: preferred, attempts: attempts.length },
    )
  }

  /** Stop the session. Safe to call repeatedly. */
  stop() {
    // Invalidate any start() that is still awaiting the listener or the QR code.
    this.sessionGeneration += 1
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    const server = this.server
    this.server = null
    this.token = null
    this.port = null
    this.url = null
    this.urls = []
    this.allowedHosts = new Set()
    this.qrPngBase64 = null
    this.qrError = null
    this.startedAt = null
    this.expiresAt = null
    this.warnings = []
    this.tokenFailures.clear()
    if (this.caffeinate !== null) {
      try {
        this.caffeinate.kill('SIGTERM')
      } catch {
        // The child already exited.
      }
      this.caffeinate = null
    }
    if (server !== null) {
      try {
        server.closeAllConnections?.()
      } catch {
        // Not every Node build exposes the helper; close() still stops accept.
      }
      try {
        server.close()
      } catch {
        // The listener was already closed.
      }
    }
  }

  /** Stop the session and refuse to start again (plugin unload). */
  dispose() {
    this.disposed = true
    this.stop()
  }

  /** @returns {boolean} whether a session is listening right now. */
  isActive() {
    return this.server !== null && this.server.listening && typeof this.token === 'string'
  }

  /**
   * @returns {object} the JSON-serializable session status.
   */
  status() {
    const active = this.isActive()
    return {
      active,
      directory: this.directory,
      maxFileMB: this.maxFileBytes / (1024 * 1024),
      sessionMinutes: this.sessionMinutes,
      autoCopyText: this.autoCopyText,
      inboxCount: this.inbox.length,
      outboxCount: this.outbox.length,
      url: active ? this.url : null,
      urls: active ? [...this.urls] : [],
      port: active ? this.port : null,
      token: active ? this.token : null,
      qrPngBase64: active ? this.qrPngBase64 : null,
      qrError: active ? this.qrError : null,
      startedAt: active ? this.startedAt : null,
      expiresAt: active ? this.expiresAt : null,
      warnings: active ? [...this.warnings] : [],
    }
  }

  /** Spawn `caffeinate` so the session survives display sleep on macOS. */
  startCaffeinate() {
    try {
      // `-w <pid>` makes caffeinate release its assertion when this Host
      // process exits, so a crash cannot leave the Mac awake forever.
      const child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' })
      child.on('error', (failure) => {
        this.warn('could not keep the Mac awake', failure)
      })
      child.unref?.()
      this.caffeinate = child
    } catch (failure) {
      this.warn('could not keep the Mac awake', failure)
    }
  }

  /**
   * Compute the URL list and the allowed `Host` values for this session.
   */
  buildUrls() {
    const port = this.port
    const warnings = []
    const addresses = []
    let interfaces = {}
    try {
      interfaces = networkInterfaces()
    } catch (failure) {
      this.warn('could not enumerate the network interfaces', failure)
    }
    for (const [name, entries] of Object.entries(interfaces)) {
      if (isIgnoredInterface(name) || !Array.isArray(entries)) continue
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        if (entry.family !== 'IPv4' && entry.family !== 4) continue
        if (entry.internal === true) continue
        if (typeof entry.address !== 'string' || entry.address === '') continue
        const priority = name === 'en0' ? 0 : name === 'en1' ? 1 : 2
        addresses.push({ address: entry.address, priority })
      }
    }
    addresses.sort((left, right) => left.priority - right.priority)
    const localName = this.hostName.endsWith('.local') ? this.hostName : `${this.hostName}.local`
    const loopbackUrl = `http://127.0.0.1:${port}/t/${this.token}/`
    /** @type {string[]} */
    const urls = []
    if (addresses.length === 0) {
      warnings.push('No local network address was found; the session URL only works on this Mac.')
      urls.push(loopbackUrl)
    } else {
      for (const entry of addresses) {
        const url = `http://${entry.address}:${port}/t/${this.token}/`
        if (!urls.includes(url)) urls.push(url)
      }
      const localUrl = `http://${localName}:${port}/t/${this.token}/`
      if (!urls.includes(localUrl)) urls.push(localUrl)
    }
    this.url = urls[0]
    this.urls = urls
    this.warnings = warnings
    const hosts = new Set()
    for (const entry of addresses) hosts.add(`${entry.address.toLowerCase()}:${port}`)
    hosts.add(`${localName.toLowerCase()}:${port}`)
    hosts.add(`localhost:${port}`)
    hosts.add(`127.0.0.1:${port}`)
    this.allowedHosts = hosts
  }

  // -------------------------------------------------------------------- store

  /** Read the persisted index, dropping file entries whose file vanished. */
  load() {
    let document
    try {
      document = JSON.parse(readFileSync(this.indexPath, 'utf8'))
    } catch (failure) {
      this.inbox = []
      this.outbox = []
      // A missing index is normal on first run; unreadable or corrupt JSON is
      // worth reporting because the next save will replace it with an empty one.
      const code = failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : ''
      if (code !== 'ENOENT') this.warn('could not read the transfer index; starting with an empty list', failure)
      return
    }
    const storedInbox = document !== null && typeof document === 'object' && Array.isArray(document.inbox) ? document.inbox : []
    const storedOutbox = document !== null && typeof document === 'object' && Array.isArray(document.outbox) ? document.outbox : []
    const normalize = (item, list) => {
      if (!isValidStoredItem(item, list)) return null
      return {
        id: item.id,
        kind: item.kind,
        name: item.name,
        size: item.size,
        mime: item.mime,
        createdAt: item.createdAt,
        previewable: isPreviewableMime(item.mime),
        ...(item.kind === 'text' ? { text: item.text } : {}),
        ...(item.kind === 'file' ? { path: item.path } : {}),
        ...(item.kind === 'history' ? { historyId: item.historyId } : {}),
      }
    }
    this.inbox = storedInbox.map((item) => normalize(item, 'inbox')).filter((item) => item !== null)
    this.outbox = storedOutbox.map((item) => normalize(item, 'outbox')).filter((item) => item !== null)
    this.trimTextEntries(this.inbox)
    this.trimTextEntries(this.outbox)
  }

  /** Write the index atomically (0600). Persistence failures are reported, not thrown. */
  save() {
    const payload = `${JSON.stringify({ version: 1, inbox: this.inbox, outbox: this.outbox }, null, 2)}\n`
    const temporary = `${this.indexPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      writeFileSync(temporary, payload, { mode: 0o600 })
      renameSync(temporary, this.indexPath)
    } catch (failure) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The temporary file was never created.
      }
      this.warn('could not persist the transfer index', failure)
    }
  }

  /**
   * Keep at most {@link TEXT_ENTRY_LIMIT} text entries in a list, dropping the
   * oldest ones. File and history entries are never auto-deleted.
   *
   * @param {object[]} list - inbox or outbox.
   */
  trimTextEntries(list) {
    let seen = 0
    for (let index = 0; index < list.length; index += 1) {
      if (list[index].kind !== 'text') continue
      seen += 1
      if (seen > TEXT_ENTRY_LIMIT) {
        list.splice(index, 1)
        index -= 1
      }
    }
  }

  /**
   * @param {string} id - inbox item id.
   * @returns {object} the stored item.
   * @throws {TransferError} `not_found` for unknown ids.
   */
  findInbox(id) {
    const item = this.inbox.find((entry) => entry.id === id)
    if (item === undefined) throw new TransferError('not_found', `unknown inbox item ${JSON.stringify(id)}`, { id })
    return item
  }

  /**
   * @param {string} id - outbox item id.
   * @returns {object | undefined} the stored item.
   */
  findOutbox(id) {
    return this.outbox.find((entry) => entry.id === id)
  }

  // ------------------------------------------------------------ public inbox

  /** @returns {{ items: object[], count: number }} the inbox, newest first. */
  listInbox() {
    return { items: this.inbox.map((item) => withTextPreview(item)), count: this.inbox.length }
  }

  /** @returns {{ items: object[], count: number }} the outbox, newest first. */
  listOutbox() {
    return { items: this.outbox.map((item) => withTextPreview(item)), count: this.outbox.length }
  }

  /**
   * Delete every inbox record and every received file.
   *
   * @returns {{ cleared: number }} how many entries were removed.
   */
  clearInbox() {
    const cleared = this.inbox.length
    for (const item of this.inbox) {
      if (item.kind === 'file' && typeof item.path === 'string') {
        try {
          rmSync(item.path, { force: true })
        } catch (failure) {
          this.warn('could not delete a received file', failure)
        }
      }
    }
    this.inbox = []
    this.save()
    return { cleared }
  }

  /**
   * Delete one inbox entry (and its file, when it is a file).
   *
   * @param {string} id - item id.
   * @returns {{ deleted: boolean, id: string }} whether it existed.
   */
  deleteInbox(id) {
    const index = this.inbox.findIndex((item) => item.id === id)
    if (index === -1) return { deleted: false, id }
    const [item] = this.inbox.splice(index, 1)
    if (item.kind === 'file' && typeof item.path === 'string') {
      try {
        rmSync(item.path, { force: true })
      } catch (failure) {
        this.warn('could not delete a received file', failure)
      }
    }
    this.save()
    return { deleted: true, id }
  }

  /**
   * Copy an inbox text entry to the macOS clipboard.
   *
   * @param {string} id - item id.
   * @returns {Promise<{ copied: true, bytes: number }>} the copied size.
   * @throws {TransferError} `not_found`, `invalid_request` or `unsupported`.
   */
  async copyInboxText(id) {
    const item = this.findInbox(id)
    if (item.kind !== 'text' || typeof item.text !== 'string') {
      throw new TransferError('invalid_request', 'only text items can be copied', { id, kind: item.kind })
    }
    if (this.copyText === undefined) {
      throw new TransferError('unsupported', 'the clipboard is not available in this build')
    }
    try {
      await this.copyText(item.text)
    } catch (failure) {
      throw new TransferError('io_error', `could not copy the text: ${failureMessage(failure)}`, { id })
    }
    return { copied: true, bytes: Buffer.byteLength(item.text, 'utf8') }
  }

  /**
   * Reveal an inbox file in Finder.
   *
   * @param {string} id - item id.
   * @returns {{ revealed: true, path: string }} the revealed path.
   * @throws {TransferError} `not_found` or `invalid_request`.
   */
  revealInbox(id) {
    const item = this.findInbox(id)
    if (item.kind !== 'file' || typeof item.path !== 'string') {
      throw new TransferError('invalid_request', 'only file items can be revealed', { id, kind: item.kind })
    }
    if (!existsSync(item.path)) throw new TransferError('not_found', 'the received file no longer exists', { id, path: item.path })
    try {
      const child = spawn('/usr/bin/open', ['-R', item.path], { stdio: 'ignore', detached: true })
      child.on('error', () => {})
      child.unref?.()
    } catch (failure) {
      throw new TransferError('io_error', `could not reveal the file: ${failureMessage(failure)}`, { id })
    }
    return { revealed: true, path: item.path }
  }

  /**
   * Read an inbox file for the panel preview (bounded to 32 MiB).
   *
   * @param {string} id - item id.
   * @returns {{ buffer: Buffer, mime: string, name: string }} the bytes and metadata.
   * @throws {TransferError} `not_found`, `invalid_request` or `too_large`.
   */
  readInboxFile(id) {
    const item = this.findInbox(id)
    if (item.kind !== 'file' || typeof item.path !== 'string') {
      throw new TransferError('invalid_request', 'only file items can be read', { id, kind: item.kind })
    }
    let stats
    try {
      stats = statSync(item.path)
    } catch {
      throw new TransferError('not_found', 'the received file no longer exists', { id })
    }
    if (stats.size > INBOX_PREVIEW_LIMIT_BYTES) {
      throw new TransferError('too_large', 'the received file is too large to preview', { id, size: stats.size, limit: INBOX_PREVIEW_LIMIT_BYTES })
    }
    let buffer
    try {
      buffer = readFileSync(item.path)
    } catch {
      throw new TransferError('not_found', 'the received file could not be read', { id })
    }
    return { buffer, mime: item.mime, name: item.name }
  }

  // ----------------------------------------------------------- public outbox

  /**
   * Queue a text item for the phone.
   *
   * @param {string} text - the text to send.
   * @returns {{ item: object }} the new outbox entry.
   * @throws {TransferError} `invalid_request` or `too_large`.
   */
  addText(text) {
    if (typeof text !== 'string' || text === '') {
      throw new TransferError('invalid_request', 'the text must be a non-empty string')
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > TEXT_LIMIT_BYTES) {
      throw new TransferError('too_large', `the text exceeds the ${TEXT_LIMIT_BYTES} byte limit`, { limit: TEXT_LIMIT_BYTES, bytes })
    }
    const now = new Date()
    const item = {
      id: newItemId('o'),
      kind: 'text',
      name: `text-${formatStamp(now)}.txt`,
      size: bytes,
      mime: 'text/plain',
      createdAt: now.toISOString(),
      previewable: false,
      text,
    }
    this.outbox.unshift(item)
    this.trimTextEntries(this.outbox)
    this.save()
    return { item: { ...item } }
  }

  /**
   * Queue an existing file for the phone.
   *
   * @param {string} path - absolute path of a regular file.
   * @returns {{ item: object }} the new outbox entry.
   * @throws {TransferError} `not_found`, `invalid_request` or `io_error`.
   */
  addFile(path) {
    if (typeof path !== 'string' || path === '') {
      throw new TransferError('invalid_request', 'the file path is required')
    }
    let stats
    try {
      stats = statSync(path)
    } catch (failure) {
      const code = failure !== null && typeof failure === 'object' && failure.code === 'ENOENT' ? 'not_found' : 'io_error'
      throw new TransferError(code, `could not read the file ${JSON.stringify(path)}: ${failureMessage(failure)}`, { path })
    }
    if (!stats.isFile()) {
      throw new TransferError('invalid_request', 'only regular files can be sent', { path })
    }
    const name = basename(path)
    const mime = mimeForFile(name)
    const item = {
      id: newItemId('o'),
      kind: 'file',
      name,
      size: stats.size,
      mime,
      createdAt: new Date().toISOString(),
      previewable: isPreviewableMime(mime),
      path,
    }
    this.outbox.unshift(item)
    this.save()
    return { item: { ...item } }
  }

  /**
   * Queue a screenshot from the history store for the phone.
   *
   * @param {string} historyId - history entry id.
   * @returns {{ item: object }} the new outbox entry.
   * @throws {TransferError} `unsupported`, `not_found` or `io_error`.
   */
  addHistory(historyId) {
    if (this.history === undefined) {
      throw new TransferError('unsupported', 'screenshot history is unavailable')
    }
    const entry = this.history.get(historyId)
    if (entry === undefined) {
      throw new TransferError('not_found', `unknown history capture ${JSON.stringify(historyId)}`, { id: historyId })
    }
    let size = Number(entry.bytes)
    if (!Number.isFinite(size) || size < 0) {
      try {
        size = this.history.read(historyId).byteLength
      } catch {
        size = 0
      }
    }
    const item = {
      id: newItemId('o'),
      kind: 'history',
      name: `screenshot-${formatStamp(new Date())}.png`,
      size,
      mime: 'image/png',
      createdAt: new Date().toISOString(),
      previewable: true,
      historyId,
    }
    this.outbox.unshift(item)
    this.save()
    return { item: { ...item } }
  }

  /**
   * Remove every outbox record. The underlying files are left alone.
   *
   * @returns {{ cleared: number }} how many entries were removed.
   */
  clearOutbox() {
    const cleared = this.outbox.length
    this.outbox = []
    this.save()
    return { cleared }
  }

  /**
   * @param {string} id - outbox item id.
   * @returns {{ removed: boolean, id: string }} whether it existed.
   */
  removeOutbox(id) {
    const index = this.outbox.findIndex((item) => item.id === id)
    if (index === -1) return { removed: false, id }
    this.outbox.splice(index, 1)
    this.save()
    return { removed: true, id }
  }

  // -------------------------------------------------------------- HTTP layer

  /**
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves once the request was answered.
   */
  async handleRequest(req, res) {
    req.on('error', () => {})
    res.on('error', () => {})
    try {
      await this.routeRequest(req, res)
    } catch (failure) {
      this.warn('transfer request failed', failure)
      if (!res.headersSent && !res.destroyed) {
        this.sendJson(res, 500, { error: { code: 'io_error', message: 'internal error' } })
      } else if (!res.destroyed) {
        res.destroy()
      }
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves once the request was answered.
   */
  async routeRequest(req, res) {
    if (!this.hostAllowed(req)) {
      this.sendJson(res, 403, { error: { code: 'invalid_request', message: 'forbidden' } })
      return
    }
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      this.sendJson(res, 405, { error: { code: 'invalid_request', message: 'method not allowed' } }, { Allow: 'GET, POST' })
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://transfer.invalid')
    } catch {
      this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
      return
    }
    const match = /^\/t\/([^/]+)(\/.*)?$/u.exec(url.pathname)
    if (match === null) {
      this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
      return
    }
    const remote = normalizeRemote(req.socket?.remoteAddress)
    if (this.tokenRateLimited(remote)) {
      this.sendJson(res, 429, { error: { code: 'invalid_request', message: 'too many failed attempts' } }, { 'Retry-After': '60' })
      return
    }
    if (!tokenMatches(this.token, match[1])) {
      this.recordTokenFailure(remote)
      this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
      return
    }
    const rest = match[2]
    if (rest === undefined) {
      this.respond(res, 302, Buffer.alloc(0), { Location: `/t/${this.token}/` })
      return
    }
    if (method === 'GET') {
      if (rest === '/') {
        await this.servePage(res)
        return
      }
      if (rest === '/api/state') {
        this.serveState(res)
        return
      }
      if (rest.startsWith('/api/items/')) {
        await this.serveOutboxItem(req, res, rest.slice('/api/items/'.length), url)
        return
      }
      this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
      return
    }
    if (rest === '/api/diag') {
      await this.receiveDiagnostic(req, res)
      return
    }
    if (rest === '/api/text') {
      await this.receiveText(req, res)
      return
    }
    if (rest === '/api/upload') {
      await this.receiveUpload(req, res, url)
      return
    }
    this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
  }

  /**
   * @param {import('node:http').IncomingMessage} req - the request.
   * @returns {boolean} whether the `Host` header belongs to this session.
   */
  hostAllowed(req) {
    const header = req.headers.host
    if (typeof header !== 'string' || header === '') return false
    return this.allowedHosts.has(header.trim().toLowerCase())
  }

  /**
   * @param {string} remote - per-client key.
   * @returns {boolean} whether the client exhausted its token-failure budget.
   */
  tokenRateLimited(remote) {
    const failures = this.tokenFailures.get(remote)
    if (failures === undefined) return false
    const cutoff = Date.now() - TOKEN_FAILURE_WINDOW_MS
    const recent = failures.filter((at) => at > cutoff)
    if (recent.length === 0) {
      this.tokenFailures.delete(remote)
      return false
    }
    this.tokenFailures.set(remote, recent)
    return recent.length > TOKEN_FAILURE_LIMIT
  }

  /**
   * @param {string} remote - per-client key.
   */
  recordTokenFailure(remote) {
    const cutoff = Date.now() - TOKEN_FAILURE_WINDOW_MS
    const failures = (this.tokenFailures.get(remote) ?? []).filter((at) => at > cutoff)
    failures.push(Date.now())
    this.tokenFailures.set(remote, failures)
  }

  /**
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves once the page is written.
   */
  async servePage(res) {
    let html = FALLBACK_PAGE
    if (typeof this.page === 'function') {
      const rendered = await this.page()
      if (typeof rendered === 'string' && rendered !== '') html = rendered
    } else if (typeof this.page === 'string' && this.page !== '') {
      html = this.page
    }
    this.respond(res, 200, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
    })
  }

  /**
   * @param {import('node:http').ServerResponse} res - the response.
   */
  serveState(res) {
    const payload = {
      device: { name: this.hostName },
      now: new Date().toISOString(),
      expiresAt: this.expiresAt,
      inboxCount: this.inbox.length,
      outbox: {
        items: this.outbox.map((item) => publicOutboxItem(withTextPreview(item))),
        count: this.outbox.length,
      },
    }
    this.sendJson(res, 200, payload)
  }

  /**
   * Answer `POST /t/<token>/api/text`.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves once answered.
   */
  async receiveText(req, res) {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > TEXT_LIMIT_BYTES) {
      this.sendJson(res, 413, { error: { code: 'too_large', message: 'the text is too large' } })
      req.resume()
      return
    }
    let body
    try {
      body = await readRequestBody(req, TEXT_LIMIT_BYTES)
    } catch (failure) {
      const tooLarge = failure instanceof TransferError && failure.code === 'too_large'
      this.sendJson(res, tooLarge ? 413 : 400, {
        error: { code: tooLarge ? 'too_large' : 'invalid_request', message: failureMessage(failure) },
      })
      return
    }
    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      this.sendJson(res, 400, { error: { code: 'invalid_request', message: 'the body must be JSON' } })
      return
    }
    const text = payload !== null && typeof payload === 'object' ? payload.text : undefined
    if (typeof text !== 'string' || text === '') {
      this.sendJson(res, 400, { error: { code: 'invalid_request', message: 'text must be a non-empty string' } })
      return
    }
    const item = this.addInboxText(text)
    this.sendJson(res, 200, { item })
    this.afterInboxItem(item)
  }

  /**
   * Answer `POST /t/<token>/api/upload?name=…`.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {URL} url - the parsed request URL.
   * @returns {Promise<void>} resolves once answered.
   */
  async receiveUpload(req, res, url) {
    const remote = normalizeRemote(req.socket?.remoteAddress)
    const userAgent = req.headers['user-agent']
    const ua = typeof userAgent === 'string' ? userAgent.slice(0, 300) : ''
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > this.maxFileBytes) {
      this.diag('upload-rejected', { remote, ua, declared, limit: this.maxFileBytes, reason: 'content-length' })
      this.sendJson(res, 413, { error: { code: 'too_large', message: 'the upload is too large' } })
      req.resume()
      return
    }
    const requested = sanitizeFileName(url.searchParams.get('name') ?? '')
    const safeName = requested === '' ? fallbackFileName() : requested
    const tempPath = join(this.directory, `.${safeName}.part-${randomBytes(6).toString('hex')}`)
    this.diag('upload-start', {
      remote,
      ua,
      name: safeName,
      contentLength: Number.isFinite(declared) ? declared : null,
      contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '',
    })
    let bytes
    try {
      bytes = await streamUploadToFile(req, tempPath, this.maxFileBytes)
    } catch (failure) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        // The temporary file was never created or is already gone.
      }
      const code = failure instanceof TransferError ? failure.code : 'io_error'
      this.diag('upload-failed', { remote, ua, name: safeName, code, message: failureMessage(failure) })
      if (failure instanceof TransferError) {
        const status = failure.code === 'too_large' ? 413 : failure.code === 'invalid_request' ? 400 : 500
        this.sendJson(res, status, { error: { code: failure.code, message: failure.message } })
      } else {
        this.sendJson(res, 500, { error: { code: 'io_error', message: 'could not store the upload' } })
      }
      return
    }
    if (bytes === 0) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        // Nothing was written.
      }
      this.diag('upload-failed', { remote, ua, name: safeName, code: 'empty' })
      this.sendJson(res, 400, { error: { code: 'invalid_request', message: 'the upload is empty' } })
      return
    }
    let finalName
    try {
      finalName = placeUpload(tempPath, this.directory, safeName)
    } catch (failure) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        // Nothing left to clean up.
      }
      this.diag('upload-failed', { remote, ua, name: safeName, code: 'place', message: failureMessage(failure) })
      this.sendJson(res, 500, { error: { code: 'io_error', message: `could not finish the upload: ${failureMessage(failure)}` } })
      return
    }
    const item = this.addInboxFile(join(this.directory, finalName), finalName, bytes, req.headers['content-type'])
    this.diag('upload-done', { remote, ua, name: finalName, bytes })
    this.sendJson(res, 200, { item })
    this.afterInboxItem(item)
  }

  /**
   * Answer `GET /t/<token>/api/items/<id>`.
   *
   * The response is a **download** by default: `attachment` plus an inert
   * `application/octet-stream` body, so Android/iOS browsers and their
   * download managers save it instead of trying to render it in a new tab.
   * `?inline=1` asks for an inline preview and is honoured only for inert
   * raster images; the phone page uses it for its `<img>` thumbnails.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {string} encodedId - URL-encoded outbox id.
   * @param {URL} url - the parsed request URL.
   * @returns {Promise<void>} resolves once the response is started.
   */
  async serveOutboxItem(req, res, encodedId, url) {
    let id = encodedId
    try {
      id = decodeURIComponent(encodedId)
    } catch {
      // Keep the raw form; it will simply not match any id.
    }
    const item = this.findOutbox(id)
    if (item === undefined) {
      this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
      return
    }
    const inline = url.searchParams.get(INLINE_PREVIEW_QUERY) === '1' && isPreviewableMime(item.mime)
    const disposition = contentDispositionHeader(inline ? 'inline' : 'attachment', item.name)
    const contentType = inline ? item.mime : 'application/octet-stream'
    this.diag('item', {
      remote: normalizeRemote(req.socket?.remoteAddress),
      id: item.id,
      kind: item.kind,
      size: item.size,
      inline,
    })
    if (item.kind === 'text') {
      this.respond(res, 200, Buffer.from(item.text ?? '', 'utf8'), {
        'Content-Type': inline ? `${item.mime}; charset=utf-8` : contentType,
        'Content-Disposition': disposition,
      })
      return
    }
    if (item.kind === 'history') {
      if (this.history === undefined) {
        this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
        return
      }
      let buffer
      try {
        buffer = this.history.read(item.historyId)
      } catch {
        this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
        return
      }
      this.respond(res, 200, buffer, {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
      })
      return
    }
    if (item.kind === 'file' && typeof item.path === 'string' && existsSync(item.path)) {
      let stats
      try {
        stats = statSync(item.path)
      } catch {
        this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
        return
      }
      if (!stats.isFile()) {
        this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
        return
      }
      this.streamFile(res, item, stats.size, disposition, contentType)
      return
    }
    this.sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
  }

  /**

  /**
   * Stream one outbox file to the phone.
   *
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {object} item - outbox entry.
   * @param {number} size - file size in bytes.
   * @param {string} disposition - ready-made `Content-Disposition` value.
   * @param {string} contentType - response `Content-Type`.
   */
  streamFile(res, item, size, disposition, contentType) {
    if (res.headersSent || res.destroyed) return
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Length': size,
      'Content-Disposition': disposition,
    })
    const stream = createReadStream(item.path)
    // pipeline() destroys the read stream when the phone aborts the download;
    // a bare pipe() would leak the open file descriptor until the process exits.
    pipeline(stream, res, (failure) => {
      if (failure === undefined || failure === null) return
      const code = failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : ''
      if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'EPIPE') return
      this.warn('could not stream a transfer item', failure)
      if (!res.destroyed) res.destroy()
    })
  }

  /**
   * Append one bounded diagnostics line (client errors and transfer request
   * summaries) to `<stateDirectory>/diagnostics.log`. Best effort: a logging
   * failure must never affect an actual transfer.
   *
   * @param {string} event - short event name.
   * @param {object} [details] - JSON-serializable fields.
   */
  diag(event, details = {}) {
    try {
      try {
        if (statSync(this.diagnosticsPath).size > DIAGNOSTICS_LOG_LIMIT_BYTES) {
          renameSync(this.diagnosticsPath, `${this.diagnosticsPath}.1`)
        }
      } catch {
        // No log yet, or the rotation itself failed; appending still works.
      }
      appendFileSync(this.diagnosticsPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 })
    } catch {
      // Diagnostics are best effort.
    }
  }

  /**
   * Answer `POST /t/<token>/api/diag`: a bounded, best-effort report from the
   * phone page (page errors, failed uploads). It exists so a LAN phone that
   * cannot be remote-debugged can still explain what its browser did.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves once answered.
   */
  async receiveDiagnostic(req, res) {
    let body
    try {
      body = await readRequestBody(req, DIAGNOSTIC_REPORT_LIMIT_BYTES)
    } catch (failure) {
      const tooLarge = failure instanceof TransferError && failure.code === 'too_large'
      this.sendJson(res, tooLarge ? 413 : 400, {
        error: { code: tooLarge ? 'too_large' : 'invalid_request', message: failureMessage(failure) },
      })
      return
    }
    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      this.sendJson(res, 400, { error: { code: 'invalid_request', message: 'the body must be JSON' } })
      return
    }
    const record = payload !== null && typeof payload === 'object' ? payload : {}
    const text = (value) => (typeof value === 'string' ? value.slice(0, 2000) : '')
    const userAgent = req.headers['user-agent']
    this.diag('client', {
      remote: normalizeRemote(req.socket?.remoteAddress),
      ua: typeof userAgent === 'string' ? userAgent.slice(0, 300) : '',
      kind: text(record.kind),
      message: text(record.message),
      source: text(record.source),
      line: Number.isFinite(record.line) ? record.line : null,
      detail: text(record.detail),
    })
    res.writeHead(204, { ...SECURITY_HEADERS })
    res.end()
  }

  // -------------------------------------------------------------- HTTP utils

  /**
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {number} status - HTTP status code.
   * @param {object} payload - JSON body.
   * @param {Record<string, string>} [headers] - extra response headers.
   */
  sendJson(res, status, payload, headers = {}) {
    this.respond(res, status, JSON.stringify(payload), {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    })
  }

  /**
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {number} status - HTTP status code.
   * @param {string | Buffer} body - response bytes.
   * @param {Record<string, string>} [headers] - extra response headers.
   */
  respond(res, status, body, headers = {}) {
    if (res.headersSent || res.destroyed) return
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Length': buffer.byteLength,
      ...headers,
    })
    res.end(buffer)
  }

  // ---------------------------------------------------------------- inbox add

  /**
   * Append a phone text entry to the inbox.
   *
   * @param {string} text - the received text.
   * @returns {object} the new inbox entry.
   */
  addInboxText(text) {
    const now = new Date()
    const item = {
      id: newItemId('i'),
      kind: 'text',
      name: `text-${formatStamp(now)}.txt`,
      size: Buffer.byteLength(text, 'utf8'),
      mime: 'text/plain',
      createdAt: now.toISOString(),
      previewable: false,
      text,
    }
    this.inbox.unshift(item)
    this.trimTextEntries(this.inbox)
    this.save()
    return item
  }

  /**
   * Append a stored upload to the inbox.
   *
   * @param {string} path - absolute path of the stored file.
   * @param {string} name - sanitized file name.
   * @param {number} size - file size in bytes.
   * @param {string | undefined} contentType - request `Content-Type`.
   * @returns {object} the new inbox entry.
   */
  addInboxFile(path, name, size, contentType) {
    const fromName = mimeForFile(name)
    let mime = fromName
    if (fromName === 'application/octet-stream' && typeof contentType === 'string') {
      const declared = contentType.split(';')[0].trim().toLowerCase()
      if (declared !== '' && declared.includes('/')) mime = declared
    }
    const item = {
      id: newItemId('i'),
      kind: 'file',
      name,
      size,
      mime,
      createdAt: new Date().toISOString(),
      previewable: isPreviewableMime(mime),
      path,
    }
    this.inbox.unshift(item)
    this.save()
    return item
  }

  /**
   * Best-effort notification and clipboard hook after a phone upload.
   *
   * @param {object} item - the new inbox entry.
   */
  afterInboxItem(item) {
    if (this.notify !== undefined) {
      try {
        const result = this.notify({ title: 'Received from phone', body: item.name })
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.catch(() => {})
        }
      } catch {
        // Notifications are best-effort.
      }
    }
    if (this.autoCopyText && item.kind === 'text' && typeof item.text === 'string' && this.copyText !== undefined) {
      try {
        const result = this.copyText(item.text)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.catch(() => {})
        }
      } catch {
        // Clipboard writes are best-effort.
      }
    }
  }
}
