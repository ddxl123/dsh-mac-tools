/**
 * "Pin to screen": keep a captured image on top of every window.
 *
 * A Web page cannot float an image above other applications, so pinning uses a
 * small AppKit helper (`assets/pin.swift`) compiled once with `swiftc`. One
 * helper process is started per pinned image: a borderless, always-on-top
 * window that can be dragged, zoomed with the scroll wheel, copied, saved,
 * faded and closed.
 *
 * The plugin owns the pinned PNGs in a temporary directory and the helper
 * processes; unloading the plugin closes every pin. The pin window itself does
 * not depend on the harness once shown, but it exits when its parent process
 * disappears.
 *
 * @module dsh-mac-tools/pin
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readPngSize, runProcess } from './capture.js'
import { resolveSwiftc } from './hotkey.js'

/** A refused pin operation. */
export class PinError extends Error {
  /**
   * @param {string} message - diagnostic message.
   * @param {string} code - stable failure code.
   */
  constructor(message, code = 'pin_failed') {
    super(message)
    this.name = 'PinError'
    this.code = code
  }
}

/**
 * Normalize a screen rectangle for pin placement.
 *
 * @param {{ x?: unknown, y?: unknown, w?: unknown, h?: unknown } | undefined | null} rect - candidate rectangle.
 * @returns {{ x: number, y: number, w: number, h: number } | undefined} the rounded rectangle, when usable.
 */
export function placementRect(rect) {
  if (rect === null || rect === undefined || typeof rect !== 'object') return undefined
  const x = Number(rect.x)
  const y = Number(rect.y)
  const w = Number(rect.w)
  const h = Number(rect.h)
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w < 4 || h < 4) return undefined
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * Arguments the compiled pin helper expects: image, save directory, the screen
 * rectangle the capture came from (empty strings when unknown), the edit-event
 * socket and this pin's id.
 *
 * @param {string} imagePath - PNG path.
 * @param {string} saveDirectory - destination for the helper's "save" menu.
 * @param {{ x?: unknown, y?: unknown, w?: unknown, h?: unknown } | undefined} [rect] - capture rectangle.
 * @param {string} [socketPath] - Unix socket the helper reports "edit" on.
 * @param {string} [pinId] - this pin's id.
 * @returns {string[]} process arguments.
 */
export function pinArguments(imagePath, saveDirectory, rect, socketPath = '', pinId = '') {
  const placement = placementRect(rect)
  return [
    imagePath,
    saveDirectory,
    ...(placement === undefined ? ['', '', '', ''] : [String(placement.x), String(placement.y), String(placement.w), String(placement.h)]),
    socketPath,
    pinId,
  ]
}

/** @returns {string} this package's pin-helper source path. */
export function pinSourcePath() {
  return fileURLToPath(new URL('../assets/pin.swift', import.meta.url))
}

/**
 * Compile the pin helper once and cache it by source hash.
 *
 * @param {object} [options] - build options.
 * @param {string} [options.sourcePath] - `pin.swift` path.
 * @param {string} [options.cacheDirectory] - compiled-helper directory.
 * @param {string} [options.swiftc] - Swift compiler.
 * @param {typeof runProcess} [options.run] - process runner (injectable for tests).
 * @returns {Promise<string>} the executable path.
 */
export async function ensurePinHelperBinary({
  sourcePath = pinSourcePath(),
  cacheDirectory = join(tmpdir(), 'dsh-mac-tools-pin-helper'),
  swiftc = resolveSwiftc(),
  run = runProcess,
} = {}) {
  if (swiftc === undefined) {
    const error = new PinError('swiftc is not installed (install the Xcode Command Line Tools)', 'swift-missing')
    throw error
  }
  const source = readFileSync(sourcePath)
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const binary = join(cacheDirectory, `pin-${process.arch}-${hash}`)
  if (existsSync(binary)) return binary
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
  try {
    await run(swiftc, ['-O', sourcePath, '-o', binary], { timeoutMs: 120_000 })
  } catch (failure) {
    throw new PinError(`could not compile the pin helper: ${failure instanceof Error ? failure.message : String(failure)}`, 'compile-failed')
  }
  chmodSync(binary, 0o700)
  return binary
}

/**
 * Own the pinned images while the plugin row is active.
 */
export class PinManager {
  /**
   * @param {object} options - manager options.
   * @param {string} options.saveDirectory - directory the pin window's "save" menu writes to.
   * @param {string} [options.sourcePath] - pin helper source.
   * @param {string} [options.cacheDirectory] - compiled-helper directory.
   * @param {typeof ensurePinHelperBinary} [options.compile] - compiler entry (injectable for tests).
   * @param {typeof spawn} [options.spawnProcess] - child-process factory (injectable for tests).
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {string} [options.tempDirectory] - where the pinned PNGs live.
   * @param {number} [options.readyTimeoutMs] - how long a pin window may take to appear.
   * @param {(record: { id: string, path: string, width: number, height: number, rect?: object }) => void} [options.onEdit] - called when a pinned window asks to be edited in the panel.
   * @param {string} [options.eventSocketPath] - Unix socket the helpers report edits on.
   */
  constructor({
    saveDirectory,
    sourcePath = undefined,
    cacheDirectory = undefined,
    compile = ensurePinHelperBinary,
    spawnProcess = spawn,
    warn = () => {},
    tempDirectory = join(tmpdir(), `dsh-mac-tools-pins-${process.pid}`),
    readyTimeoutMs = 10_000,
    onEdit = () => {},
    eventSocketPath = join(tmpdir(), `dsh-mac-tools-pin-events-${process.pid}.sock`),
  }) {
    this.saveDirectory = saveDirectory
    this.sourcePath = sourcePath
    this.cacheDirectory = cacheDirectory
    this.compile = compile
    this.spawnProcess = spawnProcess
    this.warn = warn
    this.tempDirectory = tempDirectory
    this.readyTimeoutMs = readyTimeoutMs
    this.onEdit = onEdit
    this.eventSocketPath = eventSocketPath
    this.children = new Set()
    /** @type {Map<string, object>} pinned windows by id. */
    this.records = new Map()
    this.eventServer = null
    this.binary = null
  }

  /** @returns {number} how many images are currently pinned. */
  get count() {
    return this.children.size
  }

  /**
   * Show one PNG as a pinned floating window.
   *
   * @param {Buffer} buffer - PNG bytes.
   * @param {{ rect?: { x?: unknown, y?: unknown, w?: unknown, h?: unknown } }} [options] - placement metadata; `rect` is the screen area the capture came from, so the pin appears exactly there.
   * @returns {Promise<{ ok: true, path: string, count: number, rect?: object }>} the stored image and the pin count.
   * @throws {PinError} when the helper cannot be built, started or shown.
   */
  async pin(buffer, options = {}) {
    const rect = placementRect(options !== null && typeof options === 'object' ? options.rect : undefined)
    if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) throw new PinError('there is no image to pin', 'invalid_request')
    await this.ensureEventServer()
    mkdirSync(this.tempDirectory, { recursive: true, mode: 0o700 })
    const imagePath = join(this.tempDirectory, `pin-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`)
    writeFileSync(imagePath, buffer, { mode: 0o600 })
    let binary
    try {
      binary = this.binary !== null
        ? this.binary
        : await this.compile({
          ...(this.sourcePath === undefined ? {} : { sourcePath: this.sourcePath }),
          ...(this.cacheDirectory === undefined ? {} : { cacheDirectory: this.cacheDirectory }),
        }).then((resolved) => {
          this.binary = resolved
          return resolved
        })
    } catch (failure) {
      this.removeImage(imagePath)
      throw failure instanceof PinError ? failure : new PinError(failure instanceof Error ? failure.message : String(failure), 'compile-failed')
    }
    const pinId = `p${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    let width = 0
    let height = 0
    try {
      const size = readPngSize(buffer)
      width = size.width
      height = size.height
    } catch {
      // A non-PNG buffer is rejected by the helper itself; metadata stays empty.
    }
    let child
    try {
      child = this.spawnProcess(binary, pinArguments(imagePath, this.saveDirectory, rect, this.eventSocketPath, pinId), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (failure) {
      this.removeImage(imagePath)
      throw new PinError(`could not start the pin helper: ${failure instanceof Error ? failure.message : String(failure)}`, 'spawn-failed')
    }
    this.children.add(child)
    this.records.set(pinId, { id: pinId, path: imagePath, width, height, ...(rect === undefined ? {} : { rect }) })
    child.on('exit', () => {
      this.children.delete(child)
      this.records.delete(pinId)
      this.removeImage(imagePath)
    })
    try {
      await this.waitForReady(child)
    } catch (failure) {
      this.children.delete(child)
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      this.removeImage(imagePath)
      throw failure
    }
    return { ok: true, path: imagePath, count: this.children.size, ...(rect === undefined ? {} : { rect }) }
  }

  /**
   * Start the Unix socket the pinned windows use to ask for the panel editor.
   *
   * @returns {Promise<void>} resolves once the socket is listening.
   */
  async ensureEventServer() {
    if (this.eventServer !== null) return
    try {
      rmSync(this.eventSocketPath, { force: true })
    } catch {
      // A stale socket surfaces through listen().
    }
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        buffer += chunk
        if (buffer.length > 512) buffer = buffer.slice(-512)
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        socket.destroy()
        this.handleEvent(line)
      })
      socket.on('error', () => {})
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.eventSocketPath)
    })
    try {
      chmodSync(this.eventSocketPath, 0o600)
    } catch (failure) {
      this.warn('could not restrict the pin event socket permissions', failure)
    }
    this.eventServer = server
  }

  /**
   * Handle one line from a pinned window.
   *
   * @param {string} line - e.g. `edit p123abc`.
   * @returns {void}
   */
  handleEvent(line) {
    if (!line.startsWith('edit ')) return
    const id = line.slice(5).trim()
    const record = this.records.get(id)
    if (record === undefined) return
    try {
      this.onEdit(record)
    } catch (failure) {
      this.warn('could not hand a pinned image to the panel editor', failure)
    }
  }

  /**
   * Resolve once the helper reports READY.
   *
   * @param {object} child - spawned helper process.
   * @returns {Promise<void>} resolves when the pin window is up.
   */
  async waitForReady(child) {
    await new Promise((resolve, reject) => {
      let settled = false
      let stderr = ''
      const timer = setTimeout(() => {
        settle(new PinError('the pin window did not appear in time', 'timeout'))
      }, this.readyTimeoutMs)
      /* eslint-disable-next-line unicorn/consistent-function-scoping */
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) resolve()
        else reject(error)
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk)
        if (/^READY/mu.test(text)) settle(undefined)
        else {
          const match = /^ERROR (.+)$/mu.exec(text)
          if (match !== null) settle(new PinError(match[1].trim(), 'helper-error'))
        }
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => {
        settle(new PinError(error.message, 'spawn-failed'))
      })
      child.on('exit', (code, signal) => {
        settle(new PinError(`the pin helper exited before opening a window (${signal ?? code})${stderr === '' ? '' : `: ${stderr.trim().slice(0, 200)}`}`, 'helper-exited'))
      })
    })
  }

  /**
   * @param {string} imagePath - temporary PNG path.
   * @returns {void}
   */
  removeImage(imagePath) {
    try {
      rmSync(imagePath, { force: true })
    } catch {
      // Best effort; the temporary directory is removed on dispose.
    }
  }

  /** Close every pinned window and remove the temporary images. */
  dispose() {
    for (const child of this.children) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
    this.children.clear()
    this.records.clear()
    if (this.eventServer !== null) {
      try {
        this.eventServer.close()
      } catch {
        // Already closed.
      }
      this.eventServer = null
    }
    try {
      rmSync(this.eventSocketPath, { force: true })
    } catch {
      // Best effort.
    }
    try {
      rmSync(this.tempDirectory, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
}
