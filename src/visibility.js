/**
 * Hiding the DeepSeek Harness window for the duration of a capture.
 *
 * A screenshot taken from the panel usually has one obvious problem: the
 * Harness window itself is on top of whatever the user wants to capture. QQ's
 * screenshot UI hides itself before showing the selection overlay; this module
 * does the equivalent for DSH, and restores the window afterwards.
 *
 * The app is hidden through `NSRunningApplication.hide`/`unhide` (AppKit, via
 * the JavaScript for Automation bridge). That is a public macOS API and needs
 * no Accessibility permission — unlike UI scripting. The app is identified by
 * the bundle identifier this Harness process runs under
 * (`__CFBundleIdentifier`), with the executable name derived from
 * `process.execPath` as a fallback.
 *
 * Safety rules:
 * - hide only when the app currently has an on-screen window and is not
 *   already hidden; a hidden app is left alone and never "restored";
 * - wait for the hide animation (window count reaches zero) before the caller
 *   captures, so a frame of the vanishing window is not in the image;
 * - restore in the caller's `finally`, and expose {@link AppVisibility.showDetached}
 *   so unloading the plugin mid-capture can still put the window back.
 *
 * @module dsh-mac-tools/visibility
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { runProcess } from './capture.js'

/** Resolve one system binary the same way capture.js does. */
function resolveBinary(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1]
}

/** AppleScript/JXA interpreter. */
const OSASCRIPT = resolveBinary(['/usr/bin/osascript', 'osascript'])

/** Largest window count that still counts as "the app is visible". */
const MIN_WINDOW_WIDTH = 200

/**
 * Resolve which macOS application this Harness process belongs to.
 *
 * @param {object} [options] - detection inputs (injectable for tests).
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.bundleId] - `process.env.__CFBundleIdentifier`.
 * @param {string} [options.execPath] - `process.execPath`.
 * @returns {{ bundleId?: string, name?: string } | undefined} the app identity, or undefined when this is not a packaged app.
 */
export function resolveHostApp(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return undefined
  const bundleId = typeof options.bundleId === 'string' && options.bundleId.trim() !== ''
    ? options.bundleId.trim()
    : undefined
  const execPath = typeof options.execPath === 'string' ? options.execPath : ''
  const match = /\.app\/Contents\/MacOS\/([^/]+)$/u.exec(execPath)
  const name = match === null ? undefined : match[1]
  if (bundleId === undefined && name === undefined) return undefined
  return {
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(name === undefined ? {} : { name }),
  }
}

/**
 * JXA snippet binding the running application to `app` (or null).
 * @param {{ bundleId?: string, name?: string }} target - app identity.
 * @returns {string} JavaScript for the JXA program.
 */
function lookupSnippet(target) {
  if (typeof target.bundleId === 'string') {
    return `var matched = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(target.bundleId)})
var app = matched.count > 0 ? matched.objectAtIndex(0) : null`
  }
  return `var running = $.NSWorkspace.sharedWorkspace.runningApplications
var app = null
for (var index = 0; index < running.count; index++) {
  var candidate = running.objectAtIndex(index)
  if (String(candidate.localizedName) === ${JSON.stringify(target.name)}) { app = candidate; break }
}`
}

/**
 * Build the JXA program that reports whether the app is running, hidden, and
 * how many real windows it shows.
 *
 * @param {{ bundleId?: string, name?: string }} target - app identity.
 * @returns {string} the JXA source.
 */
export function buildStatusScript(target) {
  return `
ObjC.import('AppKit')
ObjC.import('CoreGraphics')
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['uint32', 'uint32']])
function main() {
  ${lookupSnippet(target)}
  if (app === null) return JSON.stringify({ found: false })
  var pid = Number(app.processIdentifier)
  var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1 | 16, 0)) || []
  var windows = 0
  for (var i = 0; i < list.length; i++) {
    var window = list[i] || {}
    if (Number(window.kCGWindowLayer) !== 0) continue
    if (Number(window.kCGWindowOwnerPID) !== pid) continue
    var bounds = window.kCGWindowBounds || {}
    if (Math.round(Number(bounds.Width) || 0) >= ${MIN_WINDOW_WIDTH}) windows += 1
  }
  return JSON.stringify({
    found: true,
    pid: pid,
    hidden: Boolean(app.isHidden),
    active: Boolean(app.isActive),
    windows: windows
  })
}
main()
`
}

/**
 * Build the JXA program that hides or unhides the app.
 *
 * @param {{ bundleId?: string, name?: string }} target - app identity.
 * @param {'hide' | 'show'} action - what to do.
 * @returns {string} the JXA source.
 */
export function buildVisibilityScript(target, action) {
  const call = action === 'hide' ? 'app.hide' : 'app.unhide'
  return `
ObjC.import('AppKit')
function main() {
  ${lookupSnippet(target)}
  if (app === null) return JSON.stringify({ found: false, action: ${JSON.stringify(action)} })
  ${call}
  return JSON.stringify({ found: true, action: ${JSON.stringify(action)} })
}
main()
`
}

/**
 * Build the JXA program that brings the app forward (used when a pinned image
 * asks to be edited in the panel).
 *
 * @param {{ bundleId?: string, name?: string }} target - app identity.
 * @returns {string} the JXA source.
 */
export function buildActivateScript(target) {
  return `
ObjC.import('AppKit')
function main() {
  ${lookupSnippet(target)}
  if (app === null) return JSON.stringify({ found: false })
  app.activateWithOptions(1)
  return JSON.stringify({ found: true })
}
main()
`
}

/** Default sleep used between a hide/show and the next step. */
function defaultWait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Own one app's visibility across captures.
 */
export class AppVisibility {
  /**
   * @param {object} [options] - configuration.
   * @param {{ bundleId?: string, name?: string }} [options.target] - app identity; undefined means unsupported.
   * @param {typeof runProcess} [options.run] - process runner (injectable for tests).
   * @param {(ms: number) => Promise<void>} [options.wait] - wait function (injectable for tests).
   * @param {number} [options.hideDelayMs] - maximum time to wait for the hide animation.
   * @param {number} [options.showDelayMs] - pause after unhiding before returning.
   */
  constructor({ target, run = runProcess, wait = defaultWait, hideDelayMs = 1400, showDelayMs = 250 } = {}) {
    this.target = target
    this.run = run
    this.wait = wait
    this.hideDelayMs = hideDelayMs
    this.showDelayMs = showDelayMs
  }

  /** @returns {boolean} whether an app was identified at all. */
  get supported() {
    return this.target !== undefined
  }

  /** @returns {string | undefined} the app name used to compare against the frontmost window. */
  get appName() {
    return this.target === undefined ? undefined : this.target.name
  }

  /**
   * Run one JXA program and parse its JSON answer.
   *
   * @param {string} script - JXA source.
   * @returns {Promise<object>} the parsed document.
   */
  async runScript(script) {
    const { stdout } = await this.run(OSASCRIPT, ['-l', 'JavaScript', '-e', script], { timeoutMs: 10_000 })
    const text = String(stdout ?? '').trim()
    if (text === '') throw new Error('the visibility script returned nothing')
    return JSON.parse(text)
  }

  /** @returns {Promise<{ supported: boolean, found: boolean, hidden?: boolean, active?: boolean, windows?: number, pid?: number }>} the current state. */
  async status() {
    if (!this.supported) return { supported: false, found: false }
    const answer = await this.runScript(buildStatusScript(this.target))
    return {
      supported: true,
      found: answer.found === true,
      ...(answer.found === true
        ? { hidden: answer.hidden === true, active: answer.active === true, windows: Number(answer.windows) || 0, pid: Number(answer.pid) || 0 }
        : {}),
    }
  }

  /**
   * Hide the app if it currently shows a window and is not already hidden.
   *
   * Waits until the last real window is gone (the hide animation finished), so
   * the capture that follows cannot catch a stale frame.
   *
   * @returns {Promise<{ hidden: boolean, reason: string }>} whether the caller must restore it.
   */
  async hide() {
    if (!this.supported) return { hidden: false, reason: 'unsupported' }
    const before = await this.status()
    if (before.found !== true) return { hidden: false, reason: 'not-running' }
    if (before.hidden === true) return { hidden: false, reason: 'already-hidden' }
    if ((before.windows ?? 0) === 0) return { hidden: false, reason: 'no-window' }
    await this.runScript(buildVisibilityScript(this.target, 'hide'))
    const deadline = Date.now() + this.hideDelayMs
    while (Date.now() < deadline) {
      await this.wait(150)
      const state = await this.status().catch(() => undefined)
      if (state !== undefined && state.found === true && (state.windows ?? 0) === 0) return { hidden: true, reason: 'hidden' }
    }
    return { hidden: true, reason: 'hidden-unconfirmed' }
  }

  /**
   * Unhide the app after a capture. Always safe to call; failures are the
   * caller's to log.
   *
   * @returns {Promise<void>} resolves once the app was asked to unhide.
   */
  async show() {
    if (!this.supported) return
    await this.runScript(buildVisibilityScript(this.target, 'show'))
    await this.wait(this.showDelayMs)
  }

  /**
   * Bring the app forward without waiting for a result. Failures are ignored:
   * activating is a courtesy for the panel, not part of the capture outcome.
   *
   * @returns {Promise<void>} resolves once the request was attempted.
   */
  async activate() {
    if (!this.supported) return
    try {
      await this.runScript(buildActivateScript(this.target))
    } catch {
      // A denied activation must not break the edit flow.
    }
  }

  /**
   * Fire-and-forget restore used from a synchronous disposal path: the plugin
   * must not leave the user's window hidden just because it was unloaded
   * mid-capture.
   *
   * @returns {void}
   */
  showDetached() {
    if (!this.supported) return
    try {
      const child = spawn(OSASCRIPT, ['-l', 'JavaScript', '-e', buildVisibilityScript(this.target, 'show')], {
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
    } catch {
      // Nothing else can be done from a synchronous teardown.
    }
  }
}
