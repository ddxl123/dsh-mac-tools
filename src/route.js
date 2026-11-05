/**
 * The single HTTP route below Connection's authenticated `/api` channel.
 *
 * The panel posts JSON operations here and loads captured images with a plain
 * `<img src>`; both requests are same-origin and carry the browser session
 * cookie, so nothing new needs authentication. The route answers operations
 * with a `{ ok, value }` / `{ ok, error }` envelope: a refusal like "the
 * operator cancelled the capture" is an answer the panel renders, not a
 * transport failure, so it stays HTTP 200 and the client keeps the ability to
 * tell a refusal from an unreachable Host.
 *
 * @module dsh-mac-tools/route
 */

import { OpsError } from './ops.js'

/** The exact path this plugin owns below the `/api` channel. */
export const API_PATH = '/api/dsh-mac-tools'

/**
 * Raster image types safe to render inline as a panel thumbnail.
 *
 * `image/svg+xml` is deliberately absent: an SVG document may carry script, and
 * a phone-supplied upload must never be able to run code in the Web UI origin.
 */
const INLINE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
])

/**
 * Build the route object `ctx.connection.fetch.register` accepts.
 *
 * @param {object} deps - route dependencies.
 * @param {(endpoint: string, payload: object, signal?: AbortSignal) => Promise<any>} deps.dispatch - operation dispatcher.
 * @param {(shotId: string) => Buffer} deps.readImage - screenshots by id.
 * @param {(historyId: string) => Buffer} [deps.readHistoryImage] - durable history captures by id.
 * @param {(inboxId: string) => { buffer: Buffer, mime: string, name: string }} [deps.readInboxFile] - files the phone sent, by inbox item id.
 * @param {(path: string) => Promise<{ buffer: Buffer, mime: string }>} [deps.readFile] - Files-tab inline preview (safe raster images only).
 * @param {(path: string, size?: number) => Promise<{ buffer: Buffer, mime: string }>} [deps.readThumbnail] - Files-tab Quick Look thumbnail.
 * @param {string} [deps.version] - plugin version (unused by the wire, kept for diagnostics).
 * @param {(message: string, error: unknown) => void} [deps.warn] - unexpected-failure sink.
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }} the route.
 */
export function createRoute({ dispatch, readImage, readHistoryImage, readInboxFile, readFile, readThumbnail, warn = () => {} }) {
  return {
    path: API_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url, 'http://dsh.internal')
      if (request.method === 'GET') {
        if (url.searchParams.has('file') || url.searchParams.has('thumb')) {
          return serveLocalFile(url, readFile, readThumbnail)
        }
        return serveImage(url, readImage, readHistoryImage, readInboxFile)
      }
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
      }
      return serveOperation(request, url, dispatch, warn)
    },
  }
}

/**
 * Serve one stored screenshot, history capture or phone-inbox file.
 *
 * @param {URL} url - request URL carrying `shot`, `history` or `inbox`.
 * @param {(shotId: string) => Buffer} readImage - image lookup.
 * @param {(historyId: string) => Buffer} [readHistoryImage] - history image lookup.
 * @param {(inboxId: string) => { buffer: Buffer, mime: string, name: string }} [readInboxFile] - phone-inbox file lookup.
 * @returns {Response} the bytes or a plain refusal.
 */
function serveImage(url, readImage, readHistoryImage, readInboxFile) {
  const shotId = url.searchParams.get('shot')
  const historyId = url.searchParams.get('history')
  const inboxId = url.searchParams.get('inbox')
  const hasShot = shotId !== null && shotId !== ''
  const hasHistory = historyId !== null && historyId !== ''
  const hasInbox = inboxId !== null && inboxId !== ''
  if (!hasShot && !hasHistory && !hasInbox) {
    return new Response('missing shot, history or inbox parameter', { status: 400 })
  }
  if (hasInbox) {
    if (typeof readInboxFile !== 'function') return new Response('phone inbox files are unavailable', { status: 404 })
    try {
      const file = readInboxFile(inboxId)
      const buffer = file !== null && typeof file === 'object' && Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0)
      const declaredMime = typeof file?.mime === 'string' ? file.mime.split(';', 1)[0]?.trim().toLowerCase() ?? '' : ''
      // A phone chooses the upload's bytes and its Content-Type, so this route
      // is a stored-content surface: serving e.g. `text/html` or `image/svg+xml`
      // inline on the Web UI's own origin would execute phone-supplied script.
      // Only inert raster formats stay inline; everything else is a download.
      const inline = INLINE_IMAGE_MIMES.has(declaredMime)
      const name = typeof file?.name === 'string' && file.name !== '' ? file.name : 'inbox-item'
      return new Response(buffer, {
        status: 200,
        headers: {
          'content-type': inline ? declaredMime : 'application/octet-stream',
          'content-length': String(buffer.byteLength),
          'cache-control': 'no-store',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
          'x-content-type-options': 'nosniff',
          // Defense in depth: even a mis-classified inline response cannot run
          // script or reach the network if it is opened as a document.
          'content-security-policy': "default-src 'none'; sandbox",
        },
      })
    } catch {
      return new Response('unknown phone inbox file', { status: 404 })
    }
  }
  let bytes
  try {
    bytes = hasShot
      ? readImage(shotId)
      : (typeof readHistoryImage === 'function'
        ? readHistoryImage(historyId)
        : (() => { throw new Error('history images are unavailable') })())
  } catch {
    return new Response('unknown screenshot', { status: 404 })
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Serve one Files-tab file preview or Quick Look thumbnail.
 *
 * Both are read-only views of local files behind the same authenticated route
 * as screenshots. `?file=` stays restricted to inert raster images (the Host
 * only admits png/jpeg/gif/webp/avif/bmp) and is answered with the same
 * sandbox/no-sniff headers as the phone inbox; `?thumb=` answers a PNG that
 * Quick Look produced for a document, PDF or video.
 *
 * @param {URL} url - request URL carrying `file` or `thumb` (and optional `size`).
 * @param {(path: string) => Promise<{ buffer: Buffer, mime: string }>} [readFile] - inline preview reader.
 * @param {(path: string, size?: number) => Promise<{ buffer: Buffer, mime: string }>} [readThumbnail] - thumbnail reader.
 * @returns {Promise<Response>} the bytes or a plain refusal.
 */
async function serveLocalFile(url, readFile, readThumbnail) {
  const thumbnail = url.searchParams.has('thumb')
  const path = thumbnail ? url.searchParams.get('thumb') : url.searchParams.get('file')
  if (typeof path !== 'string' || path === '') {
    return new Response('missing file or thumb parameter', { status: 400 })
  }
  try {
    let file
    if (thumbnail) {
      if (typeof readThumbnail !== 'function') return new Response('thumbnails are unavailable', { status: 404 })
      const rawSize = Number(url.searchParams.get('size'))
      file = await readThumbnail(path, Number.isFinite(rawSize) && rawSize > 0 ? rawSize : undefined)
      return imageResponse(file, 'image/png')
    }
    if (typeof readFile !== 'function') return new Response('file previews are unavailable', { status: 404 })
    file = await readFile(path)
    return imageResponse(file, file !== null && typeof file === 'object' && typeof file.mime === 'string' ? file.mime : 'application/octet-stream')
  } catch {
    return new Response('unknown or unreadable local file', { status: 404 })
  }
}

/**
 * One inline image response with the sandbox headers the panel already uses.
 *
 * @param {{ buffer: Buffer, mime?: string }} file - the bytes and their type.
 * @param {string} fallbackMime - type to use when the reader did not name one.
 * @returns {Response} the image response.
 */
function imageResponse(file, fallbackMime) {
  const buffer = file !== null && typeof file === 'object' && Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0)
  const mime = file !== null && typeof file === 'object' && typeof file.mime === 'string' && file.mime !== '' ? file.mime : fallbackMime
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(buffer.byteLength),
      'cache-control': 'no-store',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
}

/**
 * Serve one JSON operation.
 *
 * @param {Request} request - POST request.
 * @param {URL} url - parsed request URL.
 * @param {(endpoint: string, payload: object, signal?: AbortSignal) => Promise<any>} dispatch - operation dispatcher.
 * @param {(message: string, error: unknown) => void} warn - unexpected-failure sink.
 * @returns {Promise<Response>} the envelope.
 */
async function serveOperation(request, url, dispatch, warn) {
  void url
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let body
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.endpoint !== 'string') {
    return new Response('body must carry a string "endpoint"', { status: 400 })
  }
  const payload = body.payload !== null && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {}
  try {
    const value = await dispatch(body.endpoint, payload, request.signal)
    return Response.json({ ok: true, value })
  } catch (failure) {
    if (failure instanceof OpsError) {
      return Response.json({
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          details: failure.details !== null && typeof failure.details === 'object' ? failure.details : {},
        },
      })
    }
    warn(`operation ${body.endpoint} failed unexpectedly`, failure)
    return Response.json({
      ok: false,
      error: {
        code: 'internal',
        message: failure instanceof Error ? failure.message : String(failure),
        details: {},
      },
    })
  }
}
