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
 * Build the route object `ctx.connection.fetch.register` accepts.
 *
 * @param {object} deps - route dependencies.
 * @param {(endpoint: string, payload: object, signal?: AbortSignal) => Promise<any>} deps.dispatch - operation dispatcher.
 * @param {(shotId: string) => Buffer} deps.readImage - screenshots by id.
 * @param {(historyId: string) => Buffer} [deps.readHistoryImage] - durable history captures by id.
 * @param {string} [deps.version] - plugin version (unused by the wire, kept for diagnostics).
 * @param {(message: string, error: unknown) => void} [deps.warn] - unexpected-failure sink.
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }} the route.
 */
export function createRoute({ dispatch, readImage, readHistoryImage, warn = () => {} }) {
  return {
    path: API_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url, 'http://dsh.internal')
      if (request.method === 'GET') return serveImage(url, readImage, readHistoryImage)
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
      }
      return serveOperation(request, url, dispatch, warn)
    },
  }
}

/**
 * Serve one stored screenshot as an image response.
 *
 * @param {URL} url - request URL carrying `shot`.
 * @param {(shotId: string) => Buffer} readImage - image lookup.
 * @returns {Response} the image or a plain refusal.
 */
function serveImage(url, readImage, readHistoryImage) {
  const shotId = url.searchParams.get('shot')
  const historyId = url.searchParams.get('history')
  if ((shotId === null || shotId === '') && (historyId === null || historyId === '')) {
    return new Response('missing shot or history parameter', { status: 400 })
  }
  let bytes
  try {
    bytes = shotId !== null && shotId !== ''
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
