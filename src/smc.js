/**
 * The SMC sensor sampler.
 *
 * `assets/state.swift` is compiled once and kept as a child process of the Host:
 * it prints one JSON line per sample (fan speeds and every readable temperature
 * key). This module owns that child process, parses its lines, caches the last
 * sample and restarts the helper if it dies. Read-only — fan writes go through
 * `fan-daemon.swift` behind the privileged helper in `src/fans.js`.
 *
 * The child is best-effort: a missing toolchain, a Mac without an accessible
 * `AppleSMC` or a helper crash each degrade to `status().reason` instead of
 * failing the plugin row. The panel still shows CPU/memory/disk/network from
 * `src/metrics.js` in that case.
 *
 * @module dsh-mac-tools/smc
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { ensureSwiftBinary, SwiftBuildError } from './swift.js'

/** Families of SMC temperature keys shown as summary groups in the panel. */
export const TEMPERATURE_FAMILIES = Object.freeze({
  cpuPerformance: /^Tp/u,
  cpuEfficiency: /^Te/u,
  gpu: /^Tg/u,
  ssd: /^TH/u,
  memory: /^Tm/u,
  wifi: /^TW/u,
  battery: /^TB/u,
})

/**
 * Families worth listing in the panel's "all sensors" disclosure. The SMC key
 * space also carries hundreds of calibration / power-delivery sensors (`Tz*`,
 * `TCM*`, `TPD*`, `TR*`, …) that are noise for a person reading temperatures.
 */
const CURATED_FAMILIES = /^(?:Tp|Te|Tg|TH|Tm|TB|TW)/u

/**
 * @typedef {object} FanReading
 * @property {number} index - fan index from 0.
 * @property {number | null} actualRpm - current speed.
 * @property {number | null} targetRpm - target speed reported by the SMC.
 * @property {number | null} minRpm - minimum speed reported by the SMC.
 * @property {number | null} maxRpm - maximum speed reported by the SMC.
 * @property {'auto' | 'forced' | 'unknown'} mode - SMC control mode.
 */

/**
 * @typedef {object} SensorSample
 * @property {number} at - epoch milliseconds.
 * @property {number} fanCount - number of fans reported by `FNum`.
 * @property {FanReading[]} fans - one entry per fan.
 * @property {{ key: string, celsius: number }[]} temperatures - every readable temperature key.
 */

/**
 * Round to one decimal so the panel's numbers are stable between samples.
 *
 * @param {number} value - raw value.
 * @returns {number} the rounded value.
 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * Validate and normalize one helper sample. Pure, so the interesting cases are
 * unit-tested without an SMC.
 *
 * @param {unknown} raw - parsed JSON line from the helper.
 * @returns {SensorSample | null} the normalized sample, or null when the shape is unusable.
 */
export function normalizeSample(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = /** @type {Record<string, unknown>} */ (raw)
  const at = Number.isFinite(value.at) ? Number(value.at) : Date.now()

  /** @type {FanReading[]} */
  const fans = []
  if (Array.isArray(value.fans)) {
    for (const entry of value.fans) {
      if (entry === null || typeof entry !== 'object') continue
      const fan = /** @type {Record<string, unknown>} */ (entry)
      const index = Number(fan.index)
      if (!Number.isInteger(index) || index < 0 || index > 31) continue
      const number = (field) => (Number.isFinite(fan[field]) ? round1(Number(fan[field])) : null)
      const mode = fan.mode === 'auto' || fan.mode === 'forced' ? fan.mode : 'unknown'
      fans.push({
        index,
        actualRpm: number('actualRpm'),
        targetRpm: number('targetRpm'),
        minRpm: number('minRpm'),
        maxRpm: number('maxRpm'),
        mode,
      })
    }
  }
  fans.sort((left, right) => left.index - right.index)

  /** @type {{ key: string, celsius: number }[]} */
  const temperatures = []
  const seen = new Set()
  if (Array.isArray(value.temperatures)) {
    for (const entry of value.temperatures) {
      if (entry === null || typeof entry !== 'object') continue
      const reading = /** @type {Record<string, unknown>} */ (entry)
      const key = typeof reading.key === 'string' ? reading.key : ''
      if (!/^[A-Za-z0-9]{4}$/u.test(key) || seen.has(key)) continue
      const celsius = Number(reading.celsius)
      if (!Number.isFinite(celsius) || celsius < -40 || celsius > 200) continue
      seen.add(key)
      temperatures.push({ key, celsius: round1(celsius) })
    }
  }

  const fanCount = Number.isInteger(value.fanCount) && Number(value.fanCount) >= 0
    ? Number(value.fanCount)
    : fans.length

  return { at, fanCount, fans, temperatures }
}

/**
 * Group raw readings into the temperatures the panel highlights, and curate the
 * detailed list. Pure.
 *
 * @param {{ key: string, celsius: number }[]} readings - normalized readings.
 * @returns {{ groups: Record<string, number | null>, readings: { key: string, celsius: number }[], hidden: number }} summary.
 */
export function summarizeTemperatures(readings) {
  /** @type {Record<string, number | null>} */
  const groups = {
    cpuPerformance: null,
    cpuEfficiency: null,
    gpu: null,
    ssd: null,
    memory: null,
    wifi: null,
    battery: null,
    ambient: null,
  }
  const list = Array.isArray(readings) ? readings : []
  for (const [name, pattern] of Object.entries(TEMPERATURE_FAMILIES)) {
    let maximum = null
    for (const reading of list) {
      if (!pattern.test(reading.key)) continue
      if (!Number.isFinite(reading.celsius) || reading.celsius <= 0) continue
      if (maximum === null || reading.celsius > maximum) maximum = reading.celsius
    }
    groups[name] = maximum
  }

  const curated = list
    .filter((reading) => CURATED_FAMILIES.test(reading.key) && Number.isFinite(reading.celsius) && reading.celsius > 0)
    .slice()
    .sort((left, right) => right.celsius - left.celsius)
  const visible = curated.slice(0, 40)
  return { groups, readings: visible, hidden: Math.max(0, list.length - visible.length) }
}

/** @returns {string[]} the Swift sources the sampler helper is built from. */
export function samplerSources() {
  return [
    fileURLToPath(new URL('../assets/smc-core.swift', import.meta.url)),
    fileURLToPath(new URL('../assets/state.swift', import.meta.url)),
  ]
}

/**
 * Run the helper once (`--once`) and return its sample. Used for capability
 * probes and live tests; the panel's normal path is {@link SmcSampler}.
 *
 * @param {object} [options] - probe options.
 * @param {string[]} [options.sourcePaths] - helper Swift sources.
 * @param {string} [options.cacheDirectory] - compiled-helper directory.
 * @param {typeof ensureSwiftBinary} [options.compile] - compiler entry (injectable).
 * @returns {Promise<SensorSample>} one sample.
 * @throws {SwiftBuildError} when compilation fails.
 * @throws {Error} with `code` = 'smc-unavailable' when the helper cannot read the SMC.
 */
export async function probeSensors({
  sourcePaths = samplerSources(),
  cacheDirectory = undefined,
  compile = ensureSwiftBinary,
} = {}) {
  const binary = await compile({
    sourcePaths,
    cacheName: 'smc-sampler',
    ...(cacheDirectory === undefined ? {} : { cacheDirectory }),
  })
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--once'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const error = new Error('the SMC sampler did not answer in time')
      error.code = 'smc-timeout'
      reject(error)
    }, 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (failure) => {
      clearTimeout(timer)
      reject(failure)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const line = stdout.trim().split(/\r?\n/u).filter((entry) => entry !== '')[0] ?? ''
      if (line === '') {
        const error = new Error(stderr.trim() === '' ? 'the SMC sampler failed' : stderr.trim())
        error.code = stderr.includes('SMC_UNAVAILABLE') ? 'smc-unavailable' : 'smc-failed'
        reject(error)
        return
      }
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        const error = new Error('the SMC sampler returned invalid JSON')
        error.code = 'smc-invalid'
        reject(error)
        return
      }
      const sample = normalizeSample(parsed)
      if (sample === null) {
        const error = new Error('the SMC sampler returned an unusable sample')
        error.code = 'smc-invalid'
        reject(error)
        return
      }
      void code
      resolve(sample)
    })
  })
}

/**
 * Own the long-running sampler child process.
 */
export class SmcSampler {
  /**
   * @param {object} [options] - sampler options.
   * @param {number} [options.intervalMs] - sampling cadence, 200…60000.
   * @param {string[]} [options.sourcePaths] - helper Swift sources.
   * @param {string} [options.cacheDirectory] - compiled-helper directory.
   * @param {typeof ensureSwiftBinary} [options.compile] - compiler entry (injectable).
   * @param {typeof spawn} [options.spawnProcess] - child-process factory (injectable).
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {number} [options.readyTimeoutMs] - how long the first sample may take.
   */
  constructor({
    intervalMs = 1000,
    sourcePaths = samplerSources(),
    cacheDirectory = undefined,
    compile = ensureSwiftBinary,
    spawnProcess = spawn,
    warn = () => {},
    readyTimeoutMs = 25_000,
  } = {}) {
    this.intervalMs = Number.isInteger(intervalMs) ? Math.min(60_000, Math.max(200, intervalMs)) : 1000
    this.sourcePaths = sourcePaths
    this.cacheDirectory = cacheDirectory
    this.compile = compile
    this.spawnProcess = spawnProcess
    this.warn = warn
    this.readyTimeoutMs = readyTimeoutMs

    /** @type {'idle' | 'starting' | 'ready' | 'unavailable'} */
    this.state = 'idle'
    /** @type {string | null} */
    this.reason = null
    /** @type {SensorSample | null} */
    this.sample = null
    /** @type {number} */
    this.sampleCount = 0
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {NodeJS.Timeout | null} */
    this.restartTimer = null
    /** @type {NodeJS.Timeout | null} */
    this.readyTimer = null
    /** @type {number} */
    this.restartCount = 0
    this.disposed = false
    this.binary = null
    this.stderr = ''
  }

  /** @returns {{ available: boolean, state: string, reason: string | null, samples: number, fanCount: number | null }} public status. */
  status() {
    return {
      available: this.state === 'ready' && this.sample !== null,
      state: this.state,
      reason: this.reason,
      samples: this.sampleCount,
      fanCount: this.sample === null ? null : this.sample.fanCount,
    }
  }

  /** @returns {SensorSample | null} the most recent sample. */
  latest() {
    return this.sample
  }

  /**
   * Compile and spawn the helper. Safe to call more than once; failures are
   * recorded in `status().reason`.
   *
   * @returns {Promise<{ available: boolean, state: string, reason: string | null, samples: number, fanCount: number | null }>} the settled status.
   */
  async start() {
    if (this.disposed || this.state === 'starting' || this.state === 'ready') return this.status()
    this.state = 'starting'
    this.reason = null
    try {
      this.binary = await this.compile({
        sourcePaths: this.sourcePaths,
        cacheName: 'smc-sampler',
        ...(this.cacheDirectory === undefined ? {} : { cacheDirectory: this.cacheDirectory }),
      })
    } catch (failure) {
      this.state = 'unavailable'
      this.reason = failure instanceof SwiftBuildError ? failure.code : 'compile-failed'
      this.warn(`the SMC sampler is unavailable: ${failure instanceof Error ? failure.message : String(failure)}`)
      return this.status()
    }
    if (this.disposed) return this.status()
    this.spawnHelper()
    return this.status()
  }

  /** Spawn the child and wire its stdout/stderr. */
  spawnHelper() {
    if (this.binary === null || this.disposed) return
    let child
    try {
      child = this.spawnProcess(this.binary, ['--interval-ms', String(this.intervalMs)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (failure) {
      this.state = 'unavailable'
      this.reason = 'spawn-failed'
      this.warn('could not start the SMC sampler', failure)
      return
    }
    this.child = child
    this.stderr = ''
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      if (buffer.length > 1_000_000) buffer = buffer.slice(-500_000)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line === '') continue
        this.acceptLine(line)
      }
    })
    child.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4_000)
    })
    child.on('error', (failure) => {
      this.warn('the SMC sampler process failed', failure)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.readyTimer !== null) {
        clearTimeout(this.readyTimer)
        this.readyTimer = null
      }
      if (this.disposed) return
      const unavailable = this.stderr.includes('SMC_UNAVAILABLE')
      this.state = 'unavailable'
      this.reason = unavailable ? 'smc-unavailable' : 'helper-exited'
      if (unavailable) {
        this.warn('the SMC sampler could not open AppleSMC (is this a Mac with a readable SMC?)')
        return
      }
      this.warn(`the SMC sampler exited (${signal ?? code}); restarting`)
      this.scheduleRestart()
    })
    if (this.readyTimer !== null) clearTimeout(this.readyTimer)
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null
      if (this.state === 'starting') {
        this.warn('the SMC sampler has not produced a sample yet')
      }
    }, this.readyTimeoutMs)
  }

  /** Restart the helper with a bounded backoff after an unexpected exit. */
  scheduleRestart() {
    if (this.disposed || this.restartTimer !== null) return
    if (this.restartCount >= 5) {
      this.reason = this.reason === null ? 'helper-exited' : this.reason
      this.warn('the SMC sampler keeps exiting; giving up until the plugin reloads')
      return
    }
    this.restartCount += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnHelper()
    }, 2000)
  }

  /**
   * Accept one JSON line from the helper.
   *
   * @param {string} line - one stdout line.
   * @returns {void}
   */
  acceptLine(line) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const sample = normalizeSample(parsed)
    if (sample === null) return
    this.sample = sample
    this.sampleCount += 1
    this.state = 'ready'
    this.reason = null
    this.restartCount = 0
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  /** Stop the child (if any) and forget the cached sample. */
  dispose() {
    this.disposed = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.child !== null) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        // The child may already be gone.
      }
      this.child = null
    }
    this.sample = null
    this.state = 'idle'
  }
}
