/**
 * The system-wide screenshot hotkey.
 *
 * A Web page cannot receive keystrokes while another application has focus, so
 * a QQ-style global shortcut needs a native listener. This module owns that
 * listener without asking the user for Accessibility permission:
 *
 * 1. `assets/hotkey.swift` is compiled once with `swiftc` into a small cached
 *    binary. It registers one Carbon `RegisterEventHotKey` shortcut (which the
 *    window server delivers to any process without special permission) and,
 *    when the shortcut fires, connects to this plugin's private Unix socket and
 *    writes `screenshot`.
 * 2. This module runs that Unix socket server. A trigger calls the plugin's
 *    capture flow, which opens macOS's native region/window selector, copies
 *    the result to the clipboard and saves it.
 *
 * The helper is a child of the Harness host process: it exits on its own when
 * the parent disappears, and the plugin kills it on unload. Compilation needs
 * the Xcode Command Line Tools; when they are missing the feature degrades to
 * "unavailable" and the in-panel shortcut keeps working.
 *
 * @module dsh-mac-tools/hotkey
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from './capture.js'

/** Default global accelerator: QQ's Ctrl+Alt+A, spelled for this parser. */
export const DEFAULT_GLOBAL_ACCELERATOR = 'ctrl+alt+a'

/**
 * Carbon virtual key codes for the keys a shortcut may use.
 * @see HIToolbox/Events.h
 */
export const KEY_CODES = Object.freeze({
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
  q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34,
  p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25, 0: 29,
  '=': 24, '-': 27, ']': 30, '[': 33, "'": 39, ';': 41, '\\': 42,
  ',': 43, '/': 44, '.': 47, '`': 50,
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
  f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
})

/** Carbon modifier masks. */
export const MODIFIER_MASKS = Object.freeze({
  ctrl: 4096,
  control: 4096,
  alt: 2048,
  option: 2048,
  opt: 2048,
  shift: 512,
  cmd: 256,
  command: 256,
  meta: 256,
  super: 256,
  primary: 256,
})

/** Canonical modifier order for display and normalization. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd']
const MODIFIER_SYMBOLS = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' }
const MODIFIER_CANONICAL = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt',
  shift: 'shift',
  cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', primary: 'cmd',
}

/** Human labels for non-letter keys. */
const KEY_LABELS = Object.freeze({
  return: 'Return', enter: 'Return', tab: 'Tab', space: 'Space',
  delete: 'Delete', backspace: 'Delete', escape: 'Esc', esc: 'Esc',
  left: '←', right: '→', up: '↑', down: '↓',
})

/**
 * Parse an accelerator such as `ctrl+alt+a` or `primary+shift+keyA`.
 *
 * @param {unknown} input - configured accelerator text.
 * @returns {{ valid: true, accelerator: string, keyCode: number, modifiers: number, label: string } | { valid: false, error: string, accelerator: string }} the parse result.
 */
export function parseAccelerator(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return { valid: false, error: 'empty', accelerator: '' }
  const parts = raw.split('+').map((part) => part.trim().toLowerCase()).filter((part) => part !== '')
  if (parts.length < 2) return { valid: false, error: 'missing-modifier-or-key', accelerator: raw }
  const keyToken = /** @type {string} */ (parts.pop()).replace(/^key/u, '')
  const keyCode = KEY_CODES[keyToken]
  if (keyCode === undefined) return { valid: false, error: 'unknown-key', accelerator: raw }
  const seen = new Set()
  for (const part of parts) {
    const canonical = MODIFIER_CANONICAL[part]
    if (canonical === undefined) return { valid: false, error: 'unknown-modifier', accelerator: raw }
    seen.add(canonical)
  }
  if (seen.size === 0) return { valid: false, error: 'missing-modifier', accelerator: raw }
  let modifiers = 0
  const ordered = []
  for (const name of MODIFIER_ORDER) {
    if (!seen.has(name)) continue
    modifiers |= MODIFIER_MASKS[name]
    ordered.push(name)
  }
  const label = `${ordered.map((name) => MODIFIER_SYMBOLS[name]).join('')}${keyLabel(keyToken)}`
  return {
    valid: true,
    accelerator: [...ordered, keyToken].join('+'),
    keyCode,
    modifiers,
    label,
  }
}

/**
 * @param {string} keyToken - normalized key token.
 * @returns {string} the display label.
 */
function keyLabel(keyToken) {
  if (KEY_LABELS[keyToken] !== undefined) return KEY_LABELS[keyToken]
  if (/^f\d{1,2}$/u.test(keyToken)) return keyToken.toUpperCase()
  return keyToken.toUpperCase()
}

/**
 * Arguments the compiled helper expects.
 *
 * @param {{ keyCode: number, modifiers: number }} parsed - parsed accelerator.
 * @param {string} socketPath - Unix socket to notify.
 * @returns {string[]} process arguments.
 */
export function helperArguments(parsed, socketPath) {
  return [String(parsed.keyCode), String(parsed.modifiers), socketPath]
}

/** @returns {string} this package's helper source path. */
export function helperSourcePath() {
  return fileURLToPath(new URL('../assets/hotkey.swift', import.meta.url))
}

/**
 * Locate a Swift compiler.
 *
 * @returns {string | undefined} the executable, when the toolchain is installed.
 */
export function resolveSwiftc() {
  for (const candidate of ['/usr/bin/swiftc', '/usr/local/bin/swiftc', '/opt/homebrew/bin/swiftc']) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Compile the helper once and cache the binary by source hash.
 *
 * @param {object} options - build options.
 * @param {string} options.sourcePath - `hotkey.swift` path.
 * @param {string} [options.cacheDirectory] - where compiled helpers live.
 * @param {string} [options.swiftc] - compiler executable.
 * @param {typeof runProcess} [options.run] - process runner (injectable for tests).
 * @returns {Promise<string>} the executable path.
 * @throws {Error} when the toolchain is missing or compilation fails.
 */
export async function ensureHelperBinary({
  sourcePath,
  cacheDirectory = join(tmpdir(), 'dsh-mac-tools-hotkey'),
  swiftc = resolveSwiftc(),
  run = runProcess,
}) {
  if (swiftc === undefined) {
    const error = new Error('swiftc is not installed (install the Xcode Command Line Tools)')
    error.code = 'swift-missing'
    throw error
  }
  const source = readFileSync(sourcePath)
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const binary = join(cacheDirectory, `hotkey-${process.arch}-${hash}`)
  if (existsSync(binary)) return binary
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
  try {
    await run(swiftc, ['-O', sourcePath, '-o', binary], { timeoutMs: 120_000 })
  } catch (failure) {
    throw new Error(`could not compile the hotkey helper: ${failure instanceof Error ? failure.message : String(failure)}`)
  }
  chmodSync(binary, 0o700)
  return binary
}

/** Refusal of the hotkey service, carrying a stable status reason. */
export class HotkeyError extends Error {
  /**
   * @param {string} reason - stable service reason.
   * @param {string} message - diagnostic message.
   */
  constructor(reason, message) {
    super(message)
    this.name = 'HotkeyError'
    this.reason = reason
  }
}

/**
 * Own the global hotkey while the plugin row is active.
 */
export class GlobalHotkey {
  /**
   * @param {object} options - service options.
   * @param {string} [options.accelerator] - configured accelerator text.
   * @param {() => (void | Promise<void>)} options.onTrigger - called when the shortcut fires.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {string} [options.sourcePath] - helper Swift source.
   * @param {string} [options.cacheDirectory] - compiled-helper directory.
   * @param {string} [options.socketPath] - Unix socket path.
   * @param {typeof ensureHelperBinary} [options.compile] - compiler entry (injectable for tests).
   * @param {typeof spawn} [options.spawnProcess] - child-process factory (injectable for tests).
   * @param {number} [options.readyTimeoutMs] - how long the helper may take to arm.
   */
  constructor({
    accelerator = DEFAULT_GLOBAL_ACCELERATOR,
    onTrigger,
    warn = () => {},
    sourcePath = helperSourcePath(),
    cacheDirectory = undefined,
    socketPath = join(tmpdir(), `dsh-mac-tools-hotkey-${process.pid}.sock`),
    compile = ensureHelperBinary,
    spawnProcess = spawn,
    readyTimeoutMs = 10_000,
  }) {
    this.onTrigger = onTrigger
    this.warn = warn
    this.sourcePath = sourcePath
    this.cacheDirectory = cacheDirectory
    this.socketPath = socketPath
    this.compile = compile
    this.spawnProcess = spawnProcess
    this.readyTimeoutMs = readyTimeoutMs
    this.parsed = parseAccelerator(accelerator)
    this.configured = typeof accelerator === 'string' ? accelerator.trim() : ''
    this.server = null
    this.helper = null
    this.active = false
    this.reason = this.configured === '' ? 'disabled' : (this.parsed.valid ? 'starting' : 'invalid-accelerator')
    this.disposed = false
    this.retries = 0
    this.restartTimer = null
  }

  /** @returns {{ enabled: boolean, active: boolean, accelerator: string, label: string, reason: string }} the public state. */
  status() {
    return {
      enabled: this.configured !== '' && this.parsed.valid,
      active: this.active,
      accelerator: this.parsed.valid ? this.parsed.accelerator : this.configured,
      label: this.parsed.valid ? this.parsed.label : '',
      reason: this.reason,
    }
  }

  /**
   * Start the socket server and the helper. Safe to call once; failures are
   * recorded in `status().reason` instead of throwing.
   *
   * @returns {Promise<{ enabled: boolean, active: boolean, accelerator: string, label: string, reason: string }>} the settled state.
   */
  async start() {
    if (this.configured === '') return this.status()
    if (!this.parsed.valid) {
      this.warn(`global hotkey ${JSON.stringify(this.configured)} is not a valid accelerator (${this.parsed.error})`)
      return this.status()
    }
    try {
      await this.startServer()
    } catch (failure) {
      this.reason = 'server-failed'
      this.warn('could not open the hotkey socket', failure)
      return this.status()
    }
    await this.armHelper()
    return this.status()
  }

  /** @returns {Promise<void>} resolves once the Unix socket is listening. */
  async startServer() {
    if (this.server !== null) return
    const socketPath = this.socketPath
    try {
      rmSync(socketPath, { force: true })
    } catch {
      // A stale socket that cannot be removed surfaces through listen().
    }
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        buffer += chunk
        if (buffer.length > 256) buffer = buffer.slice(-256)
        if (buffer.includes('screenshot')) {
          buffer = ''
          this.emitTrigger()
        }
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
      server.listen(socketPath)
    })
    try {
      chmodSync(socketPath, 0o600)
    } catch (failure) {
      this.warn('could not restrict the hotkey socket permissions', failure)
    }
    this.server = server
  }

  /** Call the capture flow for one hotkey press. */
  emitTrigger() {
    try {
      const result = this.onTrigger()
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.catch((failure) => this.warn('the hotkey capture failed', failure))
      }
    } catch (failure) {
      this.warn('the hotkey capture failed', failure)
    }
  }

  /**
   * Compile and spawn the helper, then wait until it reports READY.
   *
   * @returns {Promise<void>} resolves when armed; failures are recorded.
   */
  async armHelper() {
    if (this.disposed) return
    let binary
    try {
      binary = await this.compile({
        sourcePath: this.sourcePath,
        ...(this.cacheDirectory === undefined ? {} : { cacheDirectory: this.cacheDirectory }),
      })
    } catch (failure) {
      this.reason = failure !== null && typeof failure === 'object' && 'code' in failure && failure.code === 'swift-missing'
        ? 'swift-missing'
        : 'compile-failed'
      this.warn(`global hotkey disabled: ${failure instanceof Error ? failure.message : String(failure)}`)
      return
    }
    if (this.disposed) return
    let child
    try {
      child = this.spawnProcess(binary, helperArguments(this.parsed, this.socketPath), {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (failure) {
      this.reason = 'spawn-failed'
      this.warn('could not start the hotkey helper', failure)
      return
    }
    this.helper = child
    await new Promise((resolve) => {
      let settled = false
      let stderr = ''
      const timer = setTimeout(() => {
        settle(new HotkeyError('register-failed', 'the hotkey helper did not arm in time'))
      }, this.readyTimeoutMs)
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) {
          this.active = true
          this.reason = 'active'
          this.retries = 0
          resolve()
          return
        }
        this.active = false
        this.reason = error.reason ?? 'register-failed'
        this.warn(`global hotkey unavailable: ${error.message}${stderr === '' ? '' : ` (${stderr.trim().slice(0, 200)})`}`)
        resolve()
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk)
        if (/^READY/mu.test(text)) settle(undefined)
        else {
          const match = /^ERROR (.+)$/mu.exec(text)
          if (match !== null) settle(new HotkeyError('register-failed', match[1].trim()))
        }
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => settle(new HotkeyError('spawn-failed', error.message)))
      child.on('exit', (code, signal) => {
        if (!settled) {
          settle(new HotkeyError('helper-exited', `the hotkey helper exited (${signal ?? code})`))
          return
        }
        this.helper = null
        if (this.disposed) return
        this.active = false
        this.reason = 'helper-exited'
        if (this.retries >= 3) return
        this.retries += 1
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          if (!this.disposed) void this.armHelper()
        }, 1500)
      })
    })
  }

  /** Stop the helper, close the socket and remove it. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.reason = 'disposed'
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.helper !== null) {
      try {
        this.helper.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      this.helper = null
    }
    if (this.server !== null) {
      try {
        this.server.close()
      } catch {
        // Already closed.
      }
      this.server = null
    }
    try {
      rmSync(this.socketPath, { force: true })
    } catch {
      // Nothing to clean up.
    }
  }
}


/** A refused accelerator change, carrying the parser's reason. */
export class HotkeyValidationError extends Error {
  /**
   * @param {string} message - operator-facing description.
   * @param {string} reason - stable reason code.
   */
  constructor(message, reason) {
    super(message)
    this.name = 'HotkeyValidationError'
    this.reason = reason
  }
}

/**
 * Validate an accelerator supplied by the configuration or the panel.
 *
 * @param {unknown} input - accelerator text.
 * @returns {ReturnType<typeof parseAccelerator>} the parsed accelerator.
 * @throws {HotkeyValidationError} when it is unusable.
 */
export function validateAcceleratorInput(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') throw new HotkeyValidationError('the shortcut is empty', 'empty')
  if (text.length > 40) throw new HotkeyValidationError('the shortcut description is too long', 'too-long')
  const parsed = parseAccelerator(text)
  if (!parsed.valid) {
    const why = parsed.error === 'unknown-key'
      ? 'the key is not supported'
      : parsed.error === 'unknown-modifier'
        ? 'only ctrl, alt, shift and cmd modifiers are supported'
        : 'write it as modifiers+key, e.g. ctrl+alt+a'
    throw new HotkeyValidationError(`invalid shortcut: ${why}`, parsed.error)
  }
  const primary = parsed.modifiers & (MODIFIER_MASKS.ctrl | MODIFIER_MASKS.alt | MODIFIER_MASKS.cmd)
  if (primary === 0) {
    throw new HotkeyValidationError('the shortcut needs at least Control, Option or Command, not only Shift', 'missing-primary-modifier')
  }
  return parsed
}

/**
 * Read the user's accelerator override from its JSON file.
 *
 * @param {string} statePath - `hotkey.json` path.
 * @returns {string | undefined} the stored accelerator, when present and valid.
 */
export function readHotkeyOverride(statePath) {
  try {
    const document = JSON.parse(readFileSync(statePath, 'utf8'))
    const accelerator = document !== null && typeof document === 'object' ? document.accelerator : undefined
    if (typeof accelerator === 'string' && accelerator.trim() !== '') {
      validateAcceleratorInput(accelerator)
      return accelerator.trim()
    }
  } catch {
    // A missing or corrupt override falls back to the configured default.
  }
  return undefined
}

/**
 * Persist one accelerator override atomically.
 *
 * @param {string} statePath - `hotkey.json` path.
 * @param {string} accelerator - validated accelerator.
 * @returns {void}
 */
export function writeHotkeyOverride(statePath, accelerator) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify({ accelerator }, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, statePath)
}

/**
 * Remove the user override, returning to the configured default.
 *
 * @param {string} statePath - `hotkey.json` path.
 * @returns {void}
 */
export function clearHotkeyOverride(statePath) {
  rmSync(statePath, { force: true })
}

/**
 * Own the current global-hotkey service and the user's persisted choice.
 *
 * The row configuration supplies the default accelerator; a panel-level change
 * is stored in a small JSON file next to the plugin's other state, takes
 * precedence from then on, and can be reset back to the configured default.
 */
export class HotkeyController {
  /**
   * @param {object} options - controller options.
   * @param {string} [options.defaultAccelerator] - configured default ('' disables).
   * @param {string | undefined} [options.statePath] - override file; omit to keep changes in memory.
   * @param {() => (void | Promise<void>)} options.onTrigger - hotkey callback.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {string} [options.sourcePath] - helper Swift source.
   * @param {string} [options.cacheDirectory] - compiled-helper directory.
   * @param {string} [options.socketPath] - Unix socket path.
   * @param {typeof GlobalHotkey} [options.Service] - service class (injectable for tests).
   */
  constructor({
    defaultAccelerator = DEFAULT_GLOBAL_ACCELERATOR,
    statePath = undefined,
    onTrigger,
    warn = () => {},
    sourcePath = undefined,
    cacheDirectory = undefined,
    socketPath = undefined,
    Service = GlobalHotkey,
  }) {
    this.defaultAccelerator = typeof defaultAccelerator === 'string' ? defaultAccelerator.trim() : ''
    this.statePath = statePath
    this.onTrigger = onTrigger
    this.warn = warn
    this.sourcePath = sourcePath
    this.cacheDirectory = cacheDirectory
    this.socketPath = socketPath
    this.Service = Service
    this.service = null
    this.override = statePath === undefined ? undefined : readHotkeyOverride(statePath)
    this.source = this.override === undefined ? 'config' : 'user'
    this.current = this.override === undefined ? this.defaultAccelerator : this.override
    /** Serializes changes so two fast clicks cannot leave two helpers running. */
    this.queue = Promise.resolve()
  }

  /**
   * @param {() => Promise<any>} task - operation to serialize.
   * @returns {Promise<any>} the task result.
   */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** @returns {{ enabled: boolean, active: boolean, accelerator: string, label: string, reason: string, source: 'config' | 'user', defaultAccelerator: string, customized: boolean }} the public state. */
  status() {
    const base = this.service !== null
      ? this.service.status()
      : (() => {
        const parsed = this.current === '' ? undefined : parseAccelerator(this.current)
        return {
          enabled: parsed !== undefined && parsed.valid,
          active: false,
          accelerator: this.current,
          label: parsed !== undefined && parsed.valid ? parsed.label : '',
          reason: this.current === '' ? 'disabled' : (parsed !== undefined && parsed.valid ? 'idle' : 'invalid-accelerator'),
        }
      })()
    return {
      ...base,
      source: this.source,
      defaultAccelerator: this.defaultAccelerator,
      customized: this.override !== undefined,
    }
  }

  /**
   * Read the persisted override and arm the shortcut.
   *
   * @returns {Promise<object>} the settled status.
   */
  async start() {
    return this.enqueue(() => this.apply(this.current))
  }

  /**
   * Change the shortcut and persist it as the user's choice.
   *
   * @param {unknown} accelerator - accelerator text, e.g. `ctrl+shift+a`.
   * @returns {Promise<object>} the settled status (a registration conflict is reported in `reason`).
   * @throws {HotkeyValidationError} when the text is not a usable shortcut.
   */
  async setAccelerator(accelerator) {
    const parsed = validateAcceleratorInput(accelerator)
    return this.enqueue(async () => {
      this.current = parsed.accelerator
      this.source = 'user'
      this.override = parsed.accelerator
      if (this.statePath !== undefined) {
        try {
          writeHotkeyOverride(this.statePath, parsed.accelerator)
        } catch (failure) {
          this.warn('could not persist the shortcut preference', failure)
        }
      }
      return this.apply(parsed.accelerator)
    })
  }

  /**
   * Drop the user's choice and return to the configured default.
   *
   * @returns {Promise<object>} the settled status.
   */
  async reset() {
    return this.enqueue(async () => {
      this.override = undefined
      this.source = 'config'
      this.current = this.defaultAccelerator
      if (this.statePath !== undefined) {
        try {
          clearHotkeyOverride(this.statePath)
        } catch (failure) {
          this.warn('could not remove the stored shortcut preference', failure)
        }
      }
      return this.apply(this.defaultAccelerator)
    })
  }

  /**
   * Dispose the current service and arm a new accelerator.
   *
   * @param {string} accelerator - accelerator text; empty disables the feature.
   * @returns {Promise<object>} the settled status.
   */
  async apply(accelerator) {
    if (this.service !== null) {
      this.service.dispose()
      this.service = null
    }
    const text = typeof accelerator === 'string' ? accelerator.trim() : ''
    if (text === '') return this.status()
    const service = new this.Service({
      accelerator: text,
      onTrigger: this.onTrigger,
      warn: this.warn,
      ...(this.sourcePath === undefined ? {} : { sourcePath: this.sourcePath }),
      ...(this.cacheDirectory === undefined ? {} : { cacheDirectory: this.cacheDirectory }),
      ...(this.socketPath === undefined ? {} : { socketPath: this.socketPath }),
    })
    this.service = service
    try {
      await service.start()
    } catch (failure) {
      this.warn('global hotkey failed to start', failure)
    }
    return this.status()
  }

  /** @returns {void} */
  dispose() {
    if (this.service !== null) {
      this.service.dispose()
      this.service = null
    }
  }
}
