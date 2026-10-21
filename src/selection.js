/**
 * Record where an interactive capture was selected.
 *
 * macOS's native `screencapture -i` selector does not tell a caller which
 * rectangle the operator chose. The plugin needs that rectangle to "pin"
 * the result back exactly where it came from, so while the native selector is
 * up a tiny JXA process watches the physical mouse: it records the bounding box
 * of the next press-drag-release and writes it to a temporary JSON file.
 *
 * The watcher is a child process of the Host, reads only pointer position and
 * button state (no Accessibility permission), and is killed as soon as the
 * capture request settles. A click without a drag (window-picking mode) yields
 * no usable rectangle, and the caller then falls back to another placement.
 *
 * @module dsh-mac-tools/selection
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** AppleScript/JXA interpreter. */
const OSASCRIPT = existsSync('/usr/bin/osascript') ? '/usr/bin/osascript' : 'osascript'

/** Smallest usable selection, in points. */
const MIN_SELECTION = 4

/**
 * The watcher program: announce READY, then poll the pointer until one complete
 * press-drag-release happens (or five minutes pass) and write the bounding box.
 *
 * @param {string} outputPath - JSON file the watcher writes.
 * @returns {string} the JXA source.
 */
export function selectionTrackerScript(outputPath) {
  return `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')

var outputPath = ${JSON.stringify(outputPath)}

function writeReport(value) {
  var text = JSON.stringify(value)
  var data = $(text).dataUsingEncoding($.NSUTF8StringEncoding)
  data.writeToFileAtomically(outputPath, true)
}

function pointer() {
  var event = $.CGEventCreate(null)
  var location = $.CGEventGetLocation(event)
  return { x: Number(location.x), y: Number(location.y) }
}

function buttonDown() {
  return Boolean($.CGEventSourceButtonState(0, 0))
}

writeReport({ status: 'ready' })

var minX = 0, minY = 0, maxX = 0, maxY = 0
var sawDown = false
var completed = false
var deadline = Date.now() + 300000
while (Date.now() < deadline) {
  if (buttonDown()) {
    var point = pointer()
    if (!sawDown) {
      minX = point.x; minY = point.y; maxX = point.x; maxY = point.y
      sawDown = true
    } else {
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
  } else if (sawDown) {
    // Include the release point: a fast drag may not have been sampled while
    // the button was held.
    var release = pointer()
    if (release.x < minX) minX = release.x
    if (release.y < minY) minY = release.y
    if (release.x > maxX) maxX = release.x
    if (release.y > maxY) maxY = release.y
    writeReport({ status: 'done', rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } })
    completed = true
    break
  }
  $.NSThread.sleepForTimeInterval(0.016)
}
if (!completed) writeReport({ status: 'timeout', rect: null })
`
}

/**
 * Parse one watcher report.
 *
 * @param {string} text - file contents, possibly partial/corrupt.
 * @returns {{ status: 'ready' | 'done' | 'unknown', rect: { x: number, y: number, w: number, h: number } | undefined }} the report.
 */
export function parseSelectionReport(text) {
  let document
  try {
    document = JSON.parse(String(text ?? ''))
  } catch {
    return { status: 'unknown', rect: undefined }
  }
  if (document === null || typeof document !== 'object') return { status: 'unknown', rect: undefined }
  if (document.status === 'ready') return { status: 'ready', rect: undefined }
  if (document.status !== 'done') return { status: 'unknown', rect: undefined }
  const rect = document.rect
  if (rect === null || typeof rect !== 'object') return { status: 'done', rect: undefined }
  const x = Number(rect.x)
  const y = Number(rect.y)
  const w = Number(rect.w)
  const h = Number(rect.h)
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return { status: 'done', rect: undefined }
  if (w < MIN_SELECTION || h < MIN_SELECTION) return { status: 'done', rect: undefined }
  return { status: 'done', rect: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } }
}

/**
 * Kept apart from {@link parseSelectionReport} so tests can pin the threshold.
 *
 * @param {{ x: number, y: number, w: number, h: number } | undefined | null} rect - candidate.
 * @returns {boolean} whether the rectangle is worth using.
 */
export function isUsableSelection(rect) {
  if (rect === null || rect === undefined || typeof rect !== 'object') return false
  const values = [rect.x, rect.y, rect.w, rect.h].map(Number)
  if (!values.every((value) => Number.isFinite(value))) return false
  return values[2] >= MIN_SELECTION && values[3] >= MIN_SELECTION
}

/** Sleep helper. @param {number} ms - milliseconds. @returns {Promise<void>} resolves later. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Own the mouse watcher for one interactive capture.
 */
export class SelectionTracker {
  /**
   * @param {object} [options] - tracker options.
   * @param {typeof spawn} [options.spawnProcess] - child-process factory (injectable for tests).
   * @param {string} [options.directory] - directory for the report file.
   * @param {number} [options.readyTimeoutMs] - how long start() waits for READY.
   * @param {number} [options.finishTimeoutMs] - how long finish() waits for a completed drag.
   */
  constructor({
    spawnProcess = spawn,
    directory = undefined,
    readyTimeoutMs = 2500,
    finishTimeoutMs = 1200,
  } = {}) {
    this.spawnProcess = spawnProcess
    this.directory = directory ?? mkdtempSync(join(tmpdir(), 'dsh-mac-tools-selection-'))
    this.outputPath = join(this.directory, 'rect.json')
    this.readyTimeoutMs = readyTimeoutMs
    this.finishTimeoutMs = finishTimeoutMs
    this.child = null
    this.exited = false
  }

  /**
   * Spawn the watcher and wait until it is polling.
   *
   * @returns {Promise<void>} resolves when the watcher is ready.
   */
  async start() {
    rmSync(this.outputPath, { force: true })
    const child = this.spawnProcess(
      OSASCRIPT,
      ['-l', 'JavaScript', '-e', selectionTrackerScript(this.outputPath)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    this.child = child
    child.on('exit', () => {
      this.exited = true
    })
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      if (this.report().status === 'ready') return
      if (this.exited) return
      await sleep(25)
    }
  }

  /** @returns {{ status: 'ready' | 'done' | 'unknown', rect: object | undefined }} the current report. */
  report() {
    try {
      return parseSelectionReport(readFileSync(this.outputPath, 'utf8'))
    } catch {
      return { status: 'unknown', rect: undefined }
    }
  }

  /**
   * Wait for the completed selection and return its rectangle.
   *
   * @returns {Promise<{ rect?: { x: number, y: number, w: number, h: number } }>} the rectangle when one was dragged.
   */
  async finish() {
    if (this.child === null) return {}
    const deadline = Date.now() + this.finishTimeoutMs
    while (Date.now() < deadline) {
      const report = this.report()
      if (report.status === 'done') {
        this.cleanup()
        return report.rect === undefined ? {} : { rect: report.rect }
      }
      if (this.exited) break
      await sleep(25)
    }
    this.cancel()
    const report = this.report()
    this.cleanup()
    return report.status === 'done' && report.rect !== undefined ? { rect: report.rect } : {}
  }

  /** Kill the watcher without waiting for a selection. */
  cancel() {
    if (this.child !== null) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      this.child = null
    }
    this.cleanup()
  }

  /** Remove the temporary report directory. */
  cleanup() {
    try {
      rmSync(this.directory, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
}
