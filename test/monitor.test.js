/**
 * Monitor service tests.
 *
 * The service orchestrates four moving parts (software metrics, the SMC
 * sampler, the fan controller and the alert monitor), so the unit tests inject
 * fakes for all of them. One live integration test runs the real sampler on
 * this Mac (skip-guarded) and never touches the fan.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildNotificationScript,
  describeAlert,
  HISTORY_CAPACITY,
  MonitorService,
  MONITOR_ALERT_DEFAULTS,
} from '../src/monitor.js'
import { createOps } from '../src/ops.js'
import { ShotStore } from '../src/store.js'
import { resolveSwiftc } from '../src/swift.js'

const HOST = Object.freeze({
  hostname: 'mac-mini.local',
  modelName: 'Mac mini',
  modelIdentifier: 'Mac16,10',
  cpuModel: 'Apple M4',
  arch: 'arm64',
  osName: 'macOS',
  osVersion: '26.3.1',
  cpuCores: 10,
  performanceCores: 4,
  efficiencyCores: 6,
  uptimeSeconds: 1234,
})

/**
 * Build one contract-shaped software sample.
 *
 * @param {object} [overrides] - fields to override.
 * @returns {object} the sample.
 */
function softwareSample(overrides = {}) {
  const at = new Date(1_761_220_000_000).toISOString()
  return {
    at,
    host: { ...HOST },
    cpu: {
      usagePercent: 18.2,
      userPercent: 11.1,
      systemPercent: 5.2,
      idlePercent: 81.8,
      loadAverage: [1.2, 1.5, 1.4],
      perCorePercent: [10, 20, 30],
      temperatureCelsius: null,
    },
    memory: {
      totalBytes: 34_359_738_368,
      usedBytes: 21_642_608_640,
      availableBytes: 12_717_129_728,
      usedPercent: 62.9,
      appBytes: 9_000_000_000,
      wiredBytes: 3_000_000_000,
      compressedBytes: 1_000_000_000,
      cachedBytes: 4_000_000_000,
      swapUsedBytes: 0,
      pressure: 'normal',
    },
    disk: {
      name: 'Macintosh HD',
      mount: '/System/Volumes/Data',
      totalBytes: 994_662_584_320,
      usedBytes: 168_000_000_000,
      freeBytes: 826_662_584_320,
      usedPercent: 16.9,
    },
    network: {
      interface: 'en1',
      localIp: '192.168.1.47',
      receivedBytesPerSecond: 512,
      sentBytesPerSecond: 64,
      receivedTotalBytes: 1_000_000,
      sentTotalBytes: 500_000,
    },
    battery: null,
    ...overrides,
  }
}

/** Slim stand-ins for the sampler and the fan controller. */
function fakeSampler({ fanCount = 1, temperatures = [{ key: 'Tp01', celsius: 75 }] } = {}) {
  const sample = {
    at: 1_761_220_000_000,
    fanCount,
    fans: fanCount > 0
      ? [{ index: 0, actualRpm: 2400, targetRpm: 2400, minRpm: 1000, maxRpm: 4900, mode: 'auto' }]
      : [],
    temperatures,
  }
  return {
    sample,
    started: 0,
    disposed: 0,
    latest() {
      return this.sample
    },
    status() {
      return { available: true, state: 'ready', reason: null, samples: 1, fanCount: this.sample.fanCount }
    },
    async start() {
      this.started += 1
      return this.status()
    },
    dispose() {
      this.disposed += 1
    },
  }
}

/** Slim stand-in for the fan controller. */
function fakeFans() {
  return {
    started: 0,
    disposed: 0,
    ticks: 0,
    status() {
      return {
        state: 'not-installed',
        reason: null,
        message: null,
        installed: false,
        running: false,
        otherControllers: [],
        mode: 'auto',
        manualRpm: 2560,
        curve: { sensor: 'cpuPerformance', points: [] },
        sensorOptions: ['cpuPerformance'],
        appliedRpm: null,
        lastAppliedAt: null,
        minRpm: 1000,
        maxRpm: 4900,
        presets: [{ id: 'auto', name: 'auto', builtin: true, mode: 'auto' }],
      }
    },
    async start() {
      this.started += 1
    },
    tick() {
      this.ticks += 1
    },
    dispose() {
      this.disposed += 1
    },
    presets() {
      return [{ id: 'auto', name: 'auto', builtin: true, mode: 'auto' }]
    },
    savePreset() {
      return { presets: [{ id: 'p-1', name: '剪辑', builtin: false, mode: 'manual', rpm: 3000 }] }
    },
    deletePreset() {
      return { presets: [] }
    },
    async install() {
      return this.status()
    },
    async uninstall() {
      return this.status()
    },
    async apply() {
      return this.status()
    },
  }
}

/**
 * Build a service with fakes and a controllable clock, plus cleanup.
 *
 * @param {object} [options] - test options.
 * @returns {{ service: MonitorService, sampler: object, fans: object, notifications: object[], clock: object }} fixture.
 */
function createFixture({ platform = 'darwin', fanCount = 1, software = undefined, sampler = undefined, fans = undefined } = {}) {
  const clock = { value: 1_761_220_000_000 }
  const notifications = []
  const stateDirectory = mkdtempSync(join(tmpdir(), 'dsh-monitor-test-'))
  const service = new MonitorService({
    stateDirectory,
    config: {},
    version: '9.9.9-test',
    platform,
    now: () => clock.value,
    warn: () => {},
    sampler: sampler ?? fakeSampler({ fanCount }),
    fanController: fans ?? fakeFans(),
    collectSoftware: async () => (typeof software === 'function' ? software(clock.value) : (software ?? softwareSample())),
    notify: async (event) => {
      notifications.push(event)
      return true
    },
  })
  return { service, sampler: service.sampler, fans: service.fan, notifications, clock }
}

test('the snapshot follows the client contract', async () => {
  const { service, sampler, fans } = createFixture()
  await service.start()
  try {
    const snapshot = service.snapshot()
    assert.equal(snapshot.version, '9.9.9-test')
    assert.match(snapshot.sampledAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.equal(snapshot.capabilities.platform, 'darwin')
    assert.equal(snapshot.capabilities.sensors.supported, true)
    assert.equal(snapshot.capabilities.fanControl.supported, true)
    assert.equal(snapshot.capabilities.battery, false)
    assert.equal(snapshot.capabilities.processes, true)
    assert.equal(snapshot.sample.host.cpuModel, 'Apple M4')
    assert.equal(snapshot.sample.cpu.temperatureCelsius, 75)
    assert.equal(snapshot.sample.sensors.available, true)
    assert.equal(snapshot.sample.sensors.groups.cpuPerformance, 75)
    assert.equal(snapshot.sample.fans.items.length, 1)
    assert.equal(snapshot.sample.fans.items[0].mode, 'auto')
    assert.equal(snapshot.fanControl.state, 'not-installed')
    assert.equal(snapshot.alerts.settings.cpuPercent, MONITOR_ALERT_DEFAULTS.cpuPercent)
    assert.equal(snapshot.history.capacity, HISTORY_CAPACITY)
    assert.equal(snapshot.history.cpu.length, 1)
    assert.equal(snapshot.history.cpu[0].value, 18.2)
    assert.equal(sampler.started, 1)
    assert.equal(fans.started, 1)
  } finally {
    service.dispose()
  }
})

test('history keeps the ring at capacity and records one point per collection', async () => {
  let tick = 0
  const { service, clock } = createFixture({
    software: () => softwareSample({
      at: new Date().toISOString(),
      cpu: { ...softwareSample().cpu, usagePercent: tick },
    }),
  })
  await service.start()
  try {
    for (let index = 0; index < HISTORY_CAPACITY + 5; index += 1) {
      clock.value += 2000
      tick += 1
      await service.collectOnce()
    }
    const snapshot = service.snapshot()
    assert.equal(snapshot.history.cpu.length, HISTORY_CAPACITY)
    assert.equal(snapshot.history.cpu[snapshot.history.cpu.length - 1].value, tick)
    assert.equal(snapshot.history.memory.length, HISTORY_CAPACITY)
    clock.value += 500
    await service.collectOnce()
    assert.equal(service.snapshot().history.cpu.length, HISTORY_CAPACITY, 'a throttled collect adds no point')
  } finally {
    service.dispose()
  }
})

test('threshold alerts fire, notify and land in the snapshot', async () => {
  const { service, notifications } = createFixture({
    software: () => softwareSample({
      cpu: { ...softwareSample().cpu, usagePercent: 96 },
    }),
  })
  await service.start()
  try {
    const snapshot = service.snapshot()
    assert.equal(snapshot.alerts.settings.enabled, true)
    assert.equal(snapshot.alerts.events.length, 1)
    assert.equal(snapshot.alerts.events[0].metric, 'cpu')
    assert.equal(snapshot.alerts.events[0].value, 96)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].metric, 'cpu')
    const saved = service.saveAlertSettings({ cpuPercent: 50, enabled: true })
    assert.equal(saved.settings.cpuPercent, 50)
    assert.ok(saved.events.length >= 1)
    const tested = await service.testAlert()
    assert.deepEqual(tested, { notified: true })
    assert.equal(notifications.length, 2)
    assert.equal(notifications[1].test, true)
  } finally {
    service.dispose()
  }
})

test('alert settings are clamped by the alert monitor', async () => {
  const { service } = createFixture()
  try {
    service.saveAlertSettings({ cpuPercent: 500, temperatureCelsius: 10, memoryPercent: -4, cooldownSeconds: 99999 })
    const settings = service.snapshot().alerts.settings
    assert.equal(settings.cpuPercent, 100)
    assert.equal(settings.temperatureCelsius, 40)
    assert.equal(settings.memoryPercent, 1)
    assert.equal(settings.cooldownSeconds, 3600)
  } finally {
    service.dispose()
  }
})

test('fan endpoints delegate to the controller', async () => {
  const { service, fans } = createFixture()
  try {
    assert.deepEqual(await service.installFanControl(), fans.status())
    assert.deepEqual(await service.uninstallFanControl(), fans.status())
    assert.deepEqual(await service.applyFanControl({ mode: 'auto' }), fans.status())
    assert.deepEqual(service.fanPresets({ op: 'save', name: 'x', mode: 'manual', rpm: 2000 }).presets[0].id, 'p-1')
    assert.deepEqual(service.fanPresets({ op: 'delete', id: 'p-1' }).presets, [])
  } finally {
    service.dispose()
  }
})

test('non-macOS platforms degrade to an unavailable fan card', async () => {
  const { service } = createFixture({ platform: 'linux' })
  await service.start()
  try {
    const snapshot = service.snapshot()
    assert.equal(snapshot.capabilities.platform, 'other')
    assert.equal(snapshot.capabilities.sensors.supported, false)
    assert.equal(snapshot.capabilities.fanControl.supported, false)
    assert.equal(snapshot.capabilities.fanControl.reason, 'unsupported-platform')
    assert.equal(snapshot.fanControl.state, 'unavailable')
    assert.equal((await service.testAlert()).notified, false)
  } finally {
    service.dispose()
  }
})

test('no fans reports no-fans instead of a broken control card', async () => {
  const { service } = createFixture({ fanCount: 0 })
  await service.start()
  try {
    const snapshot = service.snapshot()
    assert.equal(snapshot.capabilities.fanControl.supported, false)
    assert.equal(snapshot.capabilities.fanControl.reason, 'no-fans')
  } finally {
    service.dispose()
  }
})

test('process ranking and invalid kills are contained', async () => {
  const { service } = createFixture()
  try {
    const processes = await service.processes({ sort: 'cpu', limit: 5 })
    assert.equal(processes.sort, 'cpu')
    assert.ok(Array.isArray(processes.processes))
    assert.ok(processes.processes.length <= 5)
    for (const row of processes.processes) {
      assert.equal(typeof row.pid, 'number')
      assert.equal(typeof row.name, 'string')
      assert.equal(typeof row.killable, 'boolean')
    }
    await assert.rejects(() => service.kill(1), (error) => error.code === 'kill_invalid_pid')
    await assert.rejects(() => service.kill(process.pid), (error) => error.code === 'kill_invalid_pid')
  } finally {
    service.dispose()
  }
})

test('dispose stops the sampler, the fan controller and the timer', async () => {
  const { service, sampler, fans } = createFixture()
  await service.start()
  service.dispose()
  service.dispose()
  assert.equal(sampler.disposed, 1)
  assert.equal(fans.disposed, 1)
  assert.equal(service.timer, null)
})

test('notification text is built and escaped for AppleScript', () => {
  assert.equal(
    buildNotificationScript('Mac Tools', '温度 96.2°C 超过阈值 95°C'),
    'display notification "温度 96.2°C 超过阈值 95°C" with title "Mac Tools"',
  )
  assert.match(buildNotificationScript('a"b', 'c\\d'), /\\"b/u)
  assert.equal(describeAlert({ metric: 'temperature', value: 96.2, threshold: 95 }), '温度 96.2°C 超过阈值 95°C')
  assert.equal(describeAlert({ metric: 'cpu', value: 91, threshold: 90 }), 'CPU 占用 91% 超过阈值 90%')
  assert.equal(describeAlert({ metric: 'memory', value: 95.5, threshold: 90 }), '内存 95.5% 超过阈值 90%')
})

test('the real sampler feeds a live snapshot on this Mac', {
  skip: process.platform !== 'darwin' || resolveSwiftc() === undefined,
}, async () => {
  const service = new MonitorService({
    stateDirectory: '/tmp/dsh-monitor-live-state',
    config: {},
    version: 'live',
    warn: () => {},
  })
  await service.start()
  try {
    // The sampler compiles on the first run of this checkout; give it room.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && service.sampler.latest() === null) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const snapshot = service.snapshot()
    assert.equal(snapshot.capabilities.platform, 'darwin')
    assert.ok(Number.isFinite(snapshot.sample.cpu.usagePercent))
    assert.ok(snapshot.sample.memory.totalBytes > 0)
    assert.ok(snapshot.sample.disk.totalBytes > 0)
    if (snapshot.sample.sensors.available) {
      assert.ok(snapshot.sample.sensors.readings.length > 0)
      assert.equal(typeof snapshot.sample.fans.available, 'boolean')
    }
    // The helper may be installed on the machine running the tests; this test
    // never installs or removes it and never applies a fan setting.
    assert.equal(typeof snapshot.fanControl.installed, 'boolean')
    assert.ok(
      ['not-installed', 'ready', 'error', 'unavailable', 'installing'].includes(snapshot.fanControl.state),
      `unexpected fan state ${snapshot.fanControl.state}`,
    )
    assert.equal(snapshot.fanControl.mode, 'auto', 'the live test must not take fan control')
  } finally {
    service.dispose()
  }
})

/** Re-exported contract constant: the default thresholds must stay in sync. */
test('monitor alert defaults stay aligned with the alert module', async () => {
  const { ALERT_DEFAULTS } = await import('../src/alerts.js')
  assert.deepEqual({ ...MONITOR_ALERT_DEFAULTS }, { ...ALERT_DEFAULTS })
})


/** A fake monitor service for the dispatcher wiring tests. */
function fakeMonitorService({ failApply = false } = {}) {
  return {
    snapshot: () => ({ version: '9.9.9-test', sample: {}, capabilities: {}, history: {}, alerts: {}, fanControl: {} }),
    processes: async ({ sort, limit }) => ({ sampledAt: 'now', sort, count: 1, processes: [{ pid: 2, name: 'x', cpuPercent: 1, memoryPercent: 1, rssBytes: 1, user: 'u', killable: true }], limit }),
    kill: async (pid) => ({ pid, name: 'x', signal: 'SIGTERM' }),
    saveAlertSettings: (patch) => ({ settings: { cpuPercent: patch.cpuPercent ?? 90 }, events: [] }),
    testAlert: async () => ({ notified: true }),
    installFanControl: async () => ({ state: 'ready' }),
    uninstallFanControl: async () => ({ state: 'not-installed' }),
    applyFanControl: async (spec) => {
      if (failApply) {
        const error = new Error('the fan helper is not installed')
        error.code = 'fan_not_ready'
        error.details = { reason: 'not-installed' }
        throw error
      }
      return { mode: spec.mode }
    },
    fanPresets: () => ({ presets: [{ id: 'auto' }] }),
  }
}

/**
 * Build a dispatcher wired to a fake monitor.
 *
 * @param {object | null} monitor - monitor service or null.
 * @returns {{ dispatch: Function, dispose: () => void }} dispatcher fixture.
 */
function createMonitorOps(monitor) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-monitor-ops-'))
  const store = new ShotStore({ directory: join(root, 'shots'), maxShots: 1 })
  const ops = createOps({
    config: { saveDirectory: join(root, 'saves'), maxShots: 1, interactiveTimeoutMs: 1000, hideAppDuringCapture: false },
    store,
    capture: {},
    warn: () => {},
    version: '9.9.9',
    ...(monitor === null ? {} : { monitor }),
  })
  return { dispatch: ops.dispatch, dispose: () => ops.dispose() }
}

test('monitor endpoints are dispatched and failures keep their codes', async () => {
  const ops = createMonitorOps(fakeMonitorService())
  try {
    assert.equal((await ops.dispatch('monitor')).version, '9.9.9-test')
    const processes = await ops.dispatch('monitorProcesses', { sort: 'memory', limit: 5 })
    assert.equal(processes.sort, 'memory')
    assert.equal(processes.limit, 5)
    assert.equal((await ops.dispatch('monitorKill', { pid: 4242 })).pid, 4242)
    await assert.rejects(() => ops.dispatch('monitorKill', { pid: 0 }), (error) => error.code === 'invalid_request')
    await assert.rejects(() => ops.dispatch('monitorKill', { pid: 'x' }), (error) => error.code === 'invalid_request')
    assert.equal((await ops.dispatch('fanApply', { mode: 'auto' })).mode, 'auto')
    assert.equal((await ops.dispatch('fanPreset', { op: 'save', name: 'x' })).presets.length, 1)
    assert.deepEqual(await ops.dispatch('monitorAlertTest'), { notified: true })
    assert.equal((await ops.dispatch('monitorAlertSave', { cpuPercent: 55 })).settings.cpuPercent, 55)
  } finally {
    ops.dispose()
  }
})

test('fan-layer failures keep their stable codes in the envelope', async () => {
  const ops = createMonitorOps(fakeMonitorService({ failApply: true }))
  try {
    await assert.rejects(() => ops.dispatch('fanApply', { mode: 'manual', rpm: 2500 }), (error) => {
      assert.equal(error.code, 'fan_not_ready')
      assert.equal(error.details.reason, 'not-installed')
      return true
    })
  } finally {
    ops.dispose()
  }
})

test('a build without the monitor reports the endpoint as unsupported', async () => {
  const ops = createMonitorOps(null)
  try {
    await assert.rejects(() => ops.dispatch('monitor'), (error) => error.code === 'unsupported')
    await assert.rejects(() => ops.dispatch('fanInstall'), (error) => error.code === 'unsupported')
  } finally {
    ops.dispose()
  }
})
