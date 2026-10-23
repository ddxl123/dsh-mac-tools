/**
 * Threshold alerts for the monitor tab.
 *
 * The Host compares each sample against three user-tunable thresholds and
 * keeps a small, newest-first history of the events for the panel. Firing is
 * rate-limited per metric by a cooldown window, and each fired event may be
 * forwarded to a notifier callback (a macOS notification in production).
 *
 * Settings are normalized and clamped on every entry point and are persisted
 * to the plugin state directory as a small JSON document, so they survive a
 * restart. The event history itself is session-only (cleared on reload).
 *
 * @module dsh-mac-tools/alerts
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Default, fully-normalized alert settings. */
export const ALERT_DEFAULTS = Object.freeze({
  enabled: true,
  cpuPercent: 90,
  temperatureCelsius: 95,
  memoryPercent: 90,
  cooldownSeconds: 300,
  notify: true,
})

/** Events kept for the panel (newest first). */
export const MAX_ALERT_EVENTS = 20

/** Persistence format version for the settings file. */
const SETTINGS_VERSION = 1

/** Allowed range per numeric setting. */
const LIMITS = Object.freeze({
  cpuPercent: Object.freeze([1, 100]),
  temperatureCelsius: Object.freeze([40, 120]),
  memoryPercent: Object.freeze([1, 100]),
  cooldownSeconds: Object.freeze([0, 3600]),
})

/**
 * @param {number} value - raw number.
 * @returns {number} the number rounded to one decimal.
 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * @param {unknown} error - thrown value.
 * @returns {string} a printable message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} value - raw value.
 * @param {[number, number]} range - inclusive bounds.
 * @param {number} fallback - value used when the input is not numeric.
 * @returns {number} the clamped, one-decimal number.
 */
function clampNumber(value, range, fallback) {
  // null/boolean/blank are "no value", not zero: the panel may submit a field
  // it does not show for the current platform.
  if (value === null || value === undefined || typeof value === 'boolean') return fallback
  const number = typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value)
  if (!Number.isFinite(number)) return fallback
  return round1(Math.min(range[1], Math.max(range[0], number)))
}

/**
 * Normalize an arbitrary settings object: unknown keys are dropped, missing
 * keys take the defaults, numbers are clamped to their documented range and
 * booleans are only accepted as real booleans.
 *
 * @param {object | null | undefined} raw - persisted or user-supplied settings.
 * @returns {{ enabled: boolean, cpuPercent: number, temperatureCelsius: number, memoryPercent: number, cooldownSeconds: number, notify: boolean }} the normalized settings.
 */
export function normalizeAlertSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : ALERT_DEFAULTS.enabled,
    cpuPercent: clampNumber(source.cpuPercent, LIMITS.cpuPercent, ALERT_DEFAULTS.cpuPercent),
    temperatureCelsius: clampNumber(source.temperatureCelsius, LIMITS.temperatureCelsius, ALERT_DEFAULTS.temperatureCelsius),
    memoryPercent: clampNumber(source.memoryPercent, LIMITS.memoryPercent, ALERT_DEFAULTS.memoryPercent),
    cooldownSeconds: clampNumber(source.cooldownSeconds, LIMITS.cooldownSeconds, ALERT_DEFAULTS.cooldownSeconds),
    notify: typeof source.notify === 'boolean' ? source.notify : ALERT_DEFAULTS.notify,
  }
}

/**
 * Read the persisted settings document, tolerating a missing or corrupt file.
 *
 * @param {string} statePath - JSON file path.
 * @param {(message: string, error?: unknown) => void} warn - diagnostic sink.
 * @returns {object | null} the persisted settings, or null when unavailable.
 */
function readPersistedSettings(statePath, warn) {
  let text
  try {
    text = readFileSync(statePath, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
      warn(`could not read the alert settings ${statePath}: ${messageOf(error)}`, error)
    }
    return null
  }
  try {
    const document = JSON.parse(text)
    if (document === null || typeof document !== 'object') return null
    const settings = document.settings !== null && typeof document.settings === 'object' ? document.settings : document
    return settings !== null && typeof settings === 'object' ? settings : null
  } catch (error) {
    warn(`could not parse the alert settings ${statePath}: ${messageOf(error)}`, error)
    return null
  }
}

/**
 * Threshold alert monitor: settings, cooldown state and the recent events.
 */
export class AlertMonitor {
  /**
   * @param {object} [options] - monitor options.
   * @param {object} [options.settings] - explicit settings; persisted values (when `statePath` exists) win over them.
   * @param {(event: object) => unknown} [options.notify] - notifier callback, called for each fired event when `notify` is enabled.
   * @param {() => number} [options.now] - clock in epoch milliseconds, injectable for tests.
   * @param {string} [options.statePath] - JSON file the settings are persisted to and loaded from; omit for an in-memory monitor.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   */
  constructor({ settings = undefined, notify = () => false, now = () => Date.now(), statePath = undefined, warn = () => {} } = {}) {
    this.notify = typeof notify === 'function' ? notify : () => false
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.warn = typeof warn === 'function' ? warn : () => {}
    this.statePath = typeof statePath === 'string' && statePath !== '' ? statePath : undefined
    const persisted = this.statePath === undefined ? null : readPersistedSettings(this.statePath, this.warn)
    // Values written by the operator win over whatever the caller passed at
    // startup, because persisting is the point of `statePath`.
    this.settings = normalizeAlertSettings({ ...normalizeAlertSettings(settings), ...(persisted ?? {}) })
    /** @type {object[]} newest first. */
    this.events = []
    /** @type {Map<string, number>} last firing time per metric. */
    this.lastFiredAt = new Map()
    /** Monotonic event id counter; the history dies with the instance. */
    this.sequence = 0
  }

  /**
   * Compare one sample against the thresholds and fire at most one event per
   * metric per cooldown window.
   *
   * @param {object | null} sample - monitor snapshot sample (`cpu.usagePercent`, `cpu.temperatureCelsius`, `memory.usedPercent`).
   * @returns {object[]} the events fired by this evaluation (0..3), oldest first among themselves.
   */
  evaluate(sample) {
    if (this.settings.enabled !== true) return []
    const nowMs = Number(this.now())
    if (!Number.isFinite(nowMs)) return []
    const thresholds = [
      ['cpu', sample?.cpu?.usagePercent, 'cpuPercent'],
      ['temperature', sample?.cpu?.temperatureCelsius, 'temperatureCelsius'],
      ['memory', sample?.memory?.usedPercent, 'memoryPercent'],
    ]
    const fired = []
    for (const [metric, rawValue, thresholdKey] of thresholds) {
      const value = Number(rawValue)
      if (!Number.isFinite(value)) continue
      const threshold = this.settings[thresholdKey]
      if (value < threshold) continue
      const lastFired = this.lastFiredAt.get(metric)
      if (lastFired !== undefined && nowMs - lastFired < this.settings.cooldownSeconds * 1000) continue
      this.sequence += 1
      const event = {
        id: `a-${this.sequence}`,
        at: new Date(nowMs).toISOString(),
        metric,
        value: round1(value),
        threshold,
      }
      this.events.unshift(event)
      if (this.events.length > MAX_ALERT_EVENTS) this.events.length = MAX_ALERT_EVENTS
      this.lastFiredAt.set(metric, nowMs)
      fired.push({ ...event })
      if (this.settings.notify === true) this.deliver(event)
    }
    return fired
  }

  /**
   * @param {object} event - a fired event.
   * @returns {void}
   */
  deliver(event) {
    /** @param {unknown} error - thrown or rejected value. */
    const report = (error) => this.warn(`alert notification failed: ${messageOf(error)}`, error)
    try {
      const result = this.notify({ ...event })
      // The production notifier is asynchronous (`osascript`); a rejected
      // notification must not surface as an unhandled rejection.
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.then(undefined, report)
      }
    } catch (error) {
      report(error)
    }
  }

  /**
   * @returns {{ settings: object, events: object[] }} the alerts block of the monitor snapshot (events newest first, at most 20).
   */
  snapshot() {
    return {
      settings: { ...this.settings },
      events: this.events.map((event) => ({ ...event })),
    }
  }

  /**
   * Apply a partial settings patch, normalize it, persist it when a
   * `statePath` was given, and return the full settings.
   *
   * Persistence failures are reported through `warn` instead of thrown: a
   * read-only state directory must not break the monitor loop, and the
   * in-memory settings still take effect for this session.
   *
   * @param {object} [patch] - any subset of the settings.
   * @returns {object} the normalized settings after the patch.
   */
  save(patch) {
    const merged = patch !== null && typeof patch === 'object' ? { ...this.settings, ...patch } : this.settings
    this.settings = normalizeAlertSettings(merged)
    if (this.statePath !== undefined) this.persist()
    return { ...this.settings }
  }

  /**
   * Write the settings document atomically (temporary file + rename).
   *
   * @returns {void}
   */
  persist() {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.statePath}.tmp-${process.pid}`
      writeFileSync(temporary, `${JSON.stringify({ version: SETTINGS_VERSION, settings: this.settings }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.statePath)
    } catch (error) {
      this.warn(`could not save the alert settings to ${this.statePath}: ${messageOf(error)}`, error)
    }
  }
}
