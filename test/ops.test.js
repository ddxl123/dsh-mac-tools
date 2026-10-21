/**
 * Operation dispatcher tests: one implementation serves the panel and the
 * tools, so the dispatcher is exercised with an injected capture writer and
 * stubbed clipboard — no screen capture and no real clipboard writes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CaptureError } from '../src/capture.js'
import { HotkeyValidationError } from '../src/hotkey.js'
import { createOps, decodePngBase64, expandHome, isInsideDirectory, sanitizeFileName, timestampName } from '../src/ops.js'
import { ShotStore } from '../src/store.js'

/** A structurally valid PNG header (signature + IHDR). */
function pngHeader(width = 10, height = 20) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function makeHarness(overrides = {}) {
  const { config: configOverrides = {}, ...rest } = overrides
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-ops-'))
  const store = new ShotStore({ directory: join(root, 'shots'), maxShots: 3 })
  const clipboard = { copied: [], texts: '', writes: [] }
  const finder = { revealed: [] }
  const capture = {
    calls: [],
    async capture(options) {
      this.calls.push({ mode: options.mode, filePath: options.filePath })
      if (options.mode === 'interactive' || options.mode === 'interactive-region' || options.mode === 'interactive-window') {
        await new Promise((_resolve, reject) => {
          const fail = () => reject(new CaptureError('cancelled', 'cancelled'))
          if (options.signal.aborted) return fail()
          options.signal.addEventListener('abort', fail, { once: true })
        })
      }
      const bytes = pngHeader()
      writeFileSync(options.filePath, bytes)
      return {
        path: options.filePath,
        width: 10,
        height: 20,
        bytes: bytes.byteLength,
        at: new Date().toISOString(),
        mode: options.mode,
        ...(options.mode === 'app' ? { window: { id: 9, app: 'Safari', title: 'Apple' } } : {}),
      }
    },
  }
  const ops = createOps({
    config: {
      saveDirectory: join(root, 'saves'),
      maxShots: 3,
      interactiveTimeoutMs: 60_000,
      hideAppDuringCapture: true,
      ...configOverrides,
    },
    store,
    capture,
    clipboard: {
      async copyPngToClipboard(path) { clipboard.copied.push(path) },
      async copyTextToClipboard(text) { clipboard.texts = text; clipboard.writes.push(text) },
      async readTextClipboard() { return clipboard.writes[clipboard.writes.length - 1] ?? '' },
    },
    finder: async (path) => { finder.revealed.push(path) },
    warn: () => {},
    version: '9.9.9',
    ...rest,
  })
  const cleanup = () => {
    ops.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  return { root, store, clipboard, finder, capture, ops, cleanup }
}

test('status reports the configured directories and capabilities', async () => {
  const { root, ops, cleanup } = makeHarness()
  try {
    const status = await ops.dispatch('status', {})
    assert.equal(status.version, '9.9.9')
    assert.equal(status.platform, process.platform)
    assert.equal(status.saveDirectory, join(root, 'saves'))
    assert.equal(status.interactiveBusy, false)
    assert.equal(status.capabilities.screenshot, true)
  } finally {
    cleanup()
  }
})

test('capture stores a shot and exposes it through the image url', async () => {
  const { ops, store, cleanup } = makeHarness()
  try {
    const result = await ops.dispatch('capture', { mode: 'full' })
    assert.equal(result.shot.width, 10)
    assert.equal(result.shot.height, 20)
    assert.equal(result.shot.mode, 'full')
    assert.match(result.url, /^\/api\/dsh-mac-tools\?shot=/u)
    assert.ok(store.get(result.shot.id) !== undefined)
    assert.equal(store.shots.length, 1)
  } finally {
    cleanup()
  }
})

test('interactive captures report busy and can be cancelled', async () => {
  const { ops, store, cleanup } = makeHarness()
  try {
    const pending = ops.dispatch('capture', { mode: 'interactive' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal((await ops.dispatch('status', {})).interactiveBusy, true)
    await assert.rejects(ops.dispatch('capture', { mode: 'interactive-window' }), (error) => error.code === 'busy')
    const cancel = await ops.dispatch('cancelCapture', {})
    assert.equal(cancel.cancelled, true)
    await assert.rejects(pending, (error) => error.code === 'cancelled')
    assert.equal(store.shots.length, 0)
    assert.equal((await ops.dispatch('cancelCapture', {})).cancelled, false)
  } finally {
    cleanup()
  }
})

test('save writes the capture into the configured directory', async () => {
  const { ops, root, cleanup } = makeHarness()
  try {
    const captured = await ops.dispatch('capture', { mode: 'full' })
    const saved = await ops.dispatch('save', { shotId: captured.shot.id })
    assert.equal(saved.directory, join(root, 'saves'))
    assert.match(saved.fileName, /^mac-tools-\d{8}-\d{6}\.png$/u)
    assert.ok(existsSync(saved.path))
    assert.equal(readFileSync(saved.path).byteLength, 33)
  } finally {
    cleanup()
  }
})

test('save and copy accept edited base64 PNGs', async () => {
  const { ops, clipboard, root, cleanup } = makeHarness()
  try {
    const base64 = pngHeader().toString('base64')
    const saved = await ops.dispatch('save', { pngBase64: base64, fileName: 'my shot.png' })
    assert.equal(saved.fileName, 'my shot.png')
    assert.equal(saved.bytes, 33)
    assert.ok(existsSync(join(root, 'saves', 'my shot.png')))
    const copied = await ops.dispatch('copy', { pngBase64: base64 })
    assert.equal(copied.source, 'edited')
    assert.equal(clipboard.copied.length, 1)
    assert.ok(existsSync(clipboard.copied[0]))
  } finally {
    cleanup()
  }
})

test('copy accepts a stored shot id', async () => {
  const { ops, clipboard, cleanup } = makeHarness()
  try {
    const captured = await ops.dispatch('capture', { mode: 'full' })
    const copied = await ops.dispatch('copy', { shotId: captured.shot.id })
    assert.equal(copied.source, 'shot')
    assert.equal(clipboard.copied[0], captured.shot.path)
  } finally {
    cleanup()
  }
})

test('calculator answers and propagates calculator refusal codes', async () => {
  const { ops, cleanup } = makeHarness()
  try {
    const result = await ops.dispatch('calc', { expression: '2+2*2' })
    assert.equal(result.formatted, '6')
    await assert.rejects(ops.dispatch('calc', { expression: '1/0' }), (error) => error.code === 'divide_by_zero')
  } finally {
    cleanup()
  }
})

test('clipboard reads and writes text', async () => {
  const { ops, clipboard, cleanup } = makeHarness()
  try {
    const written = await ops.dispatch('clipboard', { action: 'write', text: 'hello 世界' })
    assert.equal(written.bytes, Buffer.byteLength('hello 世界'))
    assert.equal(clipboard.texts, 'hello 世界')
    const read = await ops.dispatch('clipboard', { action: 'read' })
    assert.equal(read.text, 'hello 世界')
    await assert.rejects(ops.dispatch('clipboard', { action: 'nope' }), (error) => error.code === 'invalid_request')
  } finally {
    cleanup()
  }
})

test('reveal is limited to the plugin directories', async () => {
  const { ops, finder, root, cleanup } = makeHarness()
  try {
    const captured = await ops.dispatch('capture', { mode: 'full' })
    const saved = await ops.dispatch('save', { shotId: captured.shot.id })
    const revealed = await ops.dispatch('reveal', { path: saved.path })
    assert.equal(revealed.revealed, true)
    assert.deepEqual(finder.revealed, [saved.path])
    await assert.rejects(ops.dispatch('reveal', { path: '/etc/hosts' }), (error) => error.code === 'invalid_request')
    await assert.rejects(ops.dispatch('reveal', { path: join(root, 'saves', 'missing.png') }), (error) => error.code === 'not_found')
  } finally {
    cleanup()
  }
})

test('refuses unknown endpoints and malformed payloads', async () => {
  const { ops, cleanup } = makeHarness()
  try {
    await assert.rejects(ops.dispatch('nope', {}), (error) => error.code === 'unknown_endpoint')
    await assert.rejects(ops.dispatch('copy', {}), (error) => error.code === 'invalid_request')
    await assert.rejects(ops.dispatch('save', { pngBase64: 'not base64 !' }), (error) => error.code === 'invalid_request')
  } finally {
    cleanup()
  }
})

test('decodes base64 PNG payloads including data URLs', () => {
  const bytes = pngHeader()
  assert.deepEqual(decodePngBase64(bytes.toString('base64')), bytes)
  assert.deepEqual(decodePngBase64(`data:image/png;base64,${bytes.toString('base64')}`), bytes)
  assert.throws(() => decodePngBase64(''), (error) => error.code === 'invalid_request')
  assert.throws(() => decodePngBase64(Buffer.from('not a png').toString('base64')), (error) => error.code === 'invalid_request')
})

test('pure helpers normalize paths and file names', () => {
  assert.equal(expandHome(''), join(process.env.HOME ?? '', 'Pictures', 'DSH Mac Tools'))
  assert.equal(expandHome('~'), process.env.HOME)
  assert.equal(expandHome('~/Desktop'), join(process.env.HOME ?? '', 'Desktop'))
  assert.equal(sanitizeFileName('../../etc/passwd'), '..-..-etc-passwd.png')
  assert.equal(sanitizeFileName('shot'), 'shot.png')
  assert.match(sanitizeFileName(''), /^mac-tools-\d{8}-\d{6}\.png$/u)
  assert.match(timestampName(new Date(2026, 0, 2, 3, 4, 5)), /^20260102-030405$/u)
  assert.equal(isInsideDirectory('/a/b', '/a/b/c.png'), true)
  assert.equal(isInsideDirectory('/a/b', '/a/bc/c.png'), false)
  assert.equal(isInsideDirectory('/a/b', '/a'), false)
})


/**
 * A harness whose frontmost window belongs to the Harness app, plus a
 * visibility stub that records hide/show calls.
 *
 * @param {object} [options] - overrides.
 * @param {string} [options.frontmostApp] - the app owning the frontmost window.
 * @param {boolean} [options.failCapture] - make the capture throw instead of producing a file.
 * @returns {object} the harness with `visibility` and `visibilityCalls`.
 */
function makeHidingHarness(options = {}) {
  const frontmostApp = options.frontmostApp ?? 'DeepSeek Harness'
  const visibilityCalls = []
  const visibility = {
    supported: true,
    appName: 'DeepSeek Harness',
    async hide() {
      visibilityCalls.push('hide')
      return { hidden: true, reason: 'hidden' }
    },
    async show() {
      visibilityCalls.push('show')
    },
    showDetached() {
      visibilityCalls.push('showDetached')
    },
  }
  const windows = {
    async listWindows() {
      const frontmost = { id: 1, app: frontmostApp, title: frontmostApp, x: 0, y: 0, w: 800, h: 600, frontmost: true }
      return { windows: [frontmost], frontmost }
    },
    selectWindow: () => undefined,
  }
  const harness = makeHarness({ visibility, windows, ...(options.deps ?? {}) })
  if (options.failCapture === true) {
    harness.capture.capture = async () => {
      throw new CaptureError('the capture failed', 'process_failed', {})
    }
  }
  return { ...harness, visibility, visibilityCalls }
}

test('hides the Harness window for a screen capture and restores it', async () => {
  const { ops, visibilityCalls, cleanup } = makeHidingHarness()
  try {
    const result = await ops.dispatch('capture', { mode: 'full' })
    assert.equal(result.appHidden, true)
    assert.deepEqual(visibilityCalls, ['hide', 'show'])
    const status = await ops.dispatch('status', {})
    assert.equal(status.hideAppDuringCapture, true)
    assert.equal(status.canHideApp, true)
    assert.equal(status.hostAppName, 'DeepSeek Harness')
    assert.equal(status.capabilities.hideApp, true)
  } finally {
    cleanup()
  }
})

test('does not hide when the request turns the toggle off', async () => {
  const { ops, visibilityCalls, cleanup } = makeHidingHarness()
  try {
    const result = await ops.dispatch('capture', { mode: 'full', hideApp: false })
    assert.equal(result.appHidden, false)
    assert.deepEqual(visibilityCalls, [])
  } finally {
    cleanup()
  }
})

test('does not hide when the Harness window is not frontmost', async () => {
  const { ops, visibilityCalls, cleanup } = makeHidingHarness({ frontmostApp: 'Safari' })
  try {
    const result = await ops.dispatch('capture', { mode: 'full' })
    assert.equal(result.appHidden, false)
    assert.deepEqual(visibilityCalls, [])
  } finally {
    cleanup()
  }
})

test('window-targeted captures never hide the Harness window', async () => {
  const { ops, visibilityCalls, cleanup } = makeHidingHarness()
  try {
    const result = await ops.dispatch('capture', { mode: 'window', windowId: 42 })
    assert.equal(result.appHidden, false)
    assert.deepEqual(visibilityCalls, [])
  } finally {
    cleanup()
  }
})

test('restores the Harness window when the capture itself fails', async () => {
  const { ops, visibilityCalls, cleanup } = makeHidingHarness({ failCapture: true })
  try {
    await assert.rejects(ops.dispatch('capture', { mode: 'full' }), (error) => error.code === 'capture_failed')
    assert.deepEqual(visibilityCalls, ['hide', 'show'])
  } finally {
    cleanup()
  }
})

test('disposal restores a window left hidden by an interrupted capture', async () => {
  const { ops, capture, visibilityCalls, cleanup } = makeHidingHarness()
  // A capture that never settles keeps the dispatch inside the hidden state
  // until the row is unloaded.
  capture.capture = () => new Promise(() => {})
  void ops.dispatch('capture', { mode: 'full' })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(visibilityCalls, ['hide'])
  ops.dispose()
  assert.deepEqual(visibilityCalls, ['hide', 'showDetached'])
  cleanup()
})


/**
 * A hotkey capture succeeds without any native selector: the injected capture
 * writer produces a PNG immediately.
 *
 * @param {object} harness - a hiding harness.
 * @returns {void}
 */
function useImmediateCapture(harness, extra = {}) {
  harness.capture.capture = async (options) => {
    const bytes = pngHeader(30, 40)
    writeFileSync(options.filePath, bytes)
    return {
      path: options.filePath,
      width: 30,
      height: 40,
      bytes: bytes.byteLength,
      at: new Date().toISOString(),
      mode: options.mode,
      ...extra,
    }
  }
}

test('the global hotkey captures, saves and copies without the panel', async () => {
  const soundCalls = []
  const notified = []
  const harness = makeHidingHarness({ deps: {
    sound: (name) => { soundCalls.push(name) },
    notify: async (message) => { notified.push(message) },
  } })
  useImmediateCapture(harness)
  const { ops, clipboard, root, visibilityCalls, cleanup } = harness
  try {
    const result = await ops.captureFromHotkey()
    assert.equal(result.ok, true)
    assert.equal(result.copied, true)
    assert.ok(existsSync(result.savedPath))
    assert.match(result.savedPath, /saves\/mac-tools-/u)
    assert.equal(clipboard.copied.length, 1)
    assert.equal(clipboard.copied[0], result.shot.path)
    assert.deepEqual(soundCalls, ['Glass'])
    assert.equal(notified.length, 1)
    assert.ok(notified[0].body.includes('clipboard'))
    assert.deepEqual(visibilityCalls, ['hide', 'show'])
    assert.equal((await ops.dispatch('status', {})).shotCount, 1)
  } finally {
    cleanup()
  }
})

test('cancelling the global hotkey selector is not an error and stays silent', async () => {
  const soundCalls = []
  const harness = makeHidingHarness({ deps: {
    sound: (name) => { soundCalls.push(name) },
    notify: async () => {},
  } })
  harness.capture.capture = async () => {
    throw new CaptureError('the operator cancelled the capture', 'cancelled')
  }
  const { ops, clipboard, visibilityCalls, cleanup } = harness
  try {
    const result = await ops.captureFromHotkey()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'cancelled')
    assert.equal(clipboard.copied.length, 0)
    assert.deepEqual(soundCalls, [])
    assert.deepEqual(visibilityCalls, ['hide', 'show'], 'the window must be restored after a cancelled selector')
  } finally {
    cleanup()
  }
})


/**
 * A HotkeyController stand-in that records calls.
 *
 * @param {object} [options] - overrides.
 * @returns {object} the fake controller.
 */
function fakeHotkeyController(options = {}) {
  const calls = []
  const base = {
    enabled: true,
    active: true,
    accelerator: 'ctrl+alt+a',
    label: '⌃⌥A',
    reason: 'active',
    source: 'config',
    defaultAccelerator: 'ctrl+alt+a',
    customized: false,
  }
  return {
    calls,
    status() {
      return { ...base }
    },
    async setAccelerator(accelerator) {
      calls.push(['set', accelerator])
      if (options.reject === true) throw new HotkeyValidationError('invalid shortcut', 'unknown-key')
      return { ...base, accelerator, source: 'user', customized: true, label: '⌃⇧A' }
    },
    async reset() {
      calls.push(['reset'])
      return { ...base }
    },
  }
}

test('the hotkey endpoints report, change and reset the shortcut', async () => {
  const controller = fakeHotkeyController()
  const { ops, cleanup } = makeHarness({ hotkey: controller })
  try {
    const status = await ops.dispatch('status', {})
    assert.equal(status.globalHotkey.accelerator, 'ctrl+alt+a')
    assert.equal((await ops.dispatch('hotkey', {})).label, '⌃⌥A')

    const updated = await ops.dispatch('setHotkey', { accelerator: 'ctrl+shift+a' })
    assert.equal(updated.accelerator, 'ctrl+shift+a')
    assert.equal(updated.source, 'user')
    assert.deepEqual(controller.calls, [['set', 'ctrl+shift+a']])

    const reset = await ops.dispatch('resetHotkey', {})
    assert.equal(reset.source, 'config')
    assert.deepEqual(controller.calls, [['set', 'ctrl+shift+a'], ['reset']])

    await assert.rejects(ops.dispatch('setHotkey', {}), (error) => error.code === 'invalid_request')
  } finally {
    cleanup()
  }
})

test('an invalid shortcut is answered with the stable invalid_hotkey code', async () => {
  const { ops, cleanup } = makeHarness({ hotkey: fakeHotkeyController({ reject: true }) })
  try {
    await assert.rejects(ops.dispatch('setHotkey', { accelerator: 'a' }), (error) => {
      assert.equal(error.code, 'invalid_hotkey')
      assert.equal(error.details.reason, 'unknown-key')
      return true
    })
  } finally {
    cleanup()
  }
})

test('hotkey endpoints are unavailable when the platform has no controller', async () => {
  const { ops, cleanup } = makeHarness()
  try {
    await assert.rejects(ops.dispatch('setHotkey', { accelerator: 'ctrl+shift+a' }), (error) => error.code === 'unsupported')
    await assert.rejects(ops.dispatch('resetHotkey', {}), (error) => error.code === 'unsupported')
    assert.equal((await ops.dispatch('status', {})).globalHotkey, null)
  } finally {
    cleanup()
  }
})


test('the hide-app toggle also drives the global hotkey capture', async () => {
  const harness = makeHidingHarness({ deps: {
    sound: () => {},
    notify: async () => {},
  } })
  useImmediateCapture(harness)
  const { ops, visibilityCalls, cleanup } = harness
  try {
    const first = await ops.captureFromHotkey()
    assert.equal(first.ok, true)
    assert.deepEqual(visibilityCalls, ['hide', 'show'], 'the default preference hides the window')

    visibilityCalls.length = 0
    const toggled = await ops.dispatch('setHideApp', { enabled: false })
    assert.deepEqual(toggled, { enabled: false })
    assert.equal((await ops.dispatch('status', {})).hideAppDuringCapture, false)

    const second = await ops.captureFromHotkey()
    assert.equal(second.ok, true)
    assert.deepEqual(visibilityCalls, [], 'turning the toggle off must also stop hotkey captures hiding the window')

    const third = await ops.dispatch('capture', { mode: 'full' })
    assert.equal(third.appHidden, false, 'panel captures fall back to the shared preference too')
    await assert.rejects(ops.dispatch('setHideApp', { enabled: 'yes' }), (error) => error.code === 'invalid_request')
  } finally {
    cleanup()
  }
})


/**
 * A PinManager stand-in that records the pinned buffers.
 *
 * @returns {object} the fake manager.
 */
function fakePinManager() {
  const pinned = []
  const placements = []
  return {
    pinned,
    placements,
    count: 0,
    async pin(buffer, options = {}) {
      pinned.push(buffer)
      placements.push(options.rect)
      this.count += 1
      return { ok: true, path: '/tmp/fake-pin.png', count: this.count }
    },
    dispose() {},
  }
}

test('the pin endpoint pins the edited image', async () => {
  const pins = fakePinManager()
  const { ops, cleanup } = makeHarness({ pins })
  try {
    const base64 = pngHeader(12, 34).toString('base64')
    const result = await ops.dispatch('pin', { pngBase64: base64 })
    assert.equal(result.ok, true)
    assert.equal(result.count, 1)
    assert.equal(pins.pinned.length, 1)
    assert.equal(pins.pinned[0].byteLength, 33)
    assert.equal(pins.placements[0], undefined, 'a base64-only pin has no capture rectangle')
    const status = await ops.dispatch('status', {})
    assert.equal(status.pins, 1)
    assert.equal(status.capabilities.pin, true)
  } finally {
    cleanup()
  }
})

test('pinning reports unsupported when no pin manager is mounted', async () => {
  const { ops, cleanup } = makeHarness()
  try {
    await assert.rejects(ops.dispatch('pin', { pngBase64: pngHeader().toString('base64') }), (error) => error.code === 'unsupported')
    assert.equal((await ops.dispatch('status', {})).capabilities.pin, false)
  } finally {
    cleanup()
  }
})

test('a global-hotkey capture can also pin the screenshot when configured', async () => {
  const pins = fakePinManager()
  const harness = makeHarness({
    pins,
    config: { pinAfterGlobalCapture: true, globalHotkeySound: false },
    deps: {},
  })
  useImmediateCapture(harness, { rect: { x: 11, y: 22, w: 333, h: 222 } })
  const { ops, cleanup } = harness
  try {
    const result = await ops.captureFromHotkey()
    assert.equal(result.ok, true)
    assert.equal(result.pinned, true)
    assert.equal(pins.pinned.length, 1)
    assert.deepEqual(pins.placements[0], { x: 11, y: 22, w: 333, h: 222 }, 'the pin must be placed at the capture rectangle')
  } finally {
    cleanup()
  }
})


test('pinning a stored shot uses its capture rectangle', async () => {
  const pins = fakePinManager()
  const harness = makeHarness({ pins })
  useImmediateCapture(harness, { rect: { x: 40, y: 50, w: 640, h: 480 } })
  const { ops, cleanup } = harness
  try {
    const captured = await ops.dispatch('capture', { mode: 'full' })
    const result = await ops.dispatch('pin', { pngBase64: pngHeader(10, 20).toString('base64'), shotId: captured.shot.id })
    assert.equal(result.ok, true)
    assert.deepEqual(pins.placements[0], { x: 40, y: 50, w: 640, h: 480 })
  } finally {
    cleanup()
  }
})


/**
 * An in-memory HistoryStore stand-in.
 *
 * @returns {object} the fake history.
 */
function fakeHistory() {
  let counter = 0
  const entries = []
  return {
    entries,
    maxItems: 10,
    add(capture) {
      counter += 1
      const entry = {
        id: `h${counter}`,
        width: capture.width,
        height: capture.height,
        bytes: capture.bytes,
        at: capture.at ?? new Date().toISOString(),
        mode: capture.mode ?? 'full',
        ...(capture.rect === undefined ? {} : { rect: capture.rect }),
      }
      entries.unshift(entry)
      return entry
    },
    list() {
      return entries.map((entry) => ({ ...entry }))
    },
    get(id) {
      return entries.find((entry) => entry.id === id)
    },
    read(id) {
      if (this.get(id) === undefined) throw new Error('unknown history capture')
      return pngHeader(10, 20)
    },
    remove(id) {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) return false
      entries.splice(index, 1)
      return true
    },
    clear() {
      entries.length = 0
    },
  }
}

test('captures are added to the durable history', async () => {
  const history = fakeHistory()
  const { ops, cleanup } = makeHarness({ history })
  try {
    const captured = await ops.dispatch('capture', { mode: 'full' })
    assert.equal(history.entries.length, 1)
    assert.equal(history.entries[0].width, captured.shot.width)
    assert.equal((await ops.dispatch('status', {})).historyCount, 1)
    assert.equal((await ops.dispatch('status', {})).capabilities.history, true)
  } finally {
    cleanup()
  }
})

test('history endpoints list, open, copy, pin, delete and clear', async () => {
  const history = fakeHistory()
  const pins = fakePinManager()
  const { ops, cleanup } = makeHarness({ history, pins })
  try {
    history.add({ buffer: pngHeader(30, 40), width: 30, height: 40, mode: 'full', rect: { x: 1, y: 2, w: 30, h: 40 } })
    const list = await ops.dispatch('history', {})
    assert.equal(list.total, 1)
    assert.equal(list.maxItems, 10)
    const id = list.items[0].id

    const opened = await ops.dispatch('historyOpen', { id })
    assert.equal(typeof opened.shot.id, 'string')
    assert.notEqual(opened.shot.id, id)
    assert.match(opened.url, /^\/api\/dsh-mac-tools\?shot=/u)

    assert.equal((await ops.dispatch('historyCopy', { id })).copied, true)
    const pinned = await ops.dispatch('historyPin', { id })
    assert.equal(pinned.ok, true)
    assert.deepEqual(pins.placements[0], { x: 1, y: 2, w: 30, h: 40 })

    assert.equal((await ops.dispatch('historyDelete', { id })).deleted, true)
    assert.equal(history.entries.length, 0)

    history.add({ buffer: pngHeader(5, 5), width: 5, height: 5 })
    assert.equal((await ops.dispatch('historyClear', {})).cleared, true)
    assert.equal(history.entries.length, 0)
    await assert.rejects(ops.dispatch('historyOpen', { id: 'missing' }), (error) => error.code === 'not_found')
  } finally {
    cleanup()
  }
})

test('a pinned window edit request is handed to the panel exactly once', async () => {
  const { ops, root, cleanup } = makeHarness()
  try {
    const path = join(root, 'pin-source.png')
    writeFileSync(path, pngHeader(40, 60))
    const record = ops.addPinnedEditor({ id: 'p1', path, width: 40, height: 60, rect: { x: 5, y: 6, w: 40, h: 60 } })
    assert.equal(typeof record.id, 'string')
    const first = await ops.dispatch('pendingEditor', {})
    assert.equal(first.shot.id, record.id)
    assert.deepEqual(first.shot.rect, { x: 5, y: 6, w: 40, h: 60 })
    const second = await ops.dispatch('pendingEditor', {})
    assert.equal(second.shot, null, 'the request is consumed once')
  } finally {
    cleanup()
  }
})
