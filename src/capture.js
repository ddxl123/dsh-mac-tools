/**
 * Screen capture for this Mac, built on the system `screencapture` utility.
 *
 * The system tool is what a person already grants Screen Recording to, knows
 * how to cancel (Esc), and annotates the way QQ does (dimmed screen, drag a
 * region, space to switch to window picking). This module owns exactly that
 * layer: build arguments, run the utility with a deadline and a cancellation
 * path, then validate that a real PNG came out.
 *
 * Everything that is pure — argument construction, PNG header parsing, error
 * classification — is exported so it is unit-tested without a display.
 *
 * @module dsh-mac-tools/capture
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { SelectionTracker } from './selection.js'
import { mainDisplayBounds } from './windows.js'

/**
 * Resolve one system binary: the first existing absolute candidate, else the
 * bare name so PATH resolution still has a chance (and the failure is a spawn
 * error the caller reports).
 *
 * @param {string[]} candidates - absolute paths, most preferred first.
 * @returns {string} the binary to execute.
 */
function resolveBinary(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1]
}

/** The system capture utility (macOS ships it under `/usr/sbin`). */
const SCREENCAPTURE = resolveBinary(['/usr/sbin/screencapture', '/usr/bin/screencapture', 'screencapture'])
/** The system clipboard reader/writer for text. */
const PBPIPE = {
  copy: resolveBinary(['/usr/bin/pbcopy', 'pbcopy']),
  paste: resolveBinary(['/usr/bin/pbpaste', 'pbpaste']),
}
/** Finder reveal helper. */
const OPEN = resolveBinary(['/usr/bin/open', 'open'])
/** AppleScript interpreter for image clipboard writes. */
const OSASCRIPT = resolveBinary(['/usr/bin/osascript', 'osascript'])

/** PNG signature bytes. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Refusal raised by the capture layer, carrying the operation's failure code. */
export class CaptureError extends Error {
  /**
   * @param {string} message - what went wrong.
   * @param {string} code - stable failure code the panel and tools localize.
   * @param {object} [details] - extra structured context.
   */
  constructor(message, code = 'capture_failed', details = {}) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
    this.details = details
  }
}

/**
 * Run one process to completion with a deadline and an external cancellation
 * signal. Resolves captured output; rejects with {@link CaptureError} on
 * timeout, abort, or a non-zero exit.
 *
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {object} [options] - run options.
 * @param {number} [options.timeoutMs] - kill deadline, 0 disables it.
 * @param {AbortSignal} [options.signal] - external cancellation.
 * @param {string | null} [options.stdin] - text written to stdin before it closes.
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>} the outcome.
 */
export function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const signal = options.signal
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let aborted = false
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-256 * 1024)
    })
    const finish = (operation) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      operation()
    }
    const kill = (reason) => {
      try {
        child.kill(reason)
      } catch {
        // The process may already be gone; the close handler settles anyway.
      }
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        kill('SIGKILL')
      }, timeoutMs)
      : undefined
    const onAbort = () => {
      aborted = true
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 750).unref?.()
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        aborted = true
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    child.on('error', (error) => {
      finish(() => reject(new CaptureError(`could not run ${command}: ${error.message}`, 'exec_failed', { command })))
    })
    child.on('close', (code) => {
      finish(() => {
        if (aborted) {
          reject(new CaptureError('the capture was cancelled', 'cancelled'))
          return
        }
        if (timedOut) {
          reject(new CaptureError('the capture timed out', 'timeout', { timeoutMs }))
          return
        }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `exit code ${code}`
          reject(new CaptureError(detail, 'process_failed', { command, exitCode: code, stderr: detail }))
          return
        }
        resolve({ stdout, stderr, code: code ?? 0 })
      })
    })
    if (typeof options.stdin === 'string') {
      child.stdin?.end(options.stdin)
    } else {
      child.stdin?.end()
    }
  })
}

/**
 * The capture modes this plugin understands.
 * @typedef {'interactive' | 'interactive-region' | 'interactive-window' | 'full' | 'display' | 'window' | 'app' | 'frontmost' | 'rect'} CaptureMode
 */

/** Every accepted capture mode. */
export const CAPTURE_MODES = Object.freeze([
  'interactive',
  'interactive-region',
  'interactive-window',
  'full',
  'display',
  'window',
  'app',
  'frontmost',
  'rect',
])

/** Modes that hand control to the operator in the native overlay. */
export const INTERACTIVE_MODES = Object.freeze(['interactive', 'interactive-region', 'interactive-window'])

/** @param {string} mode - mode name. @returns {boolean} whether it is interactive. */
export function isInteractiveMode(mode) {
  return INTERACTIVE_MODES.includes(mode)
}

/**
 * Build the `screencapture` argument list for one request. The output file is
 * appended by {@link capture}; this function is pure and tested directly.
 *
 * @param {object} options - capture options.
 * @param {CaptureMode} options.mode - requested mode.
 * @param {number} [options.display] - 1-based display index.
 * @param {number} [options.windowId] - CoreGraphics window id (window mode).
 * @param {{ x: number, y: number, w: number, h: number }} [options.rect] - screen-point rectangle (rect mode).
 * @param {boolean} [options.includeCursor] - capture the cursor (non-interactive modes).
 * @param {number} [options.delaySeconds] - wait this long before capturing (non-interactive modes).
 * @param {string} options.filePath - destination PNG path.
 * @returns {string[]} arguments for `screencapture`.
 * @throws {CaptureError} on an unknown or under-specified mode.
 */
export function buildCaptureArgs(options) {
  const mode = options.mode
  if (!CAPTURE_MODES.includes(mode)) {
    throw new CaptureError(`unknown capture mode ${JSON.stringify(mode)}`, 'invalid_request', { mode })
  }
  const args = []
  switch (mode) {
    case 'interactive':
      args.push('-i', '-x')
      break
    case 'interactive-region':
      args.push('-i', '-s', '-x')
      break
    case 'interactive-window':
      args.push('-i', '-w', '-x')
      break
    case 'full':
      args.push('-x', '-m')
      break
    case 'display': {
      const display = Number(options.display)
      if (!Number.isInteger(display) || display < 1 || display > 16) {
        throw new CaptureError('display mode needs a 1-based display index', 'invalid_request', { field: 'display' })
      }
      args.push('-x', `-D${display}`)
      break
    }
    case 'window': {
      const windowId = Number(options.windowId)
      if (!Number.isInteger(windowId) || windowId <= 0) {
        throw new CaptureError('window mode needs a window id', 'invalid_request', { field: 'windowId' })
      }
      args.push('-x', '-o', `-l${windowId}`)
      break
    }
    case 'rect': {
      const rect = options.rect
      const values = rect === null || typeof rect !== 'object'
        ? []
        : [rect.x, rect.y, rect.w, rect.h].map((value) => Number(value))
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) {
        throw new CaptureError('rect mode needs { x, y, w, h } with a positive size', 'invalid_request', { field: 'rect' })
      }
      args.push('-x', '-R', values.map((value) => Math.round(value)).join(','))
      break
    }
    case 'app':
    case 'frontmost':
      // Resolved to a window id by `capture`; argument construction happens there.
      args.push('-x', '-o')
      break
    default:
      throw new CaptureError(`unsupported capture mode ${JSON.stringify(mode)}`, 'invalid_request', { mode })
  }
  if (!isInteractiveMode(mode) && options.includeCursor === true) args.push('-C')
  if (!isInteractiveMode(mode) && Number(options.delaySeconds) > 0) {
    args.push(`-T${Math.min(30, Math.round(Number(options.delaySeconds)))}`)
  }
  args.push('-t', 'png')
  if (typeof options.filePath === 'string' && options.filePath !== '') args.push(options.filePath)
  return args
}

/**
 * Read the pixel dimensions out of a PNG buffer's IHDR chunk.
 *
 * @param {Buffer | Uint8Array} buffer - file bytes.
 * @returns {{ width: number, height: number }} dimensions.
 * @throws {CaptureError} when the bytes are not a PNG.
 */
export function readPngSize(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new CaptureError('the capture did not produce a PNG image', 'capture_failed')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width <= 0 || height <= 0) throw new CaptureError('the captured PNG has no pixels', 'capture_failed')
  return { width, height }
}

/**
 * Classify a `screencapture` failure into an operation code the UI localizes.
 *
 * @param {{ message?: string, stderr?: string, code?: string }} failure - the thrown value.
 * @returns {CaptureError} the classified failure.
 */
export function classifyCaptureFailure(failure) {
  if (failure instanceof CaptureError) {
    if (failure.code === 'cancelled' || failure.code === 'timeout' || failure.code === 'invalid_request' || failure.code === 'busy') return failure
    if (failure.code === 'process_failed') {
      const text = `${failure.details?.stderr ?? ''} ${failure.message ?? ''}`.toLowerCase()
      if (/not authorized|permission|screen recording|could not create image/.test(text)) {
        return new CaptureError(
          'the Screen Recording permission is missing: allow DeepSeek Harness under System Settings → Privacy & Security → Screen Recording',
          'permission',
          { ...failure.details },
        )
      }
    }
    return failure
  }
  return new CaptureError(failure instanceof Error ? failure.message : String(failure), 'capture_failed')
}

/**
 * Capture one screenshot.
 *
 * @param {object} options - capture request.
 * @param {CaptureMode} options.mode - requested mode.
 * @param {string} options.filePath - destination PNG path (the caller owns the temp directory).
 * @param {number} [options.display] - 1-based display index.
 * @param {number} [options.windowId] - window id or app name target resolution.
 * @param {string} [options.app] - application name for app mode.
 * @param {{ x: number, y: number, w: number, h: number }} [options.rect] - rectangle for rect mode.
 * @param {boolean} [options.includeCursor] - capture the cursor.
 * @param {number} [options.delaySeconds] - delay before capture.
 * @param {number} [options.timeoutMs] - deadline; interactive captures use the configured idle window.
 * @param {AbortSignal} [options.signal] - cancellation from the caller.
 * @param {(target: { windowId?: number, app?: string }) => Promise<{ id: number, app: string, title: string } | undefined>} [options.resolveWindow] - window resolver for app/frontmost modes.
 * @returns {Promise<{ path: string, width: number, height: number, bytes: number, at: string, mode: CaptureMode, window?: object }>} the capture.
 */
export async function capture(options) {
  const mode = options.mode
  let window = options.window
  let windowId = options.windowId
  if (mode === 'app' || mode === 'frontmost') {
    if (typeof options.resolveWindow !== 'function') {
      throw new CaptureError('this capture mode needs window resolution', 'invalid_request')
    }
    window = await options.resolveWindow({ app: mode === 'app' ? options.app : undefined })
    if (window === undefined) {
      throw new CaptureError(
        mode === 'app' ? `no on-screen window found for ${JSON.stringify(options.app ?? '')}` : 'no on-screen window found',
        'no_window',
        { app: options.app },
      )
    }
    windowId = window.id
  }
  const interactive = isInteractiveMode(mode)
  /** The watcher that records the rectangle the operator drags in the native selector. */
  let tracker = null
  if (interactive && options.trackSelection !== false) {
    const Tracker = options.SelectionTrackerClass ?? SelectionTracker
    tracker = new Tracker(options.selectionTrackerOptions)
    try {
      await tracker.start()
    } catch {
      tracker = null
    }
  }
  const args = buildCaptureArgs({
    ...options,
    mode: mode === 'app' || mode === 'frontmost' ? 'window' : mode,
    windowId,
  })
  const runOptions = {
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: options.signal,
  }
  const run = typeof options.run === 'function' ? options.run : runProcess
  try {
    await run(SCREENCAPTURE, args, runOptions)
  } catch (failure) {
    if (tracker !== null) tracker.cancel()
    const classified = classifyCaptureFailure(failure)
    if (classified.code === 'cancelled' && interactive) {
      throw new CaptureError('the operator cancelled the capture', 'cancelled')
    }
    throw classified
  }
  /** Screen rectangle the capture came from, used to pin the result back in place. */
  let rect
  if (tracker !== null) {
    const result = await tracker.finish()
    rect = result.rect
  } else {
    rect = await knownCaptureRect(mode, options, window)
  }
  const file = await readFileValidated(options.filePath, mode)
  return {
    path: options.filePath,
    width: file.width,
    height: file.height,
    bytes: file.bytes,
    at: new Date().toISOString(),
    mode,
    ...(window === undefined ? {} : { window: { id: window.id, app: window.app, title: window.title } }),
    ...(rect === undefined ? {} : { rect }),
  }
}

/**
 * Normalize a window's screen bounds into a capture rectangle.
 *
 * @param {{ x?: unknown, y?: unknown, w?: unknown, h?: unknown } | undefined} window - window entry from the list.
 * @returns {{ x: number, y: number, w: number, h: number } | undefined} the rectangle, when usable.
 */
export function rectFromWindow(window) {
  if (window === null || window === undefined || typeof window !== 'object') return undefined
  const x = Number(window.x)
  const y = Number(window.y)
  const w = Number(window.w)
  const h = Number(window.h)
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w < 4 || h < 4) return undefined
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * Normalize an explicit rectangle request.
 *
 * @param {{ x?: unknown, y?: unknown, w?: unknown, h?: unknown } | undefined} rect - requested rectangle.
 * @returns {{ x: number, y: number, w: number, h: number } | undefined} the rectangle, when usable.
 */
export function rectFromRequest(rect) {
  return rectFromWindow(rect)
}

/**
 * The screen rectangle of a capture whose target is known without watching the
 * selector: window captures use the window bounds, rectangle captures use the
 * request, and full-screen captures use the main display.
 *
 * @param {string} mode - capture mode.
 * @param {object} options - capture options.
 * @param {{ x?: unknown, y?: unknown, w?: unknown, h?: unknown } | undefined} window - resolved window, if any.
 * @returns {Promise<{ x: number, y: number, w: number, h: number } | undefined>} the rectangle.
 */
async function knownCaptureRect(mode, options, window) {
  if (mode === 'window' || mode === 'app' || mode === 'frontmost') return rectFromWindow(window)
  if (mode === 'rect') return rectFromRequest(options.rect)
  if (mode === 'full') {
    const resolve = typeof options.displayBounds === 'function' ? options.displayBounds : mainDisplayBounds
    try {
      return await resolve()
    } catch {
      return undefined
    }
  }
  if (mode === 'display' && (Number(options.display) || 1) === 1) {
    const resolve = typeof options.displayBounds === 'function' ? options.displayBounds : mainDisplayBounds
    try {
      return await resolve()
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Read a capture file and validate that it is a real PNG; an absent file after
 * an interactive run is the normal "the operator pressed Esc" outcome.
 *
 * @param {string} filePath - expected output path.
 * @param {CaptureMode} mode - requested mode, for the cancellation distinction.
 * @returns {Promise<{ width: number, height: number, bytes: number }>} size information.
 */
async function readFileValidated(filePath, mode) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    if (isInteractiveMode(mode)) throw new CaptureError('the operator cancelled the capture', 'cancelled')
    throw new CaptureError('screencapture produced no file', 'capture_failed')
  }
  if (!info.isFile() || info.size === 0) {
    if (isInteractiveMode(mode)) throw new CaptureError('the operator cancelled the capture', 'cancelled')
    throw new CaptureError('screencapture produced an empty file', 'capture_failed')
  }
  const buffer = await readFile(filePath)
  const { width, height } = readPngSize(buffer)
  return { width, height, bytes: buffer.byteLength }
}

/**
 * Escape a path for an AppleScript double-quoted string literal.
 * @param {string} value - raw text.
 * @returns {string} escaped text.
 */
export function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

/**
 * Put a PNG file on the macOS clipboard as PNG data.
 *
 * @param {string} filePath - PNG path.
 * @param {object} [options] - run options.
 * @returns {Promise<void>} resolves when the pasteboard holds the image.
 */
export async function copyPngToClipboard(filePath, options = {}) {
  const script = `set the clipboard to (read (POSIX file "${escapeAppleScriptString(filePath)}") as «class PNGf»)`
  try {
    await runProcess(OSASCRIPT, ['-e', script], { timeoutMs: options.timeoutMs ?? 20_000 })
  } catch (failure) {
    throw new CaptureError(`could not put the image on the clipboard: ${failure instanceof Error ? failure.message : String(failure)}`, 'clipboard_failed', {
      stderr: failure instanceof CaptureError ? failure.details?.stderr : undefined,
    })
  }
}

/**
 * Write text to the macOS clipboard.
 * @param {string} text - clipboard text.
 * @param {object} [options] - run options.
 * @returns {Promise<void>} resolves when the pasteboard holds the text.
 */
export async function copyTextToClipboard(text, options = {}) {
  await runProcess(PBPIPE.copy, [], { timeoutMs: options.timeoutMs ?? 10_000, stdin: String(text ?? '') })
}

/**
 * Read the macOS clipboard as text.
 * @param {object} [options] - run options.
 * @returns {Promise<string>} clipboard text (empty when it holds no text).
 */
export async function readTextClipboard(options = {}) {
  const { stdout } = await runProcess(PBPIPE.paste, [], { timeoutMs: options.timeoutMs ?? 10_000 })
  return stdout
}

/**
 * Reveal one file in Finder.
 * @param {string} filePath - file to select.
 * @returns {Promise<void>} resolves when Finder accepted the request.
 */
export async function revealInFinder(filePath) {
  await runProcess(OPEN, ['-R', filePath], { timeoutMs: 10_000 })
}

/** Folder holding the built-in macOS alert sounds. */
const SOUNDS_DIRECTORY = '/System/Library/Sounds'
/** Player for the built-in alert sounds. */
const AFPLAY = resolveBinary(['/usr/bin/afplay', 'afplay'])

/**
 * Play one built-in macOS alert sound without blocking the caller.
 *
 * @param {string} [name] - sound name such as `Glass` or `Ping`.
 * @returns {void}
 */
export function playSystemSound(name = 'Glass') {
  try {
    const child = spawn(AFPLAY, [`${SOUNDS_DIRECTORY}/${name}.aiff`], { stdio: 'ignore', detached: true })
    child.unref()
  } catch {
    // A missing sound must never affect the capture.
  }
}

/**
 * Show one best-effort desktop notification.
 *
 * @param {{ title: string, body: string }} message - notification text.
 * @returns {Promise<void>} resolves when the notification command finished.
 */
export async function showNotification({ title, body }) {
  const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`
  await runProcess(OSASCRIPT, ['-e', script], { timeoutMs: 5000 })
}
