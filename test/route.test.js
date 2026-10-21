/**
 * HTTP route tests: the panel depends on the envelope, the image response and
 * the method/content-type guards, so all of them are exercised through real
 * `Request`/`Response` objects with no server.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OpsError } from '../src/ops.js'
import { API_PATH, createRoute } from '../src/route.js'
import { pngHeaderBytes } from './route-fixtures.js'

/** A structurally valid PNG header (signature + IHDR). */
function pngHeader(width = 12, height = 34) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function makeRoute(overrides = {}) {
  const calls = []
  const route = createRoute({
    dispatch: async (endpoint, payload, signal) => {
      calls.push({ endpoint, payload, hasSignal: signal !== undefined })
      if (endpoint === 'explode') throw new OpsError('capture_failed', 'the capture failed', { detail: 1 })
      if (endpoint === 'bug') throw new Error('unexpected bug')
      return { echo: endpoint, payload }
    },
    readImage: (shotId) => {
      if (shotId !== 'sgood') throw new Error('unknown')
      return pngHeader()
    },
    readHistoryImage: (historyId) => {
      if (historyId !== 'hgood') throw new Error('unknown')
      return pngHeaderBytes()
    },
    warn: () => {},
    ...overrides,
  })
  return { route, calls }
}

function post(body, headers = { 'content-type': 'application/json' }) {
  return new Request(`http://127.0.0.1:1234${API_PATH}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('serves a stored screenshot as PNG bytes', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(new Request(`http://127.0.0.1:1234${API_PATH}?shot=sgood`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.byteLength, 33)
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

test('refuses an unknown or missing screenshot', async () => {
  const { route } = makeRoute()
  const unknown = await route.fetch(new Request(`http://127.0.0.1:1234${API_PATH}?shot=nope`))
  assert.equal(unknown.status, 404)
  const missing = await route.fetch(new Request(`http://127.0.0.1:1234${API_PATH}`))
  assert.equal(missing.status, 400)
})

test('answers a successful operation with the envelope', async () => {
  const { route, calls } = makeRoute()
  const response = await route.fetch(post({ endpoint: 'status', payload: { a: 1 } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body, { ok: true, value: { echo: 'status', payload: { a: 1 } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].hasSignal, true)
})

test('answers a refused operation with its stable code', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(post({ endpoint: 'explode' }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'capture_failed')
  assert.equal(body.error.message, 'the capture failed')
  assert.deepEqual(body.error.details, { detail: 1 })
})

test('turns an unexpected dispatcher failure into an internal envelope', async () => {
  const warnings = []
  const { route } = makeRoute({ warn: (message) => warnings.push(message) })
  const response = await route.fetch(post({ endpoint: 'bug' }))
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'internal')
  assert.equal(warnings.length, 1)
})

test('guards method, content type and body shape', async () => {
  const { route } = makeRoute()
  const put = await route.fetch(new Request(`http://127.0.0.1:1234${API_PATH}`, { method: 'PUT' }))
  assert.equal(put.status, 405)
  assert.equal(put.headers.get('allow'), 'GET, POST')

  const wrongType = await route.fetch(post({ endpoint: 'status' }, { 'content-type': 'text/plain' }))
  assert.equal(wrongType.status, 415)

  const badJson = await route.fetch(post('{nope'))
  assert.equal(badJson.status, 400)

  const noEndpoint = await route.fetch(post({ payload: {} }))
  assert.equal(noEndpoint.status, 400)
})

test('the route object declares the contract Connection registers', () => {
  const { route } = makeRoute()
  assert.equal(route.path, '/api/dsh-mac-tools')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
})


test('serves durable history captures through the same image route', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(new Request(`http://127.0.0.1:1234${API_PATH}?history=hgood`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.byteLength, 33)

  const unknown = await route.fetch(new Request(`http://127.0.0.1:1234${API_PATH}?history=nope`))
  assert.equal(unknown.status, 404)
})
