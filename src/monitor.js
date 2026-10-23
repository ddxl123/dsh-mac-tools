/**
 * The monitor service: one 1 s sampling loop behind the 运行状态 tab.
 *
 * It merges three sources into the snapshot the panel polls:
 * - software metrics (CPU/memory/disk/network/battery/uptime) from
 *   `src/metrics.js`, collected on a slightly slower cadence (every ≥2 s) so
 *   the tab does not spawn six commands per second;
 * - SMC temperatures and fan speeds from `src/smc.js`;
 * - fan-control state from `src/fans.js`.
 *
 * It also owns the panel's disk contract: a 60-entry history ring for the
 * sparklines, the threshold monitor (`src/alerts.js`) and the macOS
 * notification for fired alerts. Every producer degrades independently — a
 * missing SMC, an unreadable battery or a refused `df` only blanks its own
 * field.
 *
 * @module dsh-mac-tools/monitor
 */

import { runProcess } from './capture.js'
import { AlertMonitor, ALERT_DEFAULTS } from './alerts.js'
import { FanController } from './fans.js'
import { collectSoftwareMetrics } from './metrics.js'
import { killProcess, listProcesses } from './processes.js'
import { SmcSampler, summarizeTemperatures } from './smc.js'

/** Chart history depth: 60 samples at ~2 s means a two-minute window. */
export const HISTORY_CAPACITY = 60

/** Software metrics are collected no more often than this (milliseconds). */
export const MIN_SOFTWARE_INTERVAL_MS = 2000

/** Default alert thresholds; the row config can override the first-run values. */
export const MONITOR_ALERT_DEFAULTS = Object.freeze({
  enabled: true,
  cpuPercent: 90,
  temperatureCelsius: 95,
  memoryPercent: 90,
  cooldownSeconds: 300,
  notify: true,
})

const METRIC_LABELS = Object.freeze({ cpu: 'CPU 占用', temperature: '温度', memory: '内存' })

/**
 * Build the AppleScript that shows one macOS notification.
 *
 * @param {string} title - notification title.
 * @param {string} body - notification body.
 * @returns {string} AppleScript source.
 */
export function buildNotificationScript(title, body) {
  const escape = (value) => String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
  return `display notification "${escape(body)}" with title "${escape(title)}"`
}

/**
 * Human text for one alert event (Host-side, used only in the OS notification).
 *
 * @param {{ metric: string, value: number, threshold: number }} event - one fired event.
 * @returns {string} notification body, e.g. `温度 96.2°C 超过阈值 95°C`.
 */
export function describeAlert(event) {
  const label = METRIC_LABELS[event.metric] ?? event.metric
  const unit = event.metric === 'temperature' ? '°C' : '%'
  return `${label} ${event.value}${unit} 超过阈值 ${event.threshold}${unit}`
}

/**
 * The empty sample served before the first collection finishes. Shapes match
 * the contract so the client never has to special-case a pre-first-tick read.
 *
 * @param {string} at - ISO timestamp.
 * @returns {object} a zeroed sample.
 */
function placeholderSample(at) {
  return {
    at,
    host: {
      hostname: '',
      modelName: '',
      modelIdentifier: '',
      cpuModel: '',
      arch: process.arch,
      osName: process.platform === 'darwin' ? 'macOS' : process.platform,
      osVersion: '',
      cpuCores: 0,
      performanceCores: null,
      efficiencyCores: null,
      uptimeSeconds: 0,
    },
    cpu: {
      usagePercent: 0,
      userPercent: 0,
      systemPercent: 0,
      idlePercent: 100,
      loadAverage: [0, 0, 0],
      perCorePercent: [],
      temperatureCelsius: null,
    },
    memory: {
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      usedPercent: 0,
      appBytes: 0,
      wiredBytes: 0,
      compressedBytes: 0,
      cachedBytes: 0,
      swapUsedBytes: 0,
      pressure: null,
    },
    disk: { name: '', mount: '', totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0 },
    network: {
      interface: null,
      localIp: null,
      receivedBytesPerSecond: 0,
      sentBytesPerSecond: 0,
      receivedTotalBytes: 0,
      sentTotalBytes: 0,
    },
    battery: null,
  }
}

/**
 * Own the sampling loop and the panel's monitor endpoints.
 */
export class MonitorService {
  /**
   * @param {object} options - service options.
   * @param {string} options.stateDirectory - plugin state directory (`monitor/` is created here).
   * @param {object} [options.config] - row config (alert defaults, sample interval).
   * @param {string} [options.version] - plugin version reported to the panel.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {typeof runProcess} [options.run] - process runner (injectable for tests).
   * @param {string} [options.platform] - platform override (tests).
   * @param {() => number} [options.now] - clock (tests).
   * @param {typeof collectSoftwareMetrics} [options.collectSoftware] - collector injection (tests).
   * @param {SmcSampler} [options.sampler] - sampler injection (tests).
   * @param {FanController} [options.fanController] - controller injection (tests).
   * @param {((event: object) => Promise<boolean> | boolean) | undefined} [options.notify] - notification sender injection (tests); defaults to `osascript`.
   */
  constructor({
    stateDirectory,
    config = {},
    version = '0.0.0',
    warn = () => {},
    run = runProcess,
    platform = process.platform,
    now = () => Date.now(),
    collectSoftware = collectSoftwareMetrics,
    sampler = undefined,
    fanController = undefined,
    notify = undefined,
  }) {
    this.stateDirectory = stateDirectory
    this.version = version
    this.warn = warn
    this.run = run
    this.platform = platform
    this.now = now
    this.collectSoftware = collectSoftware
    this.sampleMs = Number.isFinite(config.monitorSampleMs)
      ? Math.min(10_000, Math.max(500, Math.round(config.monitorSampleMs)))
      : 1000
    this.softwareIntervalMs = Math.max(MIN_SOFTWARE_INTERVAL_MS, this.sampleMs)
    this.notify = notify ?? ((event) => this.notifyOperator(event))

    this.sampler = sampler ?? new SmcSampler({
      intervalMs: Math.max(500, Math.min(2000, this.sampleMs)),
      warn,
    })
    this.fan = fanController ?? new FanController({
      stateDirectory,
      sampleProvider: () => this.sampler.latest(),
      warn,
      run,
      now,
    })

    this.alerts = new AlertMonitor({
      settings: {
        ...MONITOR_ALERT_DEFAULTS,
        ...(Number.isFinite(config.alertCpuPercent) ? { cpuPercent: config.alertCpuPercent } : {}),
        ...(Number.isFinite(config.alertTemperatureCelsius) ? { temperatureCelsius: config.alertTemperatureCelsius } : {}),
        ...(Number.isFinite(config.alertMemoryPercent) ? { memoryPercent: config.alertMemoryPercent } : {}),
        ...(Number.isFinite(config.alertCooldownSeconds) ? { cooldownSeconds: config.alertCooldownSeconds } : {}),
        ...(typeof config.alertNotify === 'boolean' ? { notify: config.alertNotify } : {}),
      },
      notify: (event) => this.notify(event),
      statePath: `${stateDirectory}/alerts.json`,
      warn,
    })

    /** @type {object | null} latest software sample. */
    this.software = null
    this.softwareAt = 0
    this.collecting = false
    /** @type {NodeJS.Timeout | null} */
    this.timer = null
    this.started = false
    this.disposed = false
    this.sampleCount = 0
    this.history = {
      capacity: HISTORY_CAPACITY,
      cpu: [],
      memory: [],
      networkDown: [],
      networkUp: [],
      cpuTemperature: [],
    }
  }

  /** @returns {Promise<void>} resolves once the sampler, fan controller and loop are up. */
  async start() {
    if (this.started || this.disposed) return
    this.started = true
    if (this.platform === 'darwin') {
      void this.sampler.start()
      void this.fan.start()
    }
    await this.collectOnce()
    if (this.disposed) return
    this.timer = setInterval(() => {
      void this.collectOnce()
    }, this.sampleMs)
    this.timer.unref?.()
  }

  /** Collect one software sample (guarded against overlap) and evaluate alerts. */
  async collectOnce() {
    if (this.disposed || this.collecting) return
    const nowMs = this.now()
    if (this.software !== null && nowMs - this.softwareAt < this.softwareIntervalMs) {
      // Still feed the fan curve every tick; the software metrics can wait.
      this.fan.tick(this.sampler.latest())
      return
    }
    this.collecting = true
    try {
      const previous = this.software
      const collected = await this.collectSoftware({ previous })
      if (this.disposed) return
      this.software = collected
      this.softwareAt = this.now()
      this.sampleCount += 1
      const sample = this.sample()
      this.pushHistory(sample)
      this.alerts.evaluate(sample)
    } catch (failure) {
      this.warn('the monitor sample failed', failure)
    } finally {
      this.collecting = false
      this.fan.tick(this.sampler.latest())
    }
  }

  /**
   * Assemble the current sample from the software metrics and the latest SMC
   * sample.
   *
   * @returns {object} the contract's `sample` shape.
   */
  sample() {
    const at = this.software?.at ?? new Date(this.now()).toISOString()
    const base = this.software === null ? placeholderSample(at) : this.software
    const smc = this.platform === 'darwin' ? this.sampler.latest() : null
    const summary = smc === null
      ? { groups: { cpuPerformance: null, cpuEfficiency: null, gpu: null, ssd: null, memory: null, wifi: null, battery: null, ambient: null }, readings: [], hidden: 0 }
      : summarizeTemperatures(smc.temperatures)
    const samplerStatus = this.sampler.status()
    const sensorReason = smc === null
      ? (samplerStatus.state === 'starting' ? 'starting' : samplerStatus.reason)
      : null
    const cpuTemperature = summary.groups.cpuPerformance ?? summary.groups.cpuEfficiency ?? null
    return {
      ...base,
      at,
      cpu: { ...base.cpu, temperatureCelsius: cpuTemperature },
      sensors: {
        available: smc !== null,
        reason: sensorReason,
        groups: summary.groups,
        readings: summary.readings,
      },
      fans: {
        available: smc !== null && smc.fanCount > 0,
        reason: sensorReason,
        items: (smc?.fans ?? []).map((fan) => ({
          index: fan.index,
          actualRpm: fan.actualRpm,
          targetRpm: fan.targetRpm,
          minRpm: fan.minRpm,
          maxRpm: fan.maxRpm,
          mode: fan.mode,
        })),
      },
    }
  }

  /**
   * Append one sample to the chart history, keeping the ring at capacity.
   *
   * @param {object} sample - assembled sample.
   * @returns {void}
   */
  pushHistory(sample) {
    const stamp = this.now()
    const push = (key, value) => {
      const list = this.history[key]
      list.push({ t: stamp, value: Number.isFinite(value) ? value : null })
      while (list.length > HISTORY_CAPACITY) list.shift()
    }
    push('cpu', sample.cpu.usagePercent)
    push('memory', sample.memory.usedPercent)
    push('networkDown', sample.network.receivedBytesPerSecond)
    push('networkUp', sample.network.sentBytesPerSecond)
    push('cpuTemperature', sample.cpu.temperatureCelsius)
  }

  /** @returns {object} the panel's `monitor` snapshot (contract §3.1). */
  snapshot() {
    const sample = this.sample()
    const samplerStatus = this.sampler.status()
    const sensorsSupported = this.platform === 'darwin' && samplerStatus.available
    const fanStatus = this.platform === 'darwin' ? this.fan.status() : this.unavailableFanStatus()
    const smcSample = this.platform === 'darwin' ? this.sampler.latest() : null
    const fanCount = smcSample === null ? null : smcSample.fanCount
    return {
      version: this.version,
      sampledAt: new Date(this.now()).toISOString(),
      capabilities: {
        platform: this.platform === 'darwin' ? 'darwin' : 'other',
        sensors: {
          supported: sensorsSupported,
          reason: samplerStatus.available
            ? null
            : (samplerStatus.state === 'starting' || samplerStatus.state === 'idle'
              ? 'starting'
              : (samplerStatus.reason ?? 'smc-unavailable')),
        },
        fanControl: {
          supported: this.platform === 'darwin' && fanCount !== 0,
          reason: this.platform !== 'darwin'
            ? 'unsupported-platform'
            : (fanCount === 0 ? 'no-fans' : (fanCount === null ? 'starting' : null)),
        },
        battery: sample.battery !== null && sample.battery !== undefined,
        processes: true,
      },
      sample,
      history: {
        capacity: HISTORY_CAPACITY,
        cpu: [...this.history.cpu],
        memory: [...this.history.memory],
        networkDown: [...this.history.networkDown],
        networkUp: [...this.history.networkUp],
        cpuTemperature: [...this.history.cpuTemperature],
      },
      alerts: this.alerts.snapshot(),
      fanControl: fanStatus,
    }
  }

  /** @returns {object} the fan status on a platform without SMC access. */
  unavailableFanStatus() {
    const limits = { minimum: 1000, maximum: 4900 }
    return {
      state: 'unavailable',
      reason: 'unsupported-platform',
      message: null,
      installed: false,
      running: false,
      otherControllers: [],
      mode: 'auto',
      manualRpm: Math.round(limits.minimum + (limits.maximum - limits.minimum) * 0.4),
      curve: { sensor: 'cpuPerformance', points: [] },
      sensorOptions: ['cpuPerformance'],
      appliedRpm: null,
      lastAppliedAt: null,
      minRpm: limits.minimum,
      maxRpm: limits.maximum,
      presets: [],
    }
  }

  /**
   * The process ranking for the panel.
   *
   * @param {{ sort?: string, limit?: number }} [options] - sort and limit.
   * @returns {Promise<object>} the contract's `monitorProcesses` value.
   */
  async processes({ sort = 'cpu', limit = 15 } = {}) {
    const value = await listProcesses({ sort, limit, run: this.run })
    return { sampledAt: new Date(this.now()).toISOString(), ...value }
  }

  /**
   * Terminate one process.
   *
   * @param {number} pid - process id.
   * @returns {Promise<object>} the kill result.
   */
  async kill(pid) {
    const result = await killProcess(pid, { run: this.run })
    return { ...result, at: new Date(this.now()).toISOString() }
  }

  /**
   * Persist alert settings.
   *
   * @param {object} patch - partial settings.
   * @returns {object} the full alerts block.
   */
  saveAlertSettings(patch) {
    this.alerts.save(patch)
    return this.alerts.snapshot()
  }

  /**
   * Fire one test notification.
   *
   * @returns {Promise<{ notified: boolean }>} whether the notifier ran.
   */
  async testAlert() {
    if (this.platform !== 'darwin') return { notified: false }
    try {
      await this.notify({ metric: 'temperature', value: 96.2, threshold: 95, test: true })
      return { notified: true }
    } catch (failure) {
      this.warn('the test notification failed', failure)
      return { notified: false }
    }
  }

  /**
   * Ask macOS Notification Center to show one alert.
   *
   * @param {object} event - alert event.
   * @returns {Promise<boolean>} whether `osascript` accepted the notification.
   */
  async notifyOperator(event) {
    if (this.platform !== 'darwin') return false
    const body = event.test === true ? '通知测试：运行状态监控已就绪' : describeAlert(event)
    await this.run('/usr/bin/osascript', ['-e', buildNotificationScript('Mac Tools', body)], { timeoutMs: 5000 })
    return true
  }

  /**
   * Install the privileged fan helper (administrator dialog).
   *
   * @returns {Promise<object>} the fan control status.
   */
  async installFanControl() {
    const status = await this.fan.install()
    return status
  }

  /**
   * Remove the privileged fan helper.
   *
   * @returns {Promise<object>} the fan control status.
   */
  async uninstallFanControl() {
    return await this.fan.uninstall()
  }

  /**
   * Apply one fan control specification.
   *
   * @param {object} spec - `{mode:'auto'}`, `{mode:'manual',rpm}`, or `{mode:'curve',sensor,points}`.
   * @returns {Promise<object>} the fan control status.
   */
  async applyFanControl(spec) {
    return await this.fan.apply(spec)
  }

  /**
   * Save or delete a custom fan preset.
   *
   * @param {object} action - `{op:'save',...}` or `{op:'delete',id}`.
   * @returns {{ presets: object[] }} the updated preset list.
   */
  fanPresets(action) {
    if (action === null || typeof action !== 'object') return { presets: this.fan.presets() }
    if (action.op === 'delete') return this.fan.deletePreset(String(action.id ?? ''))
    if (action.op === 'save') return this.fan.savePreset(action)
    return { presets: this.fan.presets() }
  }

  /** Stop the loop and the child processes; restore automatic fan control. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      this.fan.dispose()
    } catch (failure) {
      this.warn('could not stop the fan controller', failure)
    }
    try {
      this.sampler.dispose()
    } catch (failure) {
      this.warn('could not stop the SMC sampler', failure)
    }
  }
}

/** Re-exported so integration code and tests share one defaults object. */
export { ALERT_DEFAULTS }
