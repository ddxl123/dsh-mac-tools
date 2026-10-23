/**
 * Phone-transfer server: lifecycle, token/Host security, text, uploads, outbox
 * downloads, inbox management and persistence — driven over real loopback
 * HTTP with an injected QR encoder and no external tooling.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, request as httpRequest } from 'node:http'
import net from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TransferError, TransferServer } from '../src/transfer.js'

/**
 * @returns {number | null} the number of file descriptors this process holds,
 * or `null` when the platform does not expose `/dev/fd`.
 */
function openFileDescriptorCount() {
  try {
    return readdirSync('/dev/fd').length
  } catch {
    return null
  }
}

/**
 * @param {string} [prefix] - temp-dir prefix.
 * @returns {string} a fresh temp directory.
 */
function tempRoot(prefix = 'dsh-mac-tools-transfer-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * @param {string} root - temp directory holding both subdirectories.
 * @param {object} [overrides] - constructor overrides.
 * @returns {Promise<{ server: TransferServer, status: object }>} a started server.
 */
async function startServer(root, overrides = {}) {
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    hostName: 'transfer-test-host',
    qr: async () => 'QR',
    keepAwake: false,
    ...overrides,
  })
  const status = await server.start()
  return { server, status }
}

/**
 * Perform one HTTP request against the loopback listener.
 *
 * @param {object} options - request options.
 * @param {number} options.port - listening port.
 * @param {string} options.path - request path.
 * @param {string} [options.method] - HTTP method.
 * @param {Record<string, string>} [options.headers] - extra headers.
 * @param {Buffer | string} [options.body] - request body.
 * @returns {Promise<{ status: number, headers: object, body: Buffer, text: string, json: () => any }>} the response.
 */
function request({ port, path, method = 'GET', headers = {}, body, agent }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      agent,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const text = buffer.toString('utf8')
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buffer,
          text,
          reused: req.reusedSocket === true,
          json: () => JSON.parse(text),
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

/**
 * @param {number} port - listening port.
 * @param {string} path - request path.
 * @param {object} payload - JSON payload.
 * @returns {Promise<object>} the response.
 */
function postJson(port, path, payload) {
  return request({
    port,
    path,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)),
  })
}

/**
 * @param {number} port - listening port.
 * @param {string} token - session token.
 * @param {string} name - raw uploaded name.
 * @param {Buffer | string} body - upload bytes.
 * @param {string} [contentType] - request content type.
 * @returns {Promise<object>} the response.
 */
function upload(port, token, name, body, contentType = 'application/octet-stream') {
  return request({
    port,
    path: `/t/${token}/api/upload?name=${encodeURIComponent(name)}`,
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

/**
 * @param {() => boolean} predicate - condition to wait for.
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] - wait options.
 * @returns {Promise<void>} resolves once the condition holds.
 */
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Stop a server and give its listener a tick to release the socket.
 *
 * @param {TransferServer} server - the server.
 * @returns {Promise<void>} resolves once disposed.
 */
async function shutdown(server) {
  server.dispose()
  await new Promise((resolve) => setTimeout(resolve, 10))
}

/**
 * @param {number} port - port to bind.
 * @returns {Promise<net.Server>} the bound server.
 */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

/**
 * @param {net.Server} server - server to close.
 * @returns {Promise<void>} resolves once closed.
 */
function closeNet(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/**
 * Reserve consecutive loopback ports for the port-unavailable test.
 *
 * @param {number} count - how many ports.
 * @returns {Promise<{ base: number, servers: net.Server[] }>} the reserved range.
 */
async function occupyConsecutivePorts(count) {
  const firstBase = 43000 + Math.floor(Math.random() * 100) * 10
  for (let base = firstBase; base < 64000; base += 10) {
    /** @type {net.Server[]} */
    const servers = []
    let complete = true
    for (let offset = 0; offset < count; offset += 1) {
      try {
        servers.push(await listenOn(base + offset))
      } catch {
        complete = false
        break
      }
    }
    if (complete) return { base, servers }
    await Promise.all(servers.map(closeNet))
  }
  throw new Error('could not reserve consecutive loopback ports')
}

test('starts a session, computes URLs and serves the phone page', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    assert.equal(status.active, true)
    assert.match(status.token, /^[A-Za-z0-9_-]{24}$/u)
    assert.ok(Number.isInteger(status.port) && status.port > 0)
    assert.equal(status.directory, join(root, 'inbox'))
    assert.equal(status.maxFileMB, 512)
    assert.equal(status.sessionMinutes, 30)
    assert.equal(status.autoCopyText, false)
    assert.equal(status.inboxCount, 0)
    assert.equal(status.outboxCount, 0)
    assert.equal(status.qrPngBase64, 'QR')
    assert.equal(status.qrError, null)
    assert.deepEqual(status.warnings, [])
    assert.ok(status.url.startsWith('http://'))
    assert.ok(status.url.endsWith(`/t/${status.token}/`))
    assert.ok(Array.isArray(status.urls) && status.urls.includes(status.url))
    assert.equal(typeof status.startedAt, 'string')
    assert.equal(new Date(status.startedAt).toISOString(), status.startedAt)
    assert.equal(typeof status.expiresAt, 'string')
    assert.ok(Date.parse(status.expiresAt) > Date.parse(status.startedAt))
    assert.ok(
      server.server.requestTimeout >= status.sessionMinutes * 60_000,
      `slow large uploads must outlive the 300 s default request timeout, got ${server.server.requestTimeout}`,
    )

    const page = await request({ port: status.port, path: `/t/${status.token}/` })
    assert.equal(page.status, 200)
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
    assert.match(page.headers['content-security-policy'], /default-src 'none'/u)
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.equal(page.headers['x-content-type-options'], 'nosniff')
    assert.equal(page.headers['referrer-policy'], 'no-referrer')
    assert.equal(page.headers['x-frame-options'], 'DENY')
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS headers may be sent')
    assert.match(page.text, /^<!doctype html>/iu)
    assert.match(page.text, /viewport/u)

    const redirect = await request({ port: status.port, path: `/t/${status.token}` })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.location, `/t/${status.token}/`)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects wrong tokens with 404 and foreign Host headers with 403', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const wrong = await request({ port: status.port, path: '/t/wrong-token/' })
    assert.equal(wrong.status, 404)
    assert.ok(!wrong.text.includes(status.token), 'the real token must not leak')
    assert.equal(wrong.headers['cache-control'], 'no-store')

    const forged = await request({ port: status.port, path: `/t/${status.token}/`, headers: { Host: 'evil.example' } })
    assert.equal(forged.status, 403)

    const wrongPort = await request({ port: status.port, path: `/t/${status.token}/`, headers: { Host: `127.0.0.1:${status.port + 1}` } })
    assert.equal(wrongPort.status, 403)

    const missingPort = await request({ port: status.port, path: `/t/${status.token}/`, headers: { Host: '127.0.0.1' } })
    assert.equal(missingPort.status, 403)

    for (const host of [`localhost:${status.port}`, `transfer-test-host.local:${status.port}`, new URL(status.url).host]) {
      const allowed = await request({ port: status.port, path: `/t/${status.token}/`, headers: { Host: host } })
      assert.equal(allowed.status, 200, `Host ${host} should be allowed`)
    }
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('rate-limits an address after repeated token failures', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await request({ port: status.port, path: '/t/wrong-token/' })
      assert.equal(response.status, 404, `attempt ${attempt + 1} should be a 404`)
    }
    const blocked = await request({ port: status.port, path: `/t/${status.token}/` })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers['retry-after'], '60')
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('starts even when the QR helper fails', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root, {
    qr: async () => {
      throw new Error('swiftc is missing')
    },
  })
  try {
    assert.equal(status.active, true)
    assert.equal(status.qrPngBase64, null)
    assert.equal(status.qrError, 'swiftc is missing')
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts phone text and triggers notify / auto copy', async () => {
  const root = tempRoot()
  /** @type {{ notifications: object[], copies: string[] }} */
  const calls = { notifications: [], copies: [] }
  const { server, status } = await startServer(root, {
    autoCopyText: true,
    notify: async (message) => {
      calls.notifications.push(message)
    },
    copyText: async (text) => {
      calls.copies.push(text)
    },
  })
  try {
    const response = await postJson(status.port, `/t/${status.token}/api/text`, { text: 'hello from phone' })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
    const { item } = response.json()
    assert.match(item.id, /^i-[0-9a-f]{16}$/u)
    assert.equal(item.kind, 'text')
    assert.match(item.name, /^text-\d{8}-\d{6}\.txt$/u)
    assert.equal(item.size, Buffer.byteLength('hello from phone'))
    assert.equal(item.mime, 'text/plain')
    assert.equal(item.previewable, false)
    assert.equal(item.text, 'hello from phone')
    assert.equal(typeof item.createdAt, 'string')

    const inbox = server.listInbox()
    assert.equal(inbox.count, 1)
    assert.deepEqual(inbox.items[0], item)

    await waitUntil(() => calls.notifications.length === 1 && calls.copies.length === 1)
    assert.deepEqual(calls.notifications[0], { title: 'Received from phone', body: item.name })
    assert.deepEqual(calls.copies, ['hello from phone'])

    const stateResponse = await request({ port: status.port, path: `/t/${status.token}/api/state` })
    assert.equal(stateResponse.status, 200)
    const state = stateResponse.json()
    assert.deepEqual(state.device, { name: 'transfer-test-host' })
    assert.equal(state.expiresAt, status.expiresAt)
    assert.equal(typeof state.now, 'string')
    assert.equal(state.inboxCount, 1)
    assert.deepEqual(state.outbox, { items: [], count: 0 })
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects empty or oversized text payloads', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const notJson = await request({ port: status.port, path: `/t/${status.token}/api/text`, method: 'POST', body: 'not json' })
    assert.equal(notJson.status, 400)
    const emptyText = await postJson(status.port, `/t/${status.token}/api/text`, { text: '' })
    assert.equal(emptyText.status, 400)
    const missingText = await postJson(status.port, `/t/${status.token}/api/text`, {})
    assert.equal(missingText.status, 400)
    const tooLarge = await postJson(status.port, `/t/${status.token}/api/text`, { text: 'x'.repeat(70 * 1024) })
    assert.equal(tooLarge.status, 413)
    assert.equal(server.listInbox().count, 0)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('stores uploads with sanitized, deduplicated names', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const first = await upload(status.port, status.token, '../..%2Fevil.png', Buffer.from('FIRSTPNG'))
    assert.equal(first.status, 200)
    const firstItem = first.json().item
    assert.equal(firstItem.kind, 'file')
    assert.equal(firstItem.name, 'evil.png')
    assert.equal(firstItem.size, 8)
    assert.equal(firstItem.mime, 'image/png')
    assert.equal(firstItem.previewable, true)
    assert.equal(firstItem.path, join(root, 'inbox', 'evil.png'))
    assert.equal(readFileSync(firstItem.path, 'utf8'), 'FIRSTPNG')

    const second = await upload(status.port, status.token, '../..%2Fevil.png', Buffer.from('SECOND'))
    const secondItem = second.json().item
    assert.equal(secondItem.name, 'evil (1).png')
    assert.equal(readFileSync(secondItem.path, 'utf8'), 'SECOND')

    const third = await upload(status.port, status.token, 'a:b?.txt', Buffer.from('third'))
    assert.equal(third.json().item.name, 'ab.txt')

    const names = readdirSync(join(root, 'inbox')).sort()
    assert.deepEqual(names, ['ab.txt', 'evil (1).png', 'evil.png'])
    assert.ok(names.every((name) => !name.includes('.part-')), 'no partial files may remain')
    assert.equal(server.listInbox().count, 3)
    assert.equal(server.status().inboxCount, 3)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects oversized and empty uploads without leaving partial files', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root, { maxFileBytes: 16 })
  try {
    const oversized = await upload(status.port, status.token, 'big.bin', Buffer.alloc(64, 1))
    assert.equal(oversized.status, 413)
    assert.deepEqual(readdirSync(join(root, 'inbox')), [])
    assert.equal(server.listInbox().count, 0)

    const empty = await upload(status.port, status.token, 'empty.bin', Buffer.alloc(0))
    assert.equal(empty.status, 400)
    assert.deepEqual(readdirSync(join(root, 'inbox')), [])
    assert.equal(server.listInbox().count, 0)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('serves outbox items to the phone with correct types', async () => {
  const root = tempRoot()
  const history = {
    /**
     * @param {string} id - history id.
     * @returns {object | undefined} a fake entry.
     */
    get: (id) => (id === 'h1' ? { id: 'h1', bytes: 4 } : undefined),
    /**
     * @param {string} id - history id.
     * @returns {Buffer} fake PNG bytes.
     */
    read: (id) => {
      if (id !== 'h1') throw new Error('unknown')
      return Buffer.from('HSTR')
    },
  }
  const { server, status } = await startServer(root, { history })
  try {
    const photoPath = join(root, 'photo.png')
    writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const textItem = server.addText('hello phone').item
    const fileItem = server.addFile(photoPath).item
    const historyItem = server.addHistory('h1').item
    assert.match(textItem.id, /^o-[0-9a-f]{16}$/u)
    assert.match(fileItem.id, /^o-[0-9a-f]{16}$/u)
    assert.match(historyItem.id, /^o-[0-9a-f]{16}$/u)
    assert.equal(fileItem.name, 'photo.png')
    assert.equal(fileItem.previewable, true)
    assert.equal(historyItem.name.startsWith('screenshot-'), true)
    assert.equal(historyItem.size, 4)
    assert.equal(historyItem.historyId, 'h1')

    const stateResponse = await request({ port: status.port, path: `/t/${status.token}/api/state` })
    const state = stateResponse.json()
    assert.equal(state.outbox.count, 3)
    assert.deepEqual(state.outbox.items.map((item) => item.id), [historyItem.id, fileItem.id, textItem.id])
    for (const item of state.outbox.items) {
      assert.equal(Object.hasOwn(item, 'path'), false, 'public outbox items must not expose paths')
    }

    // Item responses default to a real download: attachment + inert bytes, so
    // Android/iOS browsers hand the file to their download manager instead of
    // rendering it in a tab. The `filename` fallback is plain ASCII (old
    // browser download managers ignore RFC 5987 `filename*`).
    const textResponse = await request({ port: status.port, path: `/t/${status.token}/api/items/${textItem.id}` })
    assert.equal(textResponse.status, 200)
    assert.equal(textResponse.headers['content-type'], 'application/octet-stream')
    assert.match(textResponse.headers['content-disposition'], /^attachment; filename="text-[^"]+\.txt"; filename\*=UTF-8''/u)
    assert.equal(textResponse.text, 'hello phone')

    const fileResponse = await request({ port: status.port, path: `/t/${status.token}/api/items/${fileItem.id}` })
    assert.equal(fileResponse.status, 200)
    assert.equal(fileResponse.headers['content-type'], 'application/octet-stream')
    assert.match(fileResponse.headers['content-disposition'], /^attachment; filename="photo\.png"/u)
    assert.deepEqual([...fileResponse.body], [0x89, 0x50, 0x4e, 0x47])

    // The phone page previews images with ?inline=1; only inert raster types are
    // served inline there.
    const filePreview = await request({ port: status.port, path: `/t/${status.token}/api/items/${fileItem.id}?inline=1` })
    assert.equal(filePreview.status, 200)
    assert.equal(filePreview.headers['content-type'], 'image/png')
    assert.match(filePreview.headers['content-disposition'], /^inline; filename="photo\.png"/u)

    const historyResponse = await request({ port: status.port, path: `/t/${status.token}/api/items/${historyItem.id}` })
    assert.equal(historyResponse.status, 200)
    assert.equal(historyResponse.headers['content-type'], 'application/octet-stream')
    assert.match(historyResponse.headers['content-disposition'], /^attachment; filename="screenshot-[^"]+\.png"/u)
    assert.equal(historyResponse.text, 'HSTR')

    const historyPreview = await request({ port: status.port, path: `/t/${status.token}/api/items/${historyItem.id}?inline=1` })
    assert.equal(historyPreview.headers['content-type'], 'image/png')
    assert.match(historyPreview.headers['content-disposition'], /^inline;/u)

    const notePath = join(root, 'note.txt')
    writeFileSync(notePath, 'notes')
    const noteItem = server.addFile(notePath).item
    const noteResponse = await request({ port: status.port, path: `/t/${status.token}/api/items/${noteItem.id}` })
    assert.equal(noteResponse.status, 200)
    assert.equal(noteResponse.headers['content-type'], 'application/octet-stream')
    assert.match(noteResponse.headers['content-disposition'], /^attachment; filename="note\.txt"/u)

    const missing = await request({ port: status.port, path: `/t/${status.token}/api/items/o-0000000000000000` })
    assert.equal(missing.status, 404)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('answers unsupported methods with 405 and unknown paths with 404', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const put = await request({ port: status.port, path: `/t/${status.token}/api/state`, method: 'PUT' })
    assert.equal(put.status, 405)
    assert.equal(put.headers.allow, 'GET, POST')
    const unknown = await request({ port: status.port, path: `/t/${status.token}/nope` })
    assert.equal(unknown.status, 404)
    const rootPath = await request({ port: status.port, path: '/' })
    assert.equal(rootPath.status, 404)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('manages inbox entries: preview, copy, delete and clear', async () => {
  const root = tempRoot()
  /** @type {string[]} */
  const copies = []
  const { server, status } = await startServer(root, {
    copyText: async (text) => {
      copies.push(text)
    },
  })
  try {
    const fileResponse = await upload(status.port, status.token, 'note.txt', Buffer.from('FILE'), 'text/plain')
    const fileItem = fileResponse.json().item
    const textResponse = await postJson(status.port, `/t/${status.token}/api/text`, { text: 'copy me' })
    const textItem = textResponse.json().item

    const preview = server.readInboxFile(fileItem.id)
    assert.equal(preview.buffer.toString(), 'FILE')
    assert.equal(preview.mime, 'text/plain')
    assert.equal(preview.name, 'note.txt')
    assert.throws(
      () => server.readInboxFile(textItem.id),
      (failure) => failure instanceof TransferError && failure.code === 'invalid_request',
    )

    const copied = await server.copyInboxText(textItem.id)
    assert.deepEqual(copied, { copied: true, bytes: 7 })
    assert.deepEqual(copies, ['copy me'])
    await assert.rejects(
      server.copyInboxText(fileItem.id),
      (failure) => failure instanceof TransferError && failure.code === 'invalid_request',
    )
    await assert.rejects(
      server.copyInboxText('i-0000000000000000'),
      (failure) => failure instanceof TransferError && failure.code === 'not_found',
    )
    assert.throws(
      () => server.revealInbox(textItem.id),
      (failure) => failure instanceof TransferError && failure.code === 'invalid_request',
    )

    const deleted = server.deleteInbox(fileItem.id)
    assert.deepEqual(deleted, { deleted: true, id: fileItem.id })
    assert.equal(existsSync(fileItem.path), false)
    assert.deepEqual(server.deleteInbox(fileItem.id), { deleted: false, id: fileItem.id })

    assert.deepEqual(server.clearInbox(), { cleared: 1 })
    assert.equal(server.listInbox().count, 0)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('persists the index and drops entries whose file disappeared', async () => {
  const root = tempRoot()
  const options = () => ({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    hostName: 'persist-host',
    qr: async () => 'QR',
    keepAwake: false,
  })
  const external = join(root, 'external.txt')
  writeFileSync(external, 'external file')
  const first = new TransferServer(options())
  await first.start()
  first.addText('persisted text')
  first.addFile(external)
  first.stop()

  const indexPath = join(root, 'state', 'index.json')
  assert.ok(existsSync(indexPath))
  const stored = JSON.parse(readFileSync(indexPath, 'utf8'))
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.inbox, [])
  assert.equal(stored.outbox.length, 2)
  assert.equal(statSync(indexPath).mode & 0o777, 0o600)

  const second = new TransferServer(options())
  assert.equal(second.listOutbox().count, 2)
  assert.equal(second.listOutbox().items.find((item) => item.kind === 'text').text, 'persisted text')

  rmSync(external)
  const third = new TransferServer(options())
  assert.equal(third.listOutbox().count, 1)
  assert.equal(third.listOutbox().items[0].kind, 'text')
})

test('keeps at most 200 text entries per list and never prunes files', () => {
  const root = tempRoot()
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    keepAwake: false,
  })
  const filePath = join(root, 'keep.txt')
  writeFileSync(filePath, 'keep me')
  server.addFile(filePath)
  for (let index = 0; index < 205; index += 1) server.addText(`text ${index}`)
  const outbox = server.listOutbox()
  assert.equal(outbox.count, 201)
  assert.equal(outbox.items.filter((item) => item.kind === 'text').length, 200)
  assert.equal(outbox.items.find((item) => item.kind === 'file').name, 'keep.txt')
  assert.equal(outbox.items[0].text, 'text 204')
  assert.equal(outbox.items[199].text, 'text 5')
  const reopened = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    keepAwake: false,
  })
  assert.equal(reopened.listOutbox().count, 201)
})

test('start is idempotent, stop clears the session and restart invalidates the old token', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const again = await server.start()
    assert.equal(again.token, status.token)
    assert.equal(again.port, status.port)

    server.stop()
    const inactive = server.status()
    assert.equal(inactive.active, false)
    for (const key of ['url', 'port', 'token', 'qrPngBase64', 'qrError', 'startedAt', 'expiresAt']) {
      assert.equal(inactive[key], null, `${key} must be null while inactive`)
    }
    assert.deepEqual(inactive.urls, [])
    assert.deepEqual(inactive.warnings, [])
    server.stop()

    const restarted = await server.start()
    assert.equal(restarted.active, true)
    assert.notEqual(restarted.token, status.token)
    const oldToken = await request({ port: restarted.port, path: `/t/${status.token}/` })
    assert.equal(oldToken.status, 404)
    const newPage = await request({ port: restarted.port, path: `/t/${restarted.token}/` })
    assert.equal(newPage.status, 200)

    server.dispose()
    server.dispose()
    await assert.rejects(
      server.start(),
      (failure) => failure instanceof TransferError && failure.code === 'not_active',
    )
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('falls forward to the next port when the preferred one is busy', async () => {
  const root = tempRoot()
  const blocker = await listenOn(0)
  const blockerPort = blocker.address().port
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: blockerPort,
    bindHost: '127.0.0.1',
    hostName: 'port-test-host',
    qr: async () => 'QR',
    keepAwake: false,
  })
  try {
    const status = await server.start()
    assert.equal(status.active, true)
    assert.notEqual(status.port, blockerPort)
    assert.ok(status.port > blockerPort && status.port <= blockerPort + 9, `unexpected port ${status.port}`)
  } finally {
    await shutdown(server)
    await closeNet(blocker)
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports port_unavailable when ten consecutive ports are taken', async () => {
  const root = tempRoot()
  const { base, servers } = await occupyConsecutivePorts(10)
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: base,
    bindHost: '127.0.0.1',
    hostName: 'port-test-host',
    qr: async () => 'QR',
    keepAwake: false,
  })
  try {
    await assert.rejects(
      server.start(),
      (failure) => failure instanceof TransferError && failure.code === 'port_unavailable',
    )
    assert.equal(server.status().active, false)
  } finally {
    await shutdown(server)
    await Promise.all(servers.map(closeNet))
    rmSync(root, { recursive: true, force: true })
  }
})

test('a stop() during start() cancels the start instead of leaving a listener behind', async () => {
  const root = tempRoot()
  const { server } = await startServer(root)
  try {
    server.stop()
    const cancelled = server.start()
    server.stop()
    const settled = await cancelled
    assert.equal(settled.active, false, 'a session stopped while starting must not become active')
    assert.equal(server.server, null)
    assert.equal(server.token, null)

    const restarted = await server.start()
    assert.equal(restarted.active, true)
    assert.equal(typeof restarted.token, 'string')
    const page = await request({ port: restarted.port, path: `/t/${restarted.token}/` })
    assert.equal(page.status, 200)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a stop() during QR generation leaves no timer or caffeinate behind', async () => {
  const root = tempRoot()
  /** @type {Array<(value: string) => void>} */
  const pendingQr = []
  let caffeinateStarts = 0
  let caffeinateStops = 0
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    hostName: 'race-test-host',
    keepAwake: true,
    qr: () => new Promise((resolve) => {
      pendingQr.push(resolve)
    }),
  })
  server.startCaffeinate = function startCaffeinateStub() {
    caffeinateStarts += 1
    this.caffeinate = {
      kill: () => {
        caffeinateStops += 1
        return true
      },
    }
  }
  try {
    const starting = server.start()
    await waitUntil(() => pendingQr.length === 1)
    // While the QR helper is busy the session is already active and has a full
    // status snapshot, so a concurrent transferStatus poll sees a sane object.
    const duringQr = server.status()
    assert.equal(duringQr.active, true)
    assert.equal(typeof duringQr.expiresAt, 'string')
    assert.equal(duringQr.qrPngBase64, null)
    assert.match(duringQr.url, /^http:\/\//u)

    server.stop()
    pendingQr.shift()('QR-AFTER-STOP')
    const settled = await starting
    assert.equal(settled.active, false)
    assert.equal(settled.qrPngBase64, null)
    assert.equal(server.expiryTimer, null, 'the expiry timer must not be armed after a stop')
    assert.equal(server.caffeinate, null)
    assert.equal(caffeinateStarts, 1)
    assert.equal(caffeinateStops, 1, 'a stop() during QR generation must release caffeinate')
    assert.equal(server.status().active, false)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a start() issued after stop() replaces the cancelled in-flight start', async () => {
  const root = tempRoot()
  /** @type {Array<(value: string) => void>} */
  const pendingQr = []
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    hostName: 'race-test-host',
    keepAwake: false,
    qr: () => new Promise((resolve) => {
      pendingQr.push(resolve)
    }),
  })
  try {
    const first = server.start()
    await waitUntil(() => pendingQr.length === 1)
    server.stop()
    const second = server.start()
    pendingQr.shift()('CANCELLED')
    await waitUntil(() => pendingQr.length === 1)
    pendingQr.shift()('NEW-SESSION')
    const [firstStatus, secondStatus] = await Promise.all([first, second])
    assert.equal(firstStatus.active, false)
    assert.equal(secondStatus.active, true, 'the later start() must win over the cancelled attempt')
    assert.equal(server.status().active, true)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('dispose() during start() rejects not_active and leaves nothing listening', async () => {
  const root = tempRoot()
  /** @type {Array<(value: string) => void>} */
  const pendingQr = []
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    hostName: 'race-test-host',
    keepAwake: false,
    qr: () => new Promise((resolve) => {
      pendingQr.push(resolve)
    }),
  })
  try {
    const starting = server.start()
    await waitUntil(() => pendingQr.length === 1)
    server.dispose()
    pendingQr.shift()('QR')
    await assert.rejects(
      starting,
      (failure) => failure instanceof TransferError && failure.code === 'not_active',
    )
    assert.equal(server.server, null)
    assert.equal(server.status().active, false)
  } finally {
    server.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('stores concurrent same-name uploads under distinct names without losing bytes', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const payloads = Array.from({ length: 8 }, (_value, index) => Buffer.from(`PAYLOAD-${index}-`.padEnd(2048, 'x')))
    const responses = await Promise.all(payloads.map((payload) => upload(status.port, status.token, 'same.png', payload)))
    const names = responses.map((response) => {
      assert.equal(response.status, 200)
      return response.json().item.name
    })
    assert.equal(new Set(names).size, payloads.length, `expected distinct names, got ${names.join(', ')}`)
    const files = readdirSync(join(root, 'inbox')).sort()
    assert.equal(files.length, payloads.length)
    const contents = files.map((name) => readFileSync(join(root, 'inbox', name), 'utf8'))
    assert.equal(new Set(contents).size, payloads.length, 'every concurrent upload must keep its own bytes')
    assert.ok(files.every((name) => !name.includes('.part-')), 'no temporary upload files may remain')
    assert.equal(server.listInbox().count, payloads.length)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps a keep-alive connection usable after a 413', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root, { maxFileBytes: 16 })
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  try {
    const declaredTooLarge = await request({
      port: status.port,
      path: `/t/${status.token}/api/upload?name=big.bin`,
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': '64' },
      body: Buffer.alloc(64, 1),
      agent,
    })
    assert.equal(declaredTooLarge.status, 413)
    const afterDeclared = await request({ port: status.port, path: `/t/${status.token}/api/state`, agent })
    assert.equal(afterDeclared.status, 200)
    assert.equal(afterDeclared.reused, true, 'the connection must survive an oversized upload')

    const chunkedTooLarge = await request({
      port: status.port,
      path: `/t/${status.token}/api/upload?name=chunked.bin`,
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(64, 2),
      agent,
    })
    assert.equal(chunkedTooLarge.status, 413)
    const afterChunked = await request({ port: status.port, path: `/t/${status.token}/api/state`, agent })
    assert.equal(afterChunked.status, 200)
    assert.equal(afterChunked.reused, true, 'the connection must survive a drained chunked upload')
    assert.deepEqual(readdirSync(join(root, 'inbox')), [])
    assert.equal(server.listInbox().count, 0)
  } finally {
    agent.destroy()
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('marks only raster images as previewable', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const vectorPath = join(root, 'vector.svg')
    writeFileSync(vectorPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const vectorItem = server.addFile(vectorPath).item
    assert.equal(vectorItem.mime, 'image/svg+xml')
    assert.equal(vectorItem.previewable, false, 'SVG must never be rendered in an <img> preview')

    const tiffPath = join(root, 'scan.tiff')
    writeFileSync(tiffPath, 'TIFF')
    assert.equal(server.addFile(tiffPath).item.previewable, false)

    const uploadedSvg = await upload(status.port, status.token, 'phone.svg', Buffer.from('<svg/>'), 'image/svg+xml')
    assert.equal(uploadedSvg.json().item.previewable, false)
    const uploadedPng = await upload(status.port, status.token, 'phone.png', Buffer.from([0x89, 0x50]), 'image/png')
    assert.equal(uploadedPng.json().item.previewable, true)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('releases the file descriptor when the phone aborts a download', async (t) => {
  if (openFileDescriptorCount() === null) {
    t.skip('/dev/fd is not available on this platform')
    return
  }
  const root = tempRoot()
  const bigPath = join(root, 'big.bin')
  writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024, 7))
  const { server, status } = await startServer(root)
  try {
    const item = server.addFile(bigPath).item
    /**
     * Start a download and hang up as soon as the first body chunk arrives.
     *
     * @returns {Promise<void>} resolves once the client closed the socket.
     */
    const abortDownload = () => new Promise((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: status.port,
        path: `/t/${status.token}/api/items/${item.id}`,
        headers: { Host: `127.0.0.1:${status.port}` },
      }, (res) => {
        res.on('error', () => {})
        res.once('data', () => {
          req.destroy()
          res.destroy()
          resolve()
        })
      })
      req.on('error', () => resolve())
      req.end()
    })

    for (let index = 0; index < 3; index += 1) await abortDownload()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const before = openFileDescriptorCount()
    for (let index = 0; index < 30; index += 1) await abortDownload()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = openFileDescriptorCount()
    assert.ok(
      after - before <= 5,
      `aborted downloads leaked ${after - before} file descriptors (before ${before}, after ${after})`,
    )

    const complete = await request({ port: status.port, path: `/t/${status.token}/api/items/${item.id}` })
    assert.equal(complete.status, 200)
    assert.equal(complete.body.length, 2 * 1024 * 1024)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports port_unavailable when the fallback range runs past the last valid port', async (t) => {
  const root = tempRoot()
  const blocker = await new Promise((resolve) => {
    const candidate = net.createServer()
    candidate.once('error', () => resolve(null))
    candidate.listen(65535, '127.0.0.1', () => resolve(candidate))
  })
  if (blocker === null) {
    t.skip('port 65535 is not available on this machine')
    return
  }
  const server = new TransferServer({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 65535,
    bindHost: '127.0.0.1',
    hostName: 'port-test-host',
    qr: async () => 'QR',
    keepAwake: false,
  })
  try {
    await assert.rejects(
      server.start(),
      (failure) => failure instanceof TransferError && failure.code === 'port_unavailable',
    )
    assert.equal(server.status().active, false)
  } finally {
    await shutdown(server)
    await closeNet(blocker)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bounds text inlined in polling responses but keeps the full text available', async () => {
  const root = tempRoot()
  /** @type {string[]} */
  const copies = []
  const { server, status } = await startServer(root, {
    copyText: async (text) => {
      copies.push(text)
    },
  })
  try {
    const longText = 'L'.repeat(700)
    const longItem = server.addText(longText).item
    const shortItem = server.addText('short text').item

    const outbox = server.listOutbox()
    assert.equal(outbox.count, 2)
    const listLong = outbox.items.find((item) => item.id === longItem.id)
    assert.equal(listLong.text.length, 512, 'list responses inline at most 512 characters')
    assert.equal(listLong.text, longText.slice(0, 512))
    assert.equal(listLong.textTruncated, true)
    assert.equal(listLong.size, 700, 'the stored size still describes the full text')
    const listShort = outbox.items.find((item) => item.id === shortItem.id)
    assert.equal(listShort.text, 'short text')
    assert.equal(Object.hasOwn(listShort, 'textTruncated'), false, 'short texts carry no truncation marker')

    const state = (await request({ port: status.port, path: `/t/${status.token}/api/state` })).json()
    const stateLong = state.outbox.items.find((item) => item.id === longItem.id)
    assert.equal(stateLong.text.length, 512)
    assert.equal(stateLong.textTruncated, true)
    assert.equal(Object.hasOwn(stateLong, 'path'), false, 'state must still never expose paths')

    const download = await request({ port: status.port, path: `/t/${status.token}/api/items/${longItem.id}` })
    assert.equal(download.status, 200)
    assert.equal(download.text, longText, 'the item endpoint must return the complete text')

    const stored = JSON.parse(readFileSync(join(root, 'state', 'index.json'), 'utf8'))
    assert.equal(stored.outbox.find((item) => item.id === longItem.id).text, longText, 'persisted data stays complete')

    const longPhoneText = 'P'.repeat(700)
    const received = await postJson(status.port, `/t/${status.token}/api/text`, { text: longPhoneText })
    assert.equal(received.status, 200)
    assert.equal(received.json().item.text, longPhoneText, 'the upload acknowledgement echoes the sent text')
    const inbox = server.listInbox()
    assert.equal(inbox.items[0].text.length, 512)
    assert.equal(inbox.items[0].text, longPhoneText.slice(0, 512))
    assert.equal(inbox.items[0].textTruncated, true)
    const copied = await server.copyInboxText(received.json().item.id)
    assert.deepEqual(copied, { copied: true, bytes: Buffer.byteLength(longPhoneText) })
    assert.deepEqual(copies, [longPhoneText], 'copying must still use the full inbox text')
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('recovers from a corrupt index with an empty list and reports it', () => {
  const root = tempRoot()
  const options = () => ({
    directory: join(root, 'inbox'),
    stateDirectory: join(root, 'state'),
    port: 0,
    bindHost: '127.0.0.1',
    keepAwake: false,
  })
  try {
    new TransferServer(options())
    const indexPath = join(root, 'state', 'index.json')
    writeFileSync(indexPath, '{"version":1,"inbox":[{"broken"')
    /** @type {string[]} */
    const warnings = []
    const recovered = new TransferServer({
      ...options(),
      warn: (message) => {
        warnings.push(message)
      },
    })
    assert.equal(recovered.listInbox().count, 0)
    assert.equal(recovered.listOutbox().count, 0)
    assert.equal(warnings.length, 1, 'a corrupt index must be reported, not silently swallowed')
    assert.match(warnings[0], /index/u)

    recovered.addText('after recovery')
    const stored = JSON.parse(readFileSync(indexPath, 'utf8'))
    assert.equal(stored.outbox.length, 1)
    assert.equal(stored.outbox[0].text, 'after recovery')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('truncates text previews on code-point boundaries without splitting surrogate pairs', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  try {
    const longText = `${'a'.repeat(511)}😀${'b'.repeat(20)}`
    const expectedPrefix = Array.from(longText).slice(0, 512).join('')
    assert.equal(expectedPrefix, `${'a'.repeat(511)}😀`, 'the 512th code point is a whole emoji')
    const item = server.addText(longText).item

    const preview = server.listOutbox().items.find((entry) => entry.id === item.id)
    assert.equal(preview.text, expectedPrefix, 'the preview holds 512 whole code points')
    assert.equal(Array.from(preview.text).length, 512)
    assert.equal(preview.textTruncated, true)
    assert.equal(preview.text.includes('\uFFFD'), false, 'no replacement character from a split surrogate pair')
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(preview.text), false, 'no lone high surrogate may leak')

    const state = (await request({ port: status.port, path: `/t/${status.token}/api/state` })).json()
    const statePreview = state.outbox.items.find((entry) => entry.id === item.id)
    assert.equal(statePreview.text, expectedPrefix)
    assert.equal(statePreview.textTruncated, true)

    const download = await request({ port: status.port, path: `/t/${status.token}/api/items/${item.id}` })
    assert.equal(download.status, 200)
    assert.equal(download.text, longText, 'the item endpoint still returns the complete original text')
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('records phone-side diagnostics and upload summaries in a bounded local log', async () => {
  const root = tempRoot()
  const { server, status } = await startServer(root)
  const diagnosticsPath = join(root, 'state', 'diagnostics.log')
  try {
    const report = await postJson(status.port, `/t/${status.token}/api/diag`, {
      kind: 'page-error',
      message: 'boom: xhr failed',
      source: 'transfer-page',
      line: 42,
      detail: 'readyState=1',
    })
    assert.equal(report.status, 204)
    const firstLines = readFileSync(diagnosticsPath, 'utf8').trim().split('\n')
    const record = JSON.parse(firstLines[firstLines.length - 1])
    assert.equal(record.event, 'client')
    assert.equal(record.kind, 'page-error')
    assert.equal(record.message, 'boom: xhr failed')
    assert.equal(record.line, 42)
    assert.equal(typeof record.ua, 'string')

    const upload = await request({
      port: status.port,
      path: `/t/${status.token}/api/upload?name=diag.txt`,
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': 'diag-test-agent' },
      body: Buffer.from('diagnostic upload'),
    })
    assert.equal(upload.status, 200)
    const log = readFileSync(diagnosticsPath, 'utf8')
    assert.match(log, /"event":"upload-start"/u)
    assert.match(log, /"event":"upload-done"/u)
    assert.match(log, /diag-test-agent/u)
    assert.match(log, /"event":"upload-start",.*"diag\.txt"/u)

    // The diagnostic endpoint sits behind the session token like every other
    // API path: a wrong token is a plain 404 and writes nothing.
    const before = statSync(diagnosticsPath).size
    const denied = await postJson(status.port, '/t/not-the-token/api/diag', { message: 'x' })
    assert.equal(denied.status, 404)
    assert.equal(statSync(diagnosticsPath).size, before)
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})

test('configures browser-friendly keep-alive timeouts on the listener', async () => {
  const root = tempRoot()
  const { server } = await startServer(root)
  try {
    assert.ok(server.server !== null, 'the listener is running')
    assert.ok(server.server.keepAliveTimeout >= 60_000, 'keep-alive outlives the 2 s poll gap')
    assert.ok(server.server.headersTimeout > server.server.keepAliveTimeout, 'headersTimeout must exceed keepAliveTimeout')
    assert.ok(server.server.requestTimeout >= 60_000, 'slow uploads get the whole session')
  } finally {
    await shutdown(server)
    rmSync(root, { recursive: true, force: true })
  }
})
