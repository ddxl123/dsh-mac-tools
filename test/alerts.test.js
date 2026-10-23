/**
 * Threshold-alert tests: normalization, cooldown firing, notification and the
 * persisted settings document. The clock and notifier are injected, and the
 * persistence test writes into a temporary directory, so the suite is
 * deterministic and offline.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ALERT_DEFAULTS, AlertMonitor, normalizeAlertSettings } from '../src/alerts.js'

/** A sample above the default CPU and memory thresholds, with no SMC temperature. */
const HOT_SAMPLE = {
  cpu: { usagePercent: 95, temperatureCelsius: null },
  memory: { usedPercent: 95 },
}

/**
 * @param {object} [options] - monitor options.
 * @returns {{ monitor: AlertMonitor, notifications: object[], warnings: string[], clock: { value: number } }} the monitor and its probes.
 */
function createMonitor(options = {}) {
  const notifications = []
  const warnings = []
  const clock = { value: 1_000_000 }
  const monitor = new AlertMonitor({
    settings: options.settings,
    statePath: options.statePath,
    now: () => clock.value,
    notify: (event) => {
      notifications.push(event)
      return true
    },
    warn: (message) => warnings.push(message),
  })
  return { monitor, notifications, warnings, clock }
}

test('normalizes alert settings by merging defaults and clamping ranges', () => {
  assert.deepEqual(normalizeAlertSettings(), { ...ALERT_DEFAULTS })
  assert.deepEqual(normalizeAlertSettings(null), { ...ALERT_DEFAULTS })
  assert.deepEqual(normalizeAlertSettings({}), { ...ALERT_DEFAULTS })
  const clamped = normalizeAlertSettings({
    enabled: false,
    cpuPercent: 500,
    temperatureCelsius: 10,
    memoryPercent: 0.1,
    cooldownSeconds: 99_999,
    notify: false,
    unknown: 'ignored',
  })
  assert.deepEqual(clamped, {
    enabled: false,
    cpuPercent: 100,
    temperatureCelsius: 40,
    memoryPercent: 1,
    cooldownSeconds: 3600,
    notify: false,
  })
  assert.deepEqual(normalizeAlertSettings({
    enabled: 'yes',
    cpuPercent: '85',
    temperatureCelsius: 95.55,
    memoryPercent: Number.NaN,
    cooldownSeconds: -5,
    notify: 1,
  }), {
    enabled: true,
    cpuPercent: 85,
    temperatureCelsius: 95.6,
    memoryPercent: ALERT_DEFAULTS.memoryPercent,
    cooldownSeconds: 0,
    notify: true,
  })
  // null / blank are missing values, not zero.
  assert.deepEqual(normalizeAlertSettings({
    cpuPercent: null,
    temperatureCelsius: '',
    memoryPercent: false,
    cooldownSeconds: null,
  }), { ...ALERT_DEFAULTS })
})

test('fires one event per metric and notifies', () => {
  const { monitor, notifications } = createMonitor()
  const fired = monitor.evaluate(HOT_SAMPLE)
  assert.equal(fired.length, 2)
  assert.deepEqual(fired.map((event) => event.metric), ['cpu', 'memory'])
  assert.deepEqual(fired[0], {
    id: 'a-1',
    at: new Date(1_000_000).toISOString(),
    metric: 'cpu',
    value: 95,
    threshold: 90,
  })
  assert.deepEqual(fired[1], {
    id: 'a-2',
    at: new Date(1_000_000).toISOString(),
    metric: 'memory',
    value: 95,
    threshold: 90,
  })
  assert.deepEqual(monitor.snapshot().events, [fired[1], fired[0]])
  assert.deepEqual(notifications, fired)
})

test('applies the per-metric cooldown window', () => {
  const { monitor, clock } = createMonitor({ settings: { cooldownSeconds: 60 } })
  assert.equal(monitor.evaluate(HOT_SAMPLE).length, 2)
  clock.value += 30_000
  assert.deepEqual(monitor.evaluate(HOT_SAMPLE), [])
  clock.value += 30_000 // 60 s since the first firing: the window is over
  assert.equal(monitor.evaluate(HOT_SAMPLE).length, 2)
  assert.deepEqual(monitor.snapshot().events.map((event) => event.id), ['a-4', 'a-3', 'a-2', 'a-1'])
})

test('fires immediately again when the cooldown is zero', () => {
  const { monitor, clock } = createMonitor({ settings: { cooldownSeconds: 0 } })
  assert.equal(monitor.evaluate({ cpu: { usagePercent: 91 } }).length, 1)
  clock.value += 1000
  assert.equal(monitor.evaluate({ cpu: { usagePercent: 91 } }).length, 1)
})

test('skips metrics below threshold or without a value', () => {
  const { monitor, notifications } = createMonitor()
  assert.deepEqual(monitor.evaluate({ cpu: { usagePercent: 89.9 }, memory: { usedPercent: 50 } }), [])
  assert.deepEqual(monitor.evaluate({ cpu: { temperatureCelsius: null } }), [])
  assert.deepEqual(monitor.evaluate({}), [])
  assert.deepEqual(monitor.evaluate(null), [])
  assert.deepEqual(notifications, [])
  // Reaching the threshold exactly fires.
  const atThreshold = monitor.evaluate({ cpu: { usagePercent: 90, temperatureCelsius: 95 } })
  assert.deepEqual(atThreshold.map((event) => event.metric), ['cpu', 'temperature'])
  assert.equal(atThreshold[0].threshold, 90)
  assert.equal(atThreshold[1].value, 95)
})

test('does nothing when alerts are disabled', () => {
  const { monitor, notifications } = createMonitor({ settings: { enabled: false } })
  assert.deepEqual(monitor.evaluate(HOT_SAMPLE), [])
  assert.deepEqual(monitor.snapshot().events, [])
  assert.deepEqual(notifications, [])
})

test('does not notify when the notify setting is off', () => {
  const { monitor, notifications } = createMonitor({ settings: { notify: false } })
  assert.equal(monitor.evaluate(HOT_SAMPLE).length, 2)
  assert.deepEqual(notifications, [])
})

test('survives a throwing notifier and reports it through warn', () => {
  const warnings = []
  const monitor = new AlertMonitor({
    now: () => 0,
    notify: () => {
      throw new Error('notification centre unavailable')
    },
    warn: (message) => warnings.push(message),
  })
  const fired = monitor.evaluate({ cpu: { usagePercent: 100 } })
  assert.equal(fired.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /alert notification failed/u)
})

test('survives an asynchronous notifier rejection', async () => {
  const warnings = []
  const monitor = new AlertMonitor({
    now: () => 0,
    notify: () => Promise.reject(new Error('notification denied')),
    warn: (message) => warnings.push(message),
  })
  assert.equal(monitor.evaluate({ cpu: { usagePercent: 100 } }).length, 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /alert notification failed/u)
})

test('keeps the newest 20 events', () => {
  const { monitor, clock } = createMonitor({ settings: { cpuPercent: 1, cooldownSeconds: 0 } })
  for (let index = 0; index < 25; index += 1) {
    clock.value += 1000
    assert.equal(monitor.evaluate({ cpu: { usagePercent: 50 } }).length, 1)
  }
  const { events } = monitor.snapshot()
  assert.equal(events.length, 20)
  assert.equal(events[0].id, 'a-25')
  assert.equal(events[19].id, 'a-6')
})

test('snapshot returns copies, not internal state', () => {
  const { monitor } = createMonitor()
  monitor.evaluate(HOT_SAMPLE)
  const snapshot = monitor.snapshot()
  assert.notEqual(snapshot.settings, monitor.settings)
  snapshot.settings.cpuPercent = 1
  assert.equal(monitor.settings.cpuPercent, ALERT_DEFAULTS.cpuPercent)
  snapshot.events[0].value = -1
  assert.equal(monitor.snapshot().events[0].value, 95)
})

test('save merges, normalizes, clamps and returns the full settings', () => {
  const { monitor } = createMonitor()
  assert.deepEqual(monitor.save({ cpuPercent: 500 }), {
    ...ALERT_DEFAULTS,
    cpuPercent: 100,
  })
  const updated = monitor.save({ enabled: false, temperatureCelsius: 100, unknown: 'dropped' })
  assert.deepEqual(updated, {
    ...ALERT_DEFAULTS,
    enabled: false,
    cpuPercent: 100,
    temperatureCelsius: 100,
  })
  assert.deepEqual(monitor.snapshot().settings, updated)
})

test('persists settings to statePath and reloads them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mac-alerts-'))
  const statePath = join(directory, 'nested', 'alerts.json')
  try {
    const warnings = []
    const monitor = new AlertMonitor({ statePath, warn: (message) => warnings.push(message) })
    const settings = monitor.save({ cpuPercent: 85, cooldownSeconds: 30, notify: false })
    assert.equal(settings.cpuPercent, 85)
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { version: 1, settings })
    assert.deepEqual(warnings, [])

    const reloaded = new AlertMonitor({ statePath })
    assert.deepEqual(reloaded.snapshot().settings, settings)
    // Persisted values win over settings passed at startup.
    const explicit = new AlertMonitor({ statePath, settings: { cpuPercent: 99 } })
    assert.equal(explicit.snapshot().settings.cpuPercent, 85)

    // A bare settings document (no { version, settings } wrapper) is accepted too.
    writeFileSync(statePath, JSON.stringify({ cpuPercent: 70, enabled: false }), 'utf8')
    const legacy = new AlertMonitor({ statePath })
    assert.equal(legacy.snapshot().settings.cpuPercent, 70)
    assert.equal(legacy.snapshot().settings.enabled, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('warns and falls back to defaults on a corrupt settings file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mac-alerts-'))
  const statePath = join(directory, 'alerts.json')
  try {
    writeFileSync(statePath, '{not json', 'utf8')
    const warnings = []
    const monitor = new AlertMonitor({ statePath, warn: (message) => warnings.push(message) })
    assert.deepEqual(monitor.snapshot().settings, { ...ALERT_DEFAULTS })
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an in-memory monitor never touches the filesystem', () => {
  const { monitor, notifications } = createMonitor()
  assert.deepEqual(monitor.save({}), { ...ALERT_DEFAULTS })
  assert.equal(monitor.evaluate(HOT_SAMPLE).length, 2)
  assert.equal(notifications.length, 2)
})
