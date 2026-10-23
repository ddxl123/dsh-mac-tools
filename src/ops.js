/**
 * The operation dispatcher behind the Web panel.
 *
 * One implementation per operation: the panel reaches these through the
 * authenticated `/api/dsh-mac-tools` route, and the global-hotkey path calls
 * the same functions in-process. Nothing in here knows which caller asked.
 *
 * @module dsh-mac-tools/ops
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import {
  CAPTURE_MODES,
  CaptureError,
  classifyCaptureFailure,
  copyPngToClipboard,
  copyTextToClipboard,
  isInteractiveMode,
  playSystemSound,
  readPngSize,
  readTextClipboard,
  revealInFinder,
  runProcess,
  showNotification,
} from './capture.js'
import { CalcError, evaluate } from './calc.js'
import { HotkeyValidationError } from './hotkey.js'
import { TransferError } from './transfer.js'
import { listWindows, selectWindow } from './windows.js'
import { API_PATH } from './route.js'
import { MAX_SHOT_BYTES } from './store.js'
import { systemInfo } from './system.js'

/** Default save directory when the row's config leaves it empty. */
export const DEFAULT_SAVE_DIRECTORY = join('Pictures', 'DSH Mac Tools')

/** Largest PNG base64 payload accepted from the panel, before decode. */
const MAX_BASE64_CHARS = Math.ceil((MAX_SHOT_BYTES * 4) / 3) + 64 * 1024

/** A refused operation, carrying the stable code the panel localizes. */
export class OpsError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - operator-facing description.
   * @param {object} [details] - extra structured context.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'OpsError'
    this.code = code
    this.details = details
  }
}

/**
 * Expand a leading `~` and make a directory path absolute.
 * @param {string} input - configured path.
 * @returns {string} absolute path.
 */
export function expandHome(input) {
  const text = String(input ?? '').trim()
  if (text === '') return join(homedir(), DEFAULT_SAVE_DIRECTORY)
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return resolve(text)
}

/**
 * @param {string} parent - directory.
 * @param {string} child - candidate path.
 * @returns {boolean} whether `child` is the directory or inside it.
 */
export function isInsideDirectory(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(`${base}${sep}`)
}

/**
 * Local timestamp suitable for a file name.
 * @param {Date} [date] - clock.
 * @returns {string} `YYYYMMDD-HHMMSS`.
 */
export function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Reduce a caller-supplied file name to a safe single PNG file name.
 *
 * @param {unknown} input - requested name.
 * @param {Date} [date] - clock used for the default name.
 * @returns {string} a safe `*.png` file name.
 */
export function sanitizeFileName(input, date = new Date()) {
  const fallback = `mac-tools-${timestampName(date)}.png`
  if (typeof input !== 'string' || input.trim() === '') return fallback
  const base = input.trim().replace(/[/\\:]/g, '-').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').slice(0, 120)
  if (base === '' || base === '.' || base === '..') return fallback
  return base.toLowerCase().endsWith('.png') ? base : `${base}.png`
}

/**
 * Decode a base64 PNG payload from the panel or a tool.
 *
 * @param {unknown} input - base64 text, optionally a `data:` URL.
 * @returns {Buffer} PNG bytes.
 * @throws {OpsError} when the payload is not a usable PNG.
 */
export function decodePngBase64(input) {
  let text = typeof input === 'string' ? input.trim() : ''
  if (text === '') throw new OpsError('invalid_request', 'the image payload is empty')
  if (text.startsWith('data:')) {
    const comma = text.indexOf(',')
    if (comma === -1) throw new OpsError('invalid_request', 'the image data URL is malformed')
    text = text.slice(comma + 1)
  }
  text = text.replace(/\s+/g, '')
  if (text.length > MAX_BASE64_CHARS) throw new OpsError('too_large', `the image is larger than ${MAX_SHOT_BYTES} bytes`, { limit: MAX_SHOT_BYTES })
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) throw new OpsError('invalid_request', 'the image payload is not base64')
  const buffer = Buffer.from(text, 'base64')
  if (buffer.byteLength === 0) throw new OpsError('invalid_request', 'the image payload decodes to nothing')
  if (buffer.byteLength > MAX_SHOT_BYTES) throw new OpsError('too_large', `the image is larger than ${MAX_SHOT_BYTES} bytes`, { limit: MAX_SHOT_BYTES })
  try {
    readPngSize(buffer)
  } catch (error) {
    throw new OpsError('invalid_request', error instanceof Error ? error.message : 'the image payload is not a PNG')
  }
  return buffer
}

/**
 * Build the operation dispatcher.
 *
 * @param {object} deps - collaborators.
 * @param {{ saveDirectory: string, maxShots: number, interactiveTimeoutMs: number, hideAppDuringCapture: boolean }} deps.config - resolved row config.
 * @param {import('./store.js').ShotStore} deps.store - temporary capture registry.
 * @param {typeof import('./capture.js')} deps.capture - capture module (injectable for tests).
 * @param {(message: string) => void} deps.warn - warning sink.
 * @param {string} [deps.version] - plugin version reported by `status`.
 * @param {{ copyPngToClipboard: Function, copyTextToClipboard: Function, readTextClipboard: Function }} [deps.clipboard] - clipboard adapter (injectable for tests).
 * @param {(path: string) => Promise<void>} [deps.finder] - Finder reveal adapter (injectable for tests).
 * @param {{ supported: boolean, appName?: string, hide: Function, show: Function, showDetached?: Function }} [deps.visibility] - Harness-window visibility adapter (injectable for tests).
 * @param {{ listWindows: Function, selectWindow: Function }} [deps.windows] - window enumeration adapter (injectable for tests).
 * @param {(name?: string) => void} [deps.sound] - alert-sound player (injectable for tests).
 * @param {(message: { title: string, body: string }) => Promise<void>} [deps.notify] - desktop-notification adapter (injectable for tests).
 * @param {{ status: () => object, setAccelerator: (accelerator: string) => Promise<object>, reset: () => Promise<object> }} [deps.hotkey] - global-hotkey controller (injectable for tests).
 * @param {{ pin: (buffer: Buffer, options?: object) => Promise<object>, count: number, dispose: () => void }} [deps.pins] - pinned-image manager (injectable for tests).
 * @param {{ add: Function, list: Function, get: Function, read: Function, remove: Function, clear: Function, maxItems: number }} [deps.history] - durable screenshot history (injectable for tests).
 * @param {import('./transfer.js').TransferServer} [deps.transfer] - phone-transfer service (injectable for tests).
 * @param {() => Promise<string[]>} [deps.chooseFiles] - native multi-select file picker (injectable for tests).
 * @returns {{ dispatch: (endpoint: string, payload?: object, signal?: AbortSignal) => Promise<any>, captureFromHotkey: () => Promise<object>, addPinnedEditor: (record: object) => object | null, cancelCapture: () => { cancelled: boolean }, status: () => object, dispose: () => void }} the dispatcher.
 */
export function createOps({ config, store, capture, warn, version = '0.1.0', clipboard, finder, visibility, windows, sound = playSystemSound, notify = showNotification, hotkey, pins, history, transfer, chooseFiles }) {
  const clipboardApi = clipboard ?? { copyPngToClipboard, copyTextToClipboard, readTextClipboard }
  const revealFile = finder ?? revealInFinder
  const windowsApi = windows ?? { listWindows, selectWindow }
  /** The in-flight interactive capture, when one is waiting for the operator. */
  let interactive = null
  /** Whether the plugin currently hides the Harness window for a capture. */
  let appHidden = false
  /** A pinned window asked to be edited; the panel picks it up on its next poll. */
  let pendingEditor = null
  /**
   * The operator's "hide the Harness window while capturing" preference, shared
   * by panel captures and the global shortcut. It starts from the row config and
   * is updated from the panel toggle. In-memory by design: a restart returns to
   * the configured default.
   */
  let hidePreference = config.hideAppDuringCapture === true

  function asObject(payload) {
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  }

  function requireString(payload, field) {
    const value = asObject(payload)[field]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new OpsError('invalid_request', `${field} must be a non-empty string`, { field })
    }
    return value.trim()
  }

  async function resolveWindowFor(target) {
    const { windows: onScreen } = await windowsApi.listWindows()
    if (target !== null && typeof target.app === 'string' && target.app.trim() !== '') {
      return windowsApi.selectWindow(onScreen, { app: target.app })
    }
    return onScreen[0]
  }

  async function opWindows() {
    const { windows: onScreen, frontmost } = await windowsApi.listWindows()
    return { windows: onScreen, frontmost }
  }

  /** Modes whose image is taken from the screen, where a covering window matters. */
  const HIDE_APP_MODES = new Set(['full', 'display', 'rect', 'interactive', 'interactive-region', 'interactive-window'])

  /** Whether the app this process belongs to currently owns the frontmost window. */
  async function hostAppIsFrontmost() {
    if (visibility === undefined || visibility.supported !== true) return false
    const name = typeof visibility.appName === 'string' ? visibility.appName.trim().toLowerCase() : ''
    if (name === '') return false
    try {
      const { windows: onScreen } = await windowsApi.listWindows()
      const first = Array.isArray(onScreen) ? onScreen[0] : undefined
      return first !== undefined && typeof first.app === 'string' && first.app.trim().toLowerCase() === name
    } catch {
      return false
    }
  }

  /**
   * Hide the Harness window when this capture would otherwise photograph it.
   *
   * Hiding is skipped when the request turned it off, the mode targets one
   * window instead of the screen, no packaged app was detected, or the Harness
   * window is not the frontmost one (then it covers nothing anyway).
   *
   * @param {string} mode - capture mode.
   * @param {object} request - capture payload.
   * @returns {Promise<boolean>} whether the window is now hidden and must be restored.
   */
  async function hideAppForCapture(mode, request) {
    const requested = typeof request.hideApp === 'boolean' ? request.hideApp : hidePreference
    if (!requested || !HIDE_APP_MODES.has(mode)) return false
    if (visibility === undefined || visibility.supported !== true) return false
    if (!(await hostAppIsFrontmost())) return false
    try {
      const outcome = await visibility.hide()
      if (outcome !== null && typeof outcome === 'object' && outcome.hidden === true) {
        appHidden = true
        return true
      }
      return false
    } catch (error) {
      warn('could not hide the Harness window for the capture', error)
      return false
    }
  }

  /** Put the Harness window back after a capture, whatever its outcome was. */
  async function restoreAppAfterCapture() {
    if (!appHidden) return
    appHidden = false
    try {
      await visibility.show()
    } catch (error) {
      warn('could not restore the Harness window after the capture', error)
    }
  }

  async function opCapture(payload, signal) {
    const request = asObject(payload)
    const mode = typeof request.mode === 'string' && request.mode !== '' ? request.mode : 'full'
    if (!CAPTURE_MODES.includes(mode)) {
      throw new OpsError('invalid_request', `unknown capture mode ${JSON.stringify(mode)}`, { field: 'mode', mode })
    }
    const filePath = store.createPath()
    const base = {
      mode,
      filePath,
      includeCursor: request.includeCursor === true,
      delaySeconds: Number(request.delaySeconds),
      display: request.display,
      rect: request.rect,
      app: request.app,
      windowId: Number.isInteger(request.windowId) ? request.windowId : undefined,
    }
    if (mode === 'window' && Number.isInteger(base.windowId)) {
      // Best effort: grab the window's screen bounds so the pin can be placed
      // exactly where that window is.
      try {
        const { windows: onScreen } = await windowsApi.listWindows()
        const hint = onScreen.find((window) => window.id === base.windowId)
        if (hint !== undefined) base.window = hint
      } catch {
        // Rectangle metadata is optional.
      }
    }
    let hidden = false
    try {
      hidden = await hideAppForCapture(mode, request)
      let shot
      if (isInteractiveMode(mode)) {
        if (interactive !== null) throw new OpsError('busy', 'another interactive capture is already waiting for the operator')
        const controller = new AbortController()
        interactive = controller
        const forwardAbort = () => controller.abort()
        if (signal !== undefined) {
          if (signal.aborted) controller.abort()
          else signal.addEventListener('abort', forwardAbort, { once: true })
        }
        try {
          shot = await capture.capture({
            ...base,
            timeoutMs: config.interactiveTimeoutMs,
            signal: controller.signal,
          })
        } catch (failure) {
          throw toOpsError(failure)
        } finally {
          if (signal !== undefined) signal.removeEventListener('abort', forwardAbort)
          interactive = null
        }
      } else {
        try {
          shot = await capture.capture({
            ...base,
            timeoutMs: 35_000,
            signal,
            resolveWindow: resolveWindowFor,
          })
        } catch (failure) {
          throw toOpsError(failure)
        }
      }
      const record = store.add(shot)
      rememberCapture(record)
      return {
        shot: publicShot(record),
        url: `${API_PATH}?shot=${encodeURIComponent(record.id)}`,
        appHidden: hidden,
      }
    } finally {
      await restoreAppAfterCapture()
    }
  }

  function opCancelCapture() {
    if (interactive === null) return { cancelled: false }
    interactive.abort()
    return { cancelled: true }
  }

  function resolveImageSource(payload) {
    const request = asObject(payload)
    if (typeof request.pngBase64 === 'string' && request.pngBase64 !== '') {
      const buffer = decodePngBase64(request.pngBase64)
      return { buffer, path: store.writeTemporary(buffer), bytes: buffer.byteLength, source: 'edited' }
    }
    const shotId = request.shotId
    if (typeof shotId === 'string' && shotId !== '') {
      const record = store.get(shotId)
      if (record === undefined) throw new OpsError('not_found', `unknown screenshot ${JSON.stringify(shotId)}`, { shotId })
      return { buffer: readFileSync(record.path), path: record.path, bytes: record.bytes, source: 'shot', record }
    }
    throw new OpsError('invalid_request', 'pass either shotId or pngBase64')
  }

  async function opCopy(payload) {
    const source = resolveImageSource(payload)
    try {
      await clipboardApi.copyPngToClipboard(source.path)
    } catch (failure) {
      throw toOpsError(failure)
    }
    return { bytes: source.bytes, at: new Date().toISOString(), source: source.source }
  }

  async function opSave(payload) {
    const request = asObject(payload)
    const source = resolveImageSource(request)
    const fileName = sanitizeFileName(request.fileName)
    const directory = config.saveDirectory
    try {
      mkdirSync(directory, { recursive: true })
      const path = join(directory, fileName)
      writeFileSync(path, source.buffer, { mode: 0o644 })
      return { path, fileName, directory, bytes: source.bytes, source: source.source }
    } catch (failure) {
      throw new OpsError('save_failed', `could not save the screenshot: ${failure instanceof Error ? failure.message : String(failure)}`, { directory })
    }
  }

  function opCalc(payload) {
    const request = asObject(payload)
    const expression = typeof request.expression === 'string' ? request.expression : ''
    try {
      return evaluate(expression, { angles: request.angles === 'rad' ? 'rad' : 'deg' })
    } catch (failure) {
      if (failure instanceof CalcError) throw new OpsError(failure.code, failure.message, failure.details)
      throw failure
    }
  }

  async function opClipboard(payload) {
    const request = asObject(payload)
    const action = request.action === 'write' ? 'write' : request.action === 'read' ? 'read' : undefined
    if (action === undefined) throw new OpsError('invalid_request', 'action must be "read" or "write"', { field: 'action' })
    if (action === 'write') {
      const text = typeof request.text === 'string' ? request.text : ''
      try {
        await clipboardApi.copyTextToClipboard(text)
      } catch (failure) {
        throw toOpsError(failure)
      }
      return { action, text, bytes: Buffer.byteLength(text, 'utf8') }
    }
    const text = await clipboardApi.readTextClipboard()
    return { action, text, bytes: Buffer.byteLength(text, 'utf8') }
  }

  async function opReveal(payload) {
    const path = requireString(payload, 'path')
    const absolute = resolve(path)
    const allowed = isInsideDirectory(config.saveDirectory, absolute) || isInsideDirectory(store.directory, absolute)
    if (!allowed) throw new OpsError('invalid_request', 'the path is outside the plugin save and temporary directories', { path: absolute })
    if (!existsSync(absolute)) throw new OpsError('not_found', `the file does not exist: ${absolute}`, { path: absolute })
    await revealFile(absolute)
    return { revealed: true, path: absolute }
  }

  /**
   * Capture one screenshot for the system-wide hotkey, entirely host-side: the
   * native region selector, then save and copy. No browser page is involved,
   * so this works while another application has focus.
   *
   * @returns {Promise<{ ok: boolean, shot?: object, savedPath?: string, copied?: boolean, reason?: string, message?: string }>} the outcome; `cancelled` is not an error.
   */
  async function captureFromHotkey() {
    if (interactive !== null) return { ok: false, reason: 'busy' }
    const filePath = store.createPath()
    const controller = new AbortController()
    interactive = controller
    try {
      await hideAppForCapture('interactive', { hideApp: hidePreference })
      const shot = await capture.capture({
        mode: 'interactive',
        filePath,
        includeCursor: false,
        delaySeconds: 0,
        timeoutMs: config.interactiveTimeoutMs,
        signal: controller.signal,
      })
      const record = store.add(shot)
      rememberCapture(record)
      let savedPath
      try {
        savedPath = (await opSave({ shotId: record.id })).path
      } catch (failure) {
        warn('global hotkey: could not save the screenshot', failure)
      }
      let copied = false
      try {
        await clipboardApi.copyPngToClipboard(record.path)
        copied = true
      } catch (failure) {
        warn('global hotkey: could not copy the screenshot', failure)
      }
      let pinned = false
      if (config.pinAfterGlobalCapture === true && pins !== undefined && pins !== null) {
        try {
          await pins.pin(readFileSync(record.path), record.rect === undefined ? {} : { rect: record.rect })
          pinned = true
        } catch (failure) {
          warn('global hotkey: could not pin the screenshot', failure)
        }
      }
      if (copied) {
        if (config.globalHotkeySound !== false) sound('Glass')
        try {
          void notify({
            title: 'Mac Tools',
            body: pinned ? 'Screenshot pinned to the screen (Esc closes it).' : 'Screenshot copied to the clipboard.',
          }).catch(() => {})
        } catch {
          // A notification that cannot be shown must not change the outcome.
        }
      }
      return { ok: true, shot: publicShot(record), savedPath, copied, pinned }
    } catch (failure) {
      const error = toOpsError(failure)
      if (error.code !== 'cancelled') warn('global hotkey capture failed', error)
      return { ok: false, reason: error.code, message: error.message }
    } finally {
      interactive = null
      await restoreAppAfterCapture()
    }
  }

  /**
   * Copy one capture into the durable history, best effort.
   *
   * @param {{ path: string, width: number, height: number, bytes: number, at: string, mode: string, window?: object, rect?: object }} record - stored capture.
   * @returns {void}
   */
  function rememberCapture(record) {
    if (history === undefined || history === null) return
    try {
      history.add({
        buffer: readFileSync(record.path),
        width: record.width,
        height: record.height,
        bytes: record.bytes,
        at: record.at,
        mode: record.mode,
        ...(record.window === undefined ? {} : { window: record.window }),
        ...(record.rect === undefined ? {} : { rect: record.rect }),
      })
    } catch (failure) {
      warn('could not add the capture to the screenshot history', failure)
    }
  }

  /**
   * Adopt one capture into the temporary registry so the editor and pin paths
   * can work with it like a fresh capture.
   *
   * @param {Buffer} buffer - PNG bytes.
   * @param {object} metadata - width, height, at, mode, window, rect.
   * @returns {object} the stored record.
   */
  function adoptCapture(buffer, metadata) {
    const path = store.createPath()
    writeFileSync(path, buffer, { mode: 0o600 })
    return store.add({
      path,
      width: Number(metadata.width) || 0,
      height: Number(metadata.height) || 0,
      bytes: buffer.byteLength,
      at: typeof metadata.at === 'string' ? metadata.at : new Date().toISOString(),
      mode: typeof metadata.mode === 'string' ? metadata.mode : 'history',
      ...(metadata.window === undefined ? {} : { window: metadata.window }),
      ...(metadata.rect === undefined ? {} : { rect: metadata.rect }),
    })
  }

  /**
   * Hand one pinned window's image to the panel editor on its next poll.
   *
   * @param {{ path: string, width?: number, height?: number, rect?: object }} pinRecord - pinned-window record.
   * @returns {object | null} the stored capture, or null on failure.
   */
  function addPinnedEditor(pinRecord) {
    try {
      const buffer = readFileSync(pinRecord.path)
      const record = adoptCapture(buffer, {
        width: pinRecord.width,
        height: pinRecord.height,
        at: new Date().toISOString(),
        mode: 'pin-edit',
        ...(pinRecord.rect === undefined ? {} : { rect: pinRecord.rect }),
      })
      pendingEditor = record
      return publicShot(record)
    } catch (failure) {
      warn('could not hand a pinned image to the editor', failure)
      return null
    }
  }

  /**
   * Resolve one history entry.
   *
   * @param {object} payload - request payload carrying `id`.
   * @returns {{ entry: object, buffer: Buffer }} the entry and its bytes.
   */
  function requireHistory(payload) {
    if (history === undefined || history === null) throw new OpsError('unsupported', 'screenshot history is unavailable')
    const id = requireString(payload, 'id')
    const entry = history.get(id)
    if (entry === undefined) throw new OpsError('not_found', `unknown history capture ${JSON.stringify(id)}`, { id })
    return { entry, buffer: history.read(id) }
  }

  /**
   * The phone-transfer service, when this Host mounted one.
   *
   * @returns {import('./transfer.js').TransferServer} the service.
   */
  function requireTransfer() {
    if (transfer === undefined || transfer === null) {
      throw new OpsError('unsupported', 'phone transfer is not available in this build')
    }
    return transfer
  }

  /**
   * Translate a transfer-layer failure into the dispatcher's error type.
   *
   * @param {unknown} failure - thrown value.
   * @returns {OpsError} the translated failure.
   */
  function toTransferOpsError(failure) {
    if (failure instanceof OpsError) return failure
    if (failure instanceof TransferError) {
      const details = failure.details !== null && typeof failure.details === 'object' ? failure.details : {}
      return new OpsError(failure.code, failure.message, details)
    }
    return new OpsError('io_error', failure instanceof Error ? failure.message : String(failure))
  }

  /**
   * Open the native multi-select file dialog and return the chosen paths.
   * Cancelling the dialog is a normal outcome, not a failure.
   *
   * @returns {Promise<string[]>} absolute paths; empty when the operator cancelled.
   */
  async function chooseFilesForPhone() {
    const lines = [
      'set chosen to choose file with multiple selections allowed',
      'set output to ""',
      'repeat with picked in chosen',
      'set output to output & POSIX path of picked & linefeed',
      'end repeat',
      'return output',
    ]
    /** @type {string[]} */
    const args = []
    for (const line of lines) args.push('-e', line)
    try {
      const { stdout } = await runProcess('/usr/bin/osascript', args, { timeoutMs: 300_000 })
      return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      const details = failure !== null && typeof failure === 'object' && failure.details !== null && typeof failure.details === 'object'
        ? failure.details
        : {}
      const stderr = typeof details.stderr === 'string' ? details.stderr : ''
      if (/User canceled|User cancelled|-128/u.test(`${message} ${stderr}`)) return []
      throw new OpsError('io_error', `could not open the file picker: ${message}`)
    }
  }

  /**
   * Manage the phone-transfer inbox (items the phone sent to this Mac).
   *
   * @param {object} payload - request payload with `action` and optional `id`.
   * @returns {Promise<object>} the operation value.
   */
  async function opTransferInbox(payload) {
    const service = requireTransfer()
    const request = asObject(payload)
    const action = typeof request.action === 'string' ? request.action : 'refresh'
    try {
      if (action === 'refresh') return await service.listInbox()
      if (action === 'clear') return await service.clearInbox()
      if (action === 'delete') return await service.deleteInbox(requireString(payload, 'id'))
      if (action === 'copyText') return await service.copyInboxText(requireString(payload, 'id'))
      if (action === 'reveal') return await service.revealInbox(requireString(payload, 'id'))
    } catch (failure) {
      throw toTransferOpsError(failure)
    }
    throw new OpsError('invalid_request', `unknown transferInbox action ${JSON.stringify(action)}`, { action })
  }

  /**
   * Manage the phone-transfer outbox (items this Mac sends to the phone).
   *
   * @param {object} payload - request payload with `action` and action-specific fields.
   * @returns {Promise<object>} the operation value.
   */
  async function opTransferOutbox(payload) {
    const service = requireTransfer()
    const request = asObject(payload)
    const action = typeof request.action === 'string' ? request.action : 'refresh'
    try {
      if (action === 'refresh') return await service.listOutbox()
      if (action === 'clear') return await service.clearOutbox()
      if (action === 'remove') return await service.removeOutbox(requireString(payload, 'id'))
      if (action === 'addHistory') return await service.addHistory(requireString(payload, 'id'))
      if (action === 'addText') {
        const text = request.text
        if (typeof text !== 'string' || text.trim() === '') {
          throw new OpsError('invalid_request', 'text must be a non-empty string', { field: 'text' })
        }
        return await service.addText(text)
      }
      if (action === 'addFile') {
        const paths = chooseFiles === undefined ? await chooseFilesForPhone() : await chooseFiles()
        /** @type {object[]} */
        const items = []
        for (const path of paths) items.push((await service.addFile(path)).item)
        return { cancelled: paths.length === 0, items }
      }
    } catch (failure) {
      throw toTransferOpsError(failure)
    }
    throw new OpsError('invalid_request', `unknown transferOutbox action ${JSON.stringify(action)}`, { action })
  }

  function opStatus() {
    return {
      version,
      platform: process.platform,
      saveDirectory: config.saveDirectory,
      shotCount: store.shots.length,
      interactiveBusy: interactive !== null,
      hideAppDuringCapture: hidePreference,
      canHideApp: visibility !== undefined && visibility.supported === true,
      hostAppName: visibility !== undefined && typeof visibility.appName === 'string' ? visibility.appName : null,
      globalHotkey: hotkey !== undefined && hotkey !== null ? hotkey.status() : null,
      pins: pins === undefined || pins === null ? 0 : pins.count,
      historyCount: history === undefined || history === null ? 0 : history.list().length,
      capabilities: {
        screenshot: true,
        calculator: true,
        clipboard: true,
        system: true,
        hideApp: visibility !== undefined && visibility.supported === true,
        pin: pins !== undefined && pins !== null,
        history: history !== undefined && history !== null,
        transfer: transfer !== undefined && transfer !== null,
      },
      hostPid: process.pid,
      at: new Date().toISOString(),
    }
  }

  /**
   * Dispatch one operation.
   *
   * @param {string} endpoint - operation name.
   * @param {object} [payload] - operation arguments.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<any>} the operation value.
   */
  async function dispatch(endpoint, payload, signal) {
    switch (endpoint) {
      case 'status':
        return opStatus()
      case 'hotkey':
        if (hotkey === undefined || hotkey === null) throw new OpsError('unsupported', 'the global screenshot shortcut is not available on this platform')
        return hotkey.status()
      case 'setHotkey': {
        if (hotkey === undefined || hotkey === null) throw new OpsError('unsupported', 'the global screenshot shortcut is not available on this platform')
        const accelerator = requireString(payload, 'accelerator')
        try {
          return await hotkey.setAccelerator(accelerator)
        } catch (failure) {
          if (failure instanceof HotkeyValidationError) {
            throw new OpsError('invalid_hotkey', failure.message, { reason: failure.reason })
          }
          throw failure
        }
      }
      case 'resetHotkey':
        if (hotkey === undefined || hotkey === null) throw new OpsError('unsupported', 'the global screenshot shortcut is not available on this platform')
        return hotkey.reset()
      case 'windows':
        return opWindows()
      case 'capture':
        return opCapture(payload, signal)
      case 'cancelCapture':
        return opCancelCapture()
      case 'history':
        if (history === undefined || history === null) throw new OpsError('unsupported', 'screenshot history is unavailable')
        return {
          items: history.list(),
          total: history.list().length,
          maxItems: history.maxItems,
        }
      case 'historyOpen': {
        const { entry, buffer } = requireHistory(payload)
        const record = adoptCapture(buffer, entry)
        return { shot: publicShot(record), url: `${API_PATH}?shot=${encodeURIComponent(record.id)}` }
      }
      case 'historyDelete': {
        if (history === undefined || history === null) throw new OpsError('unsupported', 'screenshot history is unavailable')
        const id = requireString(payload, 'id')
        return { deleted: history.remove(id), id }
      }
      case 'historyClear':
        if (history === undefined || history === null) throw new OpsError('unsupported', 'screenshot history is unavailable')
        history.clear()
        return { cleared: true }
      case 'historyCopy': {
        const { buffer } = requireHistory(payload)
        const source = store.writeTemporary(buffer)
        try {
          await clipboardApi.copyPngToClipboard(source)
        } catch (failure) {
          throw toOpsError(failure)
        }
        return { copied: true, bytes: buffer.byteLength }
      }
      case 'historyPin': {
        const { entry, buffer } = requireHistory(payload)
        if (pins === undefined || pins === null) throw new OpsError('unsupported', 'pinning to the screen is not available on this platform')
        return pins.pin(buffer, entry.rect === undefined ? {} : { rect: entry.rect })
      }
      case 'pendingEditor': {
        const record = pendingEditor
        pendingEditor = null
        return { shot: record === null ? null : publicShot(record) }
      }
      case 'pin': {
        if (pins === undefined || pins === null) throw new OpsError('unsupported', 'pinning to the screen is not available on this platform')
        const pinRequest = asObject(payload)
        const shotId = typeof pinRequest.shotId === 'string' && pinRequest.shotId !== '' ? pinRequest.shotId : undefined
        const shotRecord = shotId === undefined ? undefined : store.get(shotId)
        const source = resolveImageSource(payload)
        try {
          return await pins.pin(source.buffer, shotRecord === undefined || shotRecord.rect === undefined ? {} : { rect: shotRecord.rect })
        } catch (failure) {
          throw new OpsError(failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : 'pin_failed', failure instanceof Error ? failure.message : String(failure))
        }
      }
      case 'setHideApp': {
        const enabled = asObject(payload).enabled
        if (typeof enabled !== 'boolean') throw new OpsError('invalid_request', 'enabled must be a boolean', { field: 'enabled' })
        hidePreference = enabled
        return { enabled: hidePreference }
      }
      case 'copy':
        return opCopy(payload)
      case 'save':
        return opSave(payload)
      case 'calc':
        return opCalc(payload)
      case 'clipboard':
        return opClipboard(payload)
      case 'system':
        return systemInfo()
      case 'transferStatus':
        return requireTransfer().status()
      case 'transferStart':
        try {
          return await requireTransfer().start()
        } catch (failure) {
          throw toTransferOpsError(failure)
        }
      case 'transferStop': {
        const service = requireTransfer()
        service.stop()
        return service.status()
      }
      case 'transferInbox':
        return opTransferInbox(payload)
      case 'transferOutbox':
        return opTransferOutbox(payload)
      case 'reveal':
        return opReveal(payload)
      default:
        throw new OpsError('unknown_endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`, { endpoint })
    }
  }

  function dispose() {
    if (interactive !== null) {
      interactive.abort()
      interactive = null
    }
    if (appHidden && visibility !== undefined && typeof visibility.showDetached === 'function') {
      appHidden = false
      visibility.showDetached()
    }
    store.dispose()
  }

  return { dispatch, captureFromHotkey, addPinnedEditor, cancelCapture: opCancelCapture, status: opStatus, dispose }
}

/**
 * Present one stored record to callers, without the store's private fields.
 * @param {import('./store.js').ShotRecord} record - stored capture.
 * @returns {object} the public representation.
 */
export function publicShot(record) {
  return {
    id: record.id,
    path: record.path,
    width: record.width,
    height: record.height,
    bytes: record.bytes,
    mode: record.mode,
    at: record.at,
    ...(record.window === undefined ? {} : { window: record.window }),
    ...(record.rect === undefined ? {} : { rect: record.rect }),
  }
}

/**
 * Translate a capture-layer failure into the dispatcher's error type.
 * @param {unknown} failure - thrown value.
 * @returns {OpsError} the translated failure.
 */
function toOpsError(failure) {
  if (failure instanceof OpsError) return failure
  const classified = failure instanceof CaptureError ? classifyCaptureFailure(failure) : failure
  if (classified instanceof CaptureError) {
    if (classified.code === 'cancelled') return new OpsError('cancelled', 'the capture was cancelled', classified.details)
    if (classified.code === 'permission') return new OpsError('permission', classified.message, classified.details)
    if (classified.code === 'timeout') return new OpsError('timeout', classified.message, classified.details)
    if (classified.code === 'no_window') return new OpsError('no_window', classified.message, classified.details)
    if (classified.code === 'invalid_request') return new OpsError('invalid_request', classified.message, classified.details)
    if (classified.code === 'busy') return new OpsError('busy', classified.message, classified.details)
    return new OpsError('capture_failed', classified.message, classified.details)
  }
  const message = classified instanceof Error ? classified.message : String(classified)
  return new OpsError('capture_failed', message)
}

/** Re-exported so `index.js` and tests share one file-name helper. */
export { timestampName as defaultFileNameStamp }
