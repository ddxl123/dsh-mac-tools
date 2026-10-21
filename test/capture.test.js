/**
 * Capture-layer tests: argument construction, PNG validation, failure
 * classification, process deadlines and AppleScript escaping. No real capture
 * runs here, so the suite needs no screen permission.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CAPTURE_MODES,
  CaptureError,
  buildCaptureArgs,
  capture,
  classifyCaptureFailure,
  escapeAppleScriptString,
  isInteractiveMode,
  readPngSize,
  rectFromRequest,
  rectFromWindow,
  runProcess,
} from '../src/capture.js'

/** A structurally valid PNG header (signature + IHDR) without real pixel data. */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

test('every mode produces a complete screencapture invocation', () => {
  assert.deepEqual(buildCaptureArgs({ mode: 'full', filePath: '/tmp/a.png' }), ['-x', '-m', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'interactive', filePath: '/tmp/a.png' }), ['-i', '-x', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'interactive-region', filePath: '/tmp/a.png' }), ['-i', '-s', '-x', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'interactive-window', filePath: '/tmp/a.png' }), ['-i', '-w', '-x', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'window', windowId: 42, filePath: '/tmp/a.png' }), ['-x', '-o', '-l42', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'display', display: 2, filePath: '/tmp/a.png' }), ['-x', '-D2', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'rect', rect: { x: 1, y: 2, w: 300, h: 200 }, filePath: '/tmp/a.png' }), ['-x', '-R', '1,2,300,200', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'full', includeCursor: true, delaySeconds: 3, filePath: '/tmp/a.png' }), ['-x', '-m', '-C', '-T3', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'app', filePath: '/tmp/a.png' }), ['-x', '-o', '-t', 'png', '/tmp/a.png'])
  assert.deepEqual(buildCaptureArgs({ mode: 'frontmost', filePath: '/tmp/a.png' }), ['-x', '-o', '-t', 'png', '/tmp/a.png'])
})

test('modes reject missing or malformed targets', () => {
  assert.throws(() => buildCaptureArgs({ mode: 'nope', filePath: '/tmp/a.png' }), (error) => error.code === 'invalid_request')
  assert.throws(() => buildCaptureArgs({ mode: 'window', filePath: '/tmp/a.png' }), (error) => error.code === 'invalid_request')
  assert.throws(() => buildCaptureArgs({ mode: 'display', display: 0, filePath: '/tmp/a.png' }), (error) => error.code === 'invalid_request')
  assert.throws(() => buildCaptureArgs({ mode: 'rect', rect: { x: 0, y: 0, w: 0, h: 10 }, filePath: '/tmp/a.png' }), (error) => error.code === 'invalid_request')
  assert.deepEqual(CAPTURE_MODES.includes('interactive'), true)
  assert.equal(isInteractiveMode('interactive-window'), true)
  assert.equal(isInteractiveMode('full'), false)
})

test('PNG dimensions come from the IHDR chunk', () => {
  assert.deepEqual(readPngSize(pngHeader(3024, 1964)), { width: 3024, height: 1964 })
  assert.throws(() => readPngSize(Buffer.from('not a png')), (error) => error.code === 'capture_failed')
  assert.throws(() => readPngSize(Buffer.alloc(40)), (error) => error.code === 'capture_failed')
})

test('failures map to stable operation codes', () => {
  const permission = classifyCaptureFailure(new CaptureError(
    'The capture did not produce a PNG image',
    'process_failed',
    { stderr: 'screencapture: could not create image from window (not authorized)' },
  ))
  assert.equal(permission.code, 'permission')
  const cancelled = new CaptureError('cancelled', 'cancelled')
  assert.equal(classifyCaptureFailure(cancelled), cancelled)
  const timeout = classifyCaptureFailure(new CaptureError('timed out', 'timeout'))
  assert.equal(timeout.code, 'timeout')
  const generic = classifyCaptureFailure(new CaptureError('boom', 'process_failed', { stderr: 'other failure' }))
  assert.equal(generic.code, 'process_failed')
})

test('AppleScript paths are escaped inside the quoted literal', () => {
  assert.equal(escapeAppleScriptString('/tmp/a.png'), '/tmp/a.png')
  assert.equal(escapeAppleScriptString('/tmp/a "quoted".png'), '/tmp/a \\"quoted\\".png')
  assert.equal(escapeAppleScriptString('C:\\tmp\\x.png'), 'C:\\\\tmp\\\\x.png')
  assert.equal(escapeAppleScriptString('a\nb'), 'a\\nb')
})

test('runProcess captures output, honours stdin, deadlines and aborts', async () => {
  const cat = await runProcess('/bin/cat', [], { timeoutMs: 5000, stdin: 'hello' })
  assert.equal(cat.stdout, 'hello')

  await assert.rejects(
    runProcess('/bin/sleep', ['5'], { timeoutMs: 120 }),
    (error) => error instanceof CaptureError && error.code === 'timeout',
  )

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 80)
  await assert.rejects(
    runProcess('/bin/sleep', ['5'], { timeoutMs: 10_000, signal: controller.signal }),
    (error) => error instanceof CaptureError && error.code === 'cancelled',
  )

  await assert.rejects(
    runProcess('/definitely/not/a/program', []),
    (error) => error instanceof CaptureError && error.code === 'exec_failed',
  )
})


test('normalizes window and request rectangles', () => {
  assert.deepEqual(rectFromWindow({ x: 10, y: 20, w: 300, h: 200 }), { x: 10, y: 20, w: 300, h: 200 })
  assert.equal(rectFromWindow({ x: 10, y: 20, w: 2, h: 200 }), undefined)
  assert.equal(rectFromWindow(undefined), undefined)
  assert.deepEqual(rectFromRequest({ x: 1, y: 2, w: 30, h: 40 }), { x: 1, y: 2, w: 30, h: 40 })
})

/**
 * Run one capture against a fake screencapture that writes a PNG.
 *
 * @param {object} options - capture options.
 * @returns {Promise<{ result: object, calls: string[][] }>} the capture and the recorded invocations.
 */
async function captureWithFakeScreen(options) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-capture-'))
  const calls = []
  const run = async (_command, args) => {
    calls.push(args)
    writeFileSync(args[args.length - 1], pngHeader(20, 10))
    return { stdout: '', stderr: '', code: 0 }
  }
  try {
    const result = await capture({ filePath: join(directory, 'shot.png'), run, ...options })
    return { result, calls }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('window captures carry the window rectangle for pin placement', async () => {
  const { result } = await captureWithFakeScreen({
    mode: 'window',
    windowId: 7,
    window: { id: 7, app: 'Safari', title: 'Apple', x: 120, y: 80, w: 600, h: 400 },
  })
  assert.deepEqual(result.rect, { x: 120, y: 80, w: 600, h: 400 })
  assert.deepEqual(result.window, { id: 7, app: 'Safari', title: 'Apple' })
})

test('rect and full captures carry their screen rectangle', async () => {
  const rect = await captureWithFakeScreen({ mode: 'rect', rect: { x: 30, y: 40, w: 300, h: 200 } })
  assert.deepEqual(rect.result.rect, { x: 30, y: 40, w: 300, h: 200 })

  const full = await captureWithFakeScreen({
    mode: 'full',
    displayBounds: async () => ({ x: 0, y: 0, w: 1512, h: 982 }),
  })
  assert.deepEqual(full.result.rect, { x: 0, y: 0, w: 1512, h: 982 })
})

test('interactive captures adopt the rectangle the watcher saw', async () => {
  class FakeTracker {
    async start() {}

    async finish() {
      return { rect: { x: 5, y: 6, w: 301, h: 201 } }
    }

    cancel() {}
  }
  const { result } = await captureWithFakeScreen({
    mode: 'interactive',
    SelectionTrackerClass: FakeTracker,
  })
  assert.deepEqual(result.rect, { x: 5, y: 6, w: 301, h: 201 })
})

test('a cancelled interactive capture stops the watcher', async () => {
  const cancelCalls = []
  class FakeTracker {
    async start() {}

    async finish() {
      return {}
    }

    cancel() {
      cancelCalls.push(true)
    }
  }
  await assert.rejects(
    capture({
      mode: 'interactive',
      filePath: '/tmp/never.png',
      SelectionTrackerClass: FakeTracker,
      run: async () => {
        throw new CaptureError('cancelled', 'cancelled')
      },
    }),
    (error) => error.code === 'cancelled',
  )
  assert.deepEqual(cancelCalls, [true])
})
