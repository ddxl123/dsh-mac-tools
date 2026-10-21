/**
 * Enumerating the on-screen application windows of this Mac.
 *
 * The list comes from CoreGraphics through the JavaScript for Automation
 * bridge (`osascript -l JavaScript`), which needs no compiled helper and no
 * third-party dependency. Window titles require the Screen Recording
 * permission the capture itself already needs; without it the list still
 * answers with application names and bounds.
 *
 * @module dsh-mac-tools/windows
 */

import { execFile } from 'node:child_process'

/** Executable that runs the JXA window query. */
const OSASCRIPT = '/usr/bin/osascript'

/** Command timeout for a window query; the query itself takes ~100-300 ms. */
const LIST_TIMEOUT_MS = 12_000

/**
 * The JXA program. It prints exactly one JSON object: `{ windows: [...] }`.
 * Everything stays inside `main()` so a failure produces a thrown error the
 * caller can report instead of a partial document.
 */
const WINDOW_LIST_SCRIPT = `
ObjC.import('CoreGraphics')
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['uint32', 'uint32']])
function main() {
  var options = 1 | 16
  var raw = $.CGWindowListCopyWindowInfo(options, 0)
  var list = ObjC.deepUnwrap(raw) || []
  var skip = {
    WindowManager: 1, Dock: 1, 'Control Center': 1, 'Notification Center': 1,
    Spotlight: 1, 'Window Server': 1, SystemUIServer: 1, loginwindow: 1,
    TextInputMenuAgent: 1, 'Universal Control': 1, 'Screenshot': 1
  }
  var out = []
  for (var i = 0; i < list.length; i++) {
    var w = list[i] || {}
    if (Number(w.kCGWindowLayer) !== 0) continue
    var app = String(w.kCGWindowOwnerName || '')
    if (app === '' || skip[app] === 1) continue
    var bounds = w.kCGWindowBounds || {}
    var width = Math.round(Number(bounds.Width) || 0)
    var height = Math.round(Number(bounds.Height) || 0)
    // macOS lists minimized windows as small stand-ins; only real windows are
    // useful for a window capture.
    if (width < 200 || height < 120) continue
    out.push({
      id: Number(w.kCGWindowNumber) || 0,
      app: app,
      title: String(w.kCGWindowName || ''),
      x: Math.round(Number(bounds.X) || 0),
      y: Math.round(Number(bounds.Y) || 0),
      w: width,
      h: height,
      frontmost: out.length === 0
    })
    if (out.length >= 80) break
  }
  return JSON.stringify({ windows: out })
}
main()
`

/** JXA program returning the main display's bounds in screen points. */
const MAIN_DISPLAY_SCRIPT = `
ObjC.import('CoreGraphics')
function main() {
  var bounds = $.CGDisplayBounds($.CGMainDisplayID())
  return JSON.stringify({
    x: Number(bounds.origin.x),
    y: Number(bounds.origin.y),
    width: Number(bounds.size.width),
    height: Number(bounds.size.height)
  })
}
main()
`

/**
 * Parse the main-display bounds document.
 *
 * @param {string} stdout - osascript output.
 * @returns {{ x: number, y: number, w: number, h: number } | undefined} the bounds.
 */
export function parseDisplayBounds(stdout) {
  let document
  try {
    document = JSON.parse(String(stdout ?? '').trim())
  } catch {
    return undefined
  }
  if (document === null || typeof document !== 'object') return undefined
  const x = Math.round(Number(document.x))
  const y = Math.round(Number(document.y))
  const w = Math.round(Number(document.width))
  const h = Math.round(Number(document.height))
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w < 4 || h < 4) return undefined
  return { x, y, w, h }
}

/**
 * Bounds of the main display, used to place a pinned full-screen capture.
 *
 * @returns {Promise<{ x: number, y: number, w: number, h: number } | undefined>} the bounds, when they can be read.
 */
export async function mainDisplayBounds() {
  try {
    const { stdout } = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', MAIN_DISPLAY_SCRIPT], LIST_TIMEOUT_MS)
    return parseDisplayBounds(stdout)
  } catch {
    return undefined
  }
}

/** A refused window query, with the reason preserved for the caller. */
export class WindowListError extends Error {
  /**
   * @param {string} message - description.
   * @param {object} [details] - extra context such as stderr.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'WindowListError'
    this.code = 'windows_failed'
    this.details = details
  }
}

/**
 * Run one command and resolve its captured stdout/stderr. Kept local so this
 * module needs no service from the plugin context.
 *
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - kill deadline.
 * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
 */
function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        const detail = `${stderr || stdout || error.message}`.trim()
        reject(new WindowListError(detail === '' ? 'the window query failed' : detail, { stderr: detail }))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * Parse the JSON document printed by {@link WINDOW_LIST_SCRIPT}.
 *
 * Kept pure so it is unit-tested without a display.
 *
 * @param {string} stdout - osascript output.
 * @returns {{ windows: Array<{ id: number, app: string, title: string, x: number, y: number, w: number, h: number, frontmost: boolean }> }} parsed list.
 * @throws {WindowListError} when the output is not the expected JSON.
 */
export function parseWindowList(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') throw new WindowListError('the window query returned nothing')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new WindowListError('the window query returned malformed JSON', { output: text.slice(0, 400), cause: String(error) })
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.windows)) {
    throw new WindowListError('the window query returned an unexpected document', { output: text.slice(0, 400) })
  }
  const windows = []
  let frontmostSeen = false
  for (const entry of parsed.windows) {
    if (entry === null || typeof entry !== 'object') continue
    const id = Number(entry.id)
    const app = typeof entry.app === 'string' ? entry.app.trim() : ''
    if (!Number.isInteger(id) || id <= 0 || app === '') continue
    const width = Math.round(Number(entry.w))
    const height = Math.round(Number(entry.h))
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
    const frontmost = entry.frontmost === true && !frontmostSeen
    if (frontmost) frontmostSeen = true
    windows.push({
      id,
      app,
      title: typeof entry.title === 'string' ? entry.title : '',
      x: Math.round(Number(entry.x)) || 0,
      y: Math.round(Number(entry.y)) || 0,
      w: width,
      h: height,
      frontmost,
    })
  }
  return { windows }
}

/**
 * List the on-screen application windows, front to back.
 *
 * @returns {Promise<{ windows: ReturnType<typeof parseWindowList>['windows'], frontmost: object | null }>} the list.
 */
export async function listWindows() {
  const { stdout } = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', WINDOW_LIST_SCRIPT], LIST_TIMEOUT_MS)
  const { windows } = parseWindowList(stdout)
  return { windows, frontmost: windows[0] ?? null }
}

/**
 * Pick the window a capture request named.
 *
 * @param {Array<{ id: number, app: string, title: string, w: number, h: number }>} windows - enumerated windows.
 * @param {{ windowId?: number, app?: string }} target - requested target.
 * @returns {object | undefined} the selected window.
 */
export function selectWindow(windows, target) {
  if (Number.isInteger(target.windowId)) {
    return windows.find((window) => window.id === target.windowId)
  }
  const wanted = typeof target.app === 'string' ? target.app.trim().toLowerCase() : ''
  if (wanted === '') return undefined
  const matches = windows.filter((window) => window.app.toLowerCase() === wanted)
  if (matches.length === 0) {
    return windows.find((window) => window.app.toLowerCase().includes(wanted))
  }
  return matches.find((window) => window.title.trim() !== '') ?? matches[0]
}
