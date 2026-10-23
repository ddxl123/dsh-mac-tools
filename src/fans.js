/**
 * Fan speed control, in the spirit of Macs Fan Control.
 *
 * Reads (fan speeds, limits, temperatures) come from the SMC sampler in
 * `src/smc.js` without privileges. Writing the fan target needs root, so this
 * module owns a small privileged helper:
 *
 * 1. `assets/fan-daemon.swift` is compiled once with `swiftc`.
 * 2. `install()` copies it to `/Library/Application Support/DSH Mac Tools/fan/`
 *    and registers a LaunchDaemon (`local.dsh.mac-tools.fan`) through the
 *    standard macOS administrator dialog (`osascript … with administrator
 *    privileges`). This is the one-time authorization the panel discloses.
 * 3. The daemon listens on a Unix socket and accepts a fixed JSON command set
 *    (`set` / `auto` / `autoAll` / `status` / `ping`); it clamps targets to the
 *    fan's SMC limits, accepts only the installing user's connections and
 *    restores automatic control on client disconnect, watchdog timeout and
 *    SIGTERM.
 *
 * The Host keeps a persistent socket connection and re-applies the target every
 * ~2 s, which is what makes the temperature curve work. Uninstalling removes the
 * LaunchDaemon and restores automatic control. Unloading the plugin restores
 * automatic control but keeps the helper installed for the next session.
 *
 * @module dsh-mac-tools/fans
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from './capture.js'
import { ensureSwiftBinary } from './swift.js'

/** Daemon protocol version; the Host refuses a helper with another version. */
export const FAN_PROTOCOL_VERSION = 1

/** LaunchDaemon label the installer registers. */
export const FAN_DAEMON_LABEL = 'local.dsh.mac-tools.fan'

/** Where the privileged helper is installed. */
export const FAN_INSTALL_DIRECTORY = '/Library/Application Support/DSH Mac Tools/fan'
export const FAN_INSTALL_BINARY = `${FAN_INSTALL_DIRECTORY}/fan-daemon`
export const FAN_SOCKET_PATH = `${FAN_INSTALL_DIRECTORY}/fan.sock`
export const FAN_PLIST_PATH = `/Library/LaunchDaemons/${FAN_DAEMON_LABEL}.plist`

/**
 * Curve-mode stabilizer defaults.
 *
 * A curve is driven by one SMC temperature group, and that group is the maximum
 * of several sensors; a single core can hop by 1–2 °C between samples while the
 * machine's actual cooling state barely moves. Feeding that raw value into a
 * fan curve makes the fan audibly hunt. The governor therefore:
 *
 * - smooths the sensor with an EMA, so single-sample maxima never reach the
 *   fan;
 * - ignores target changes smaller than a dead-band (hysteresis), so even the
 *   smoothed jitter stays below the fan's notice;
 * - slew-rate limits every real change — the fan ramps up quickly on a load
 *   step and relaxes slowly afterwards, instead of stepping.
 */
export const CURVE_GOVERNOR_DEFAULTS = Object.freeze({
  deadbandRpm: 80,
  riseRatePerSecond: 450,
  fallRatePerSecond: 120,
  smoothingSeconds: 8,
})

/**
 * Turn a noisy curve sensor reading into a stable, rate-limited fan target.
 *
 * Pure and clock-injected so the behaviour is unit-tested without an SMC.
 */
export class CurveGovernor {
  /**
   * @param {object} [options] - tuning overrides (tests).
   * @param {number} [options.deadbandRpm] - minimum target change that is acted on.
   * @param {number} [options.riseRatePerSecond] - fastest upward change.
   * @param {number} [options.fallRatePerSecond] - fastest downward change.
   * @param {number} [options.smoothingSeconds] - EMA time constant for the sensor.
   */
  constructor({
    deadbandRpm = CURVE_GOVERNOR_DEFAULTS.deadbandRpm,
    riseRatePerSecond = CURVE_GOVERNOR_DEFAULTS.riseRatePerSecond,
    fallRatePerSecond = CURVE_GOVERNOR_DEFAULTS.fallRatePerSecond,
    smoothingSeconds = CURVE_GOVERNOR_DEFAULTS.smoothingSeconds,
  } = {}) {
    this.deadbandRpm = deadbandRpm
    this.riseRatePerSecond = riseRatePerSecond
    this.fallRatePerSecond = fallRatePerSecond
    this.smoothingSeconds = smoothingSeconds
    /** @type {number | null} smoothed sensor temperature */
    this.temperature = null
    /** @type {number | null} last target handed to the fan */
    this.target = null
    /** @type {number | null} last update clock */
    this.updatedAt = null
  }

  /** Forget the smoothing state (mode change, sensor change, reconnect). */
  reset() {
    this.temperature = null
    this.target = null
    this.updatedAt = null
  }

  /**
   * Fold one raw sensor reading into the governor.
   *
   * @param {object} input - one reading.
   * @param {number} input.celsius - raw curve sensor temperature.
   * @param {{ celsius: number, rpm: number }[]} input.points - curve points.
   * @param {{ minimum: number, maximum: number }} input.limits - fan range.
   * @param {number} input.now - clock in epoch milliseconds.
   * @returns {{ target: number, changed: boolean, temperature: number } | null} the target to apply, or null when the reading is unusable.
   */
  update({ celsius, points, limits, now }) {
    if (!Number.isFinite(celsius)) return null
    const nowMs = Number.isFinite(now) ? now : Date.now()
    const low = Number.isFinite(limits?.minimum) ? limits.minimum : 0
    const high = Number.isFinite(limits?.maximum) && limits.maximum > low ? limits.maximum : low + 1000
    if (this.temperature === null || this.updatedAt === null) {
      this.temperature = celsius
      this.updatedAt = nowMs
      const raw = curveRpm(points, this.temperature)
      if (raw === null) return null
      this.target = Math.round(clamp(raw, low, high))
      return { target: this.target, changed: true, temperature: this.temperature }
    }
    const deltaSeconds = clamp((nowMs - this.updatedAt) / 1000, 0.05, 10)
    const tau = this.smoothingSeconds
    const alpha = tau <= 0 ? 1 : 1 - Math.exp(-deltaSeconds / tau)
    this.temperature += (celsius - this.temperature) * alpha
    this.updatedAt = nowMs

    const raw = curveRpm(points, this.temperature)
    if (raw === null) return null
    const desired = clamp(raw, low, high)
    const previous = this.target === null ? desired : this.target
    let next = previous
    const difference = desired - previous
    if (Math.abs(difference) >= this.deadbandRpm) {
      const rate = difference > 0 ? this.riseRatePerSecond : this.fallRatePerSecond
      const step = Math.min(Math.abs(difference), Math.max(1, rate) * deltaSeconds)
      next = Math.round(clamp(previous + Math.sign(difference) * step, low, high))
    }
    const changed = next !== this.target
    this.target = next
    return { target: next, changed, temperature: this.temperature }
  }
}

/** Default temperature curve (percent of the fan's own range). */
const DEFAULT_CURVE_PERCENT = Object.freeze([
  Object.freeze({ celsius: 40, percent: 0 }),
  Object.freeze({ celsius: 60, percent: 0.3 }),
  Object.freeze({ celsius: 75, percent: 0.6 }),
  Object.freeze({ celsius: 90, percent: 1 }),
])

/** Fan control curve sensors the panel can choose from. */
export const CURVE_SENSORS = Object.freeze(['cpuPerformance', 'cpuEfficiency', 'gpu', 'ssd', 'memory'])

/** Processes that also write the fan, detected so the panel can warn about fights. */
const OTHER_CONTROLLER_NAMES = Object.freeze([
  'Macs Fan Control',
  'MacsFanControl',
  'TG Pro',
  'smcFanControl',
  'iStat Menus',
])

/** A fan-control failure carrying a stable code for the operation envelope. */
export class FanError extends Error {
  /**
   * @param {string} code - stable failure code (`fan_not_ready`, `fan_apply_failed`, …).
   * @param {string} message - diagnostic message.
   * @param {object} [details] - machine-readable details.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FanError'
    this.code = code
    this.details = details
  }
}

/**
 * @param {number} value - any number.
 * @param {number} minimum - lower bound.
 * @param {number} maximum - upper bound.
 * @returns {number} the clamped value.
 */
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

/**
 * @param {number} value - any number.
 * @returns {number} the value rounded to a slider-friendly step of 10.
 */
function roundStep(value) {
  return Math.round(value / 10) * 10
}

/**
 * @param {unknown} raw - candidate curve points.
 * @returns {{ celsius: number, rpm: number }[]} a sorted, deduplicated curve (may be empty).
 */
export function normalizeCurve(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {{ celsius: number, rpm: number }[]} */
  const points = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const point = /** @type {Record<string, unknown>} */ (entry)
    const celsius = Number(point.celsius)
    const rpm = Number(point.rpm)
    if (!Number.isFinite(celsius) || !Number.isFinite(rpm)) continue
    points.push({
      celsius: Math.round(clamp(celsius, 0, 120)),
      rpm: Math.round(clamp(rpm, 0, 20000)),
    })
  }
  points.sort((left, right) => left.celsius - right.celsius)
  const deduped = []
  for (const point of points) {
    if (deduped.length > 0 && deduped[deduped.length - 1].celsius === point.celsius) {
      deduped[deduped.length - 1] = point
      continue
    }
    deduped.push(point)
  }
  return deduped.slice(0, 8)
}

/**
 * Evaluate a temperature curve at one temperature with linear interpolation.
 *
 * @param {{ celsius: number, rpm: number }[]} rawPoints - curve points.
 * @param {number | null} celsius - current sensor temperature.
 * @returns {number | null} the target RPM, or null without a usable reading.
 */
export function curveRpm(rawPoints, celsius) {
  if (!Number.isFinite(celsius)) return null
  const points = normalizeCurve(rawPoints)
  if (points.length === 0) return null
  if (celsius <= points[0].celsius) return points[0].rpm
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index]
    const right = points[index + 1]
    if (celsius > right.celsius) continue
    const span = right.celsius - left.celsius
    if (span <= 0) return right.rpm
    const ratio = (celsius - left.celsius) / span
    return Math.round(left.rpm + (right.rpm - left.rpm) * ratio)
  }
  return points[points.length - 1].rpm
}

/**
 * Build the default curve for a fan range.
 *
 * @param {number} minimumRpm - fan minimum.
 * @param {number} maximumRpm - fan maximum.
 * @returns {{ celsius: number, rpm: number }[]} four points, min → max.
 */
export function defaultCurve(minimumRpm, maximumRpm) {
  const range = Math.max(0, maximumRpm - minimumRpm)
  return DEFAULT_CURVE_PERCENT.map((point) => ({
    celsius: point.celsius,
    rpm: roundStep(minimumRpm + range * point.percent),
  }))
}

/**
 * Compute the built-in presets for a fan range (ids only; the panel localizes names).
 *
 * @param {number} minimumRpm - fan minimum.
 * @param {number} maximumRpm - fan maximum.
 * @returns {{ id: string, name: string, builtin: true, mode: 'auto' | 'manual', rpm?: number }[]} presets.
 */
export function builtinPresets(minimumRpm, maximumRpm) {
  const range = Math.max(0, maximumRpm - minimumRpm)
  return [
    { id: 'auto', name: 'auto', builtin: true, mode: 'auto' },
    { id: 'quiet', name: 'quiet', builtin: true, mode: 'manual', rpm: roundStep(minimumRpm) },
    { id: 'balanced', name: 'balanced', builtin: true, mode: 'manual', rpm: roundStep(minimumRpm + range * 0.3) },
    { id: 'performance', name: 'performance', builtin: true, mode: 'manual', rpm: roundStep(minimumRpm + range * 0.62) },
    { id: 'max', name: 'max', builtin: true, mode: 'manual', rpm: roundStep(maximumRpm) },
  ]
}

/**
 * Escape one shell word with single quotes.
 *
 * @param {string} value - raw text.
 * @returns {string} a POSIX single-quoted word.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

/**
 * Escape text inserted into an AppleScript double-quoted literal.
 *
 * @param {string} value - raw text.
 * @returns {string} escaped text (no surrounding quotes).
 */
export function appleScriptEscape(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

/**
 * Build the AppleScript that runs one shell command as administrator.
 *
 * @param {string} command - shell command line.
 * @returns {string} AppleScript source.
 */
export function buildAppleScript(command) {
  return `do shell script "${appleScriptEscape(command)}" with administrator privileges`
}

/**
 * Escape text for XML element content.
 *
 * @param {string} value - raw text.
 * @returns {string} escaped text.
 */
function xmlEscape(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

/**
 * Build the LaunchDaemon plist the installer writes.
 *
 * @param {object} options - plist options.
 * @param {string} options.label - launchd label.
 * @param {string} options.binaryPath - installed helper path.
 * @param {string} options.socketPath - socket path passed to the helper.
 * @param {number} options.ownerUid - uid allowed to talk to the helper.
 * @returns {string} plist text.
 */
export function buildDaemonPlist({ label, binaryPath, socketPath, ownerUid }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(binaryPath)}</string>
\t\t<string>--socket</string>
\t\t<string>${xmlEscape(socketPath)}</string>
\t\t<string>--owner-uid</string>
\t\t<string>${Math.trunc(ownerUid)}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
</dict>
</plist>
`
}

/**
 * Build the administrator install script (run through `osascript` once).
 *
 * Pure so tests can assert the exact privileged surface without running it.
 *
 * @param {object} options - install options.
 * @param {string} options.sourceBinary - freshly compiled helper binary.
 * @param {string} options.installDirectory - target directory.
 * @param {string} options.installBinary - target binary path (inside the directory).
 * @param {string} options.socketPath - socket the daemon should own.
 * @param {string} options.plistPath - LaunchDaemon plist path.
 * @param {string} options.label - launchd label.
 * @param {number} options.ownerUid - uid allowed to connect.
 * @returns {string} bash script text.
 */
export function buildInstallScript({ sourceBinary, installDirectory, installBinary, socketPath, plistPath, label, ownerUid }) {
  const plist = buildDaemonPlist({ label, binaryPath: installBinary, socketPath, ownerUid })
  return `#!/bin/bash
set -euo pipefail
INSTALL_DIR=${shellQuote(installDirectory)}
INSTALL_BINARY=${shellQuote(installBinary)}
PLIST=${shellQuote(plistPath)}
mkdir -p "$INSTALL_DIR"
chmod 755 "$INSTALL_DIR"
cp ${shellQuote(sourceBinary)} "$INSTALL_BINARY"
chown root:wheel "$INSTALL_BINARY"
chmod 755 "$INSTALL_BINARY"
cat > "$PLIST" <<'DSH_FAN_PLIST'
${plist}DSH_FAN_PLIST
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
/bin/launchctl bootout system/${shellQuote(label)} 2>/dev/null || true
/bin/launchctl bootstrap system "$PLIST"
echo DSH_FAN_INSTALLED
`
}

/**
 * Build the administrator uninstall script.
 *
 * @param {object} options - uninstall options.
 * @param {string} options.installDirectory - directory to remove.
 * @param {string} options.plistPath - LaunchDaemon plist to remove.
 * @param {string} options.label - launchd label.
 * @returns {string} bash script text.
 */
export function buildUninstallScript({ installDirectory, plistPath, label }) {
  return `#!/bin/bash
set -u
/bin/launchctl bootout system/${shellQuote(label)} 2>/dev/null || true
rm -f ${shellQuote(plistPath)}
rm -rf ${shellQuote(installDirectory)}
echo DSH_FAN_UNINSTALLED
`
}

/**
 * Find other fan controllers currently running.
 *
 * @param {object} [options] - detection options.
 * @param {typeof runProcess} [options.run] - process runner.
 * @param {readonly string[]} [options.names] - process names to look for.
 * @returns {Promise<{ name: string, pid: number }[]>} detected controllers.
 */
export async function findOtherControllers({ run = runProcess, names = OTHER_CONTROLLER_NAMES } = {}) {
  /** @type {{ name: string, pid: number }[]} */
  const found = []
  for (const name of names) {
    try {
      const { stdout } = await run('/usr/bin/pgrep', ['-x', name], { timeoutMs: 2000 })
      for (const token of String(stdout).trim().split(/\s+/u)) {
        if (/^\d+$/u.test(token)) found.push({ name, pid: Number(token) })
      }
    } catch {
      // pgrep exits non-zero when nothing matches; that is the common case.
    }
  }
  return found
}

/**
 * Normalize a user preset name.
 *
 * @param {unknown} raw - candidate name.
 * @returns {string} trimmed name, or an empty string when unusable.
 */
export function normalizePresetName(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/gu, ' ').trim().slice(0, 40)
}

/**
 * @returns {string[]} the Swift sources the daemon is built from.
 */
export function fanDaemonSources() {
  return [
    fileURLToPath(new URL('../assets/smc-core.swift', import.meta.url)),
    fileURLToPath(new URL('../assets/fan-daemon.swift', import.meta.url)),
  ]
}

/**
 * Control the Mac's fans through the privileged helper.
 */
export class FanController {
  /**
   * @param {object} options - controller options.
   * @param {string} options.stateDirectory - plugin state directory (presets file lives here).
   * @param {() => import('./smc.js').SensorSample | null} options.sampleProvider - latest SMC sample.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {typeof ensureSwiftBinary} [options.compile] - Swift build entry (injectable).
   * @param {typeof runProcess} [options.run] - process runner (injectable for tests).
   * @param {typeof spawn} [options.spawnProcess] - unused placeholder for symmetry.
   * @param {string} [options.installDirectory] - install directory override.
   * @param {string} [options.installBinary] - installed binary override.
   * @param {string} [options.socketPath] - socket override.
   * @param {string} [options.plistPath] - plist override.
   * @param {string} [options.label] - launchd label override.
   * @param {number} [options.ownerUid] - uid the daemon should trust.
   * @param {() => number} [options.now] - clock.
   */
  constructor({
    stateDirectory,
    sampleProvider,
    warn = () => {},
    compile = ensureSwiftBinary,
    run = runProcess,
    spawnProcess = spawn,
    installDirectory = FAN_INSTALL_DIRECTORY,
    installBinary = FAN_INSTALL_BINARY,
    socketPath = FAN_SOCKET_PATH,
    plistPath = FAN_PLIST_PATH,
    label = FAN_DAEMON_LABEL,
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : 0,
    now = () => Date.now(),
  }) {
    this.stateDirectory = stateDirectory
    this.sampleProvider = sampleProvider
    this.warn = warn
    this.compile = compile
    this.run = run
    this.spawnProcess = spawnProcess
    this.installDirectory = installDirectory
    this.installBinary = installBinary
    this.socketPath = socketPath
    this.plistPath = plistPath
    this.label = label
    this.ownerUid = ownerUid
    this.now = now

    /** @type {'auto' | 'manual' | 'curve'} */
    this.mode = 'auto'
    /** @type {number | null} */
    this.manualRpm = null
    /** @type {{ sensor: string, points: { celsius: number, rpm: number }[] } | null} */
    this.curve = null
    /** Stabilizer for curve mode (EMA + hysteresis + slew rate). */
    this.curveGovernor = new CurveGovernor()
    /** @type {number | null} */
    this.appliedRpm = null
    /** @type {string | null} */
    this.lastAppliedAt = null
    /** @type {string | null} */
    this.reason = null
    /** @type {string | null} */
    this.message = null
    this.installing = false
    this.connected = false
    /** @type {import('node:net').Socket | null} */
    this.socket = null
    /** @type {{ resolve: Function, reject: Function, timer: NodeJS.Timeout }[]} */
    this.pending = []
    /** @type {Promise<boolean> | null} */
    this.connecting = null
    this.lastConnectAttempt = 0
    this.lastApplyAt = 0
    /** @type {{ name: string, pid: number }[]} */
    this.otherControllers = []
    this.otherControllersAt = 0
    /** @type {{ id: string, name: string, mode: string, rpm?: number, curve?: { sensor: string, points: { celsius: number, rpm: number }[] } }[]} */
    this.customPresets = []
    this.disposed = false
    this.presetsPath = stateDirectory === undefined ? null : join(stateDirectory, 'fan-presets.json')
    this.loadPresets()
  }

  /** Read the persisted custom presets (best effort). */
  loadPresets() {
    if (this.presetsPath === null) return
    try {
      const parsed = JSON.parse(readFileSync(this.presetsPath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.presets)) return
      this.customPresets = parsed.presets
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && normalizePresetName(entry.name) !== '')
        .slice(0, 12)
        .map((entry) => ({
          id: String(entry.id),
          name: normalizePresetName(entry.name),
          mode: entry.mode === 'curve' ? 'curve' : 'manual',
          ...(Number.isFinite(entry.rpm) ? { rpm: Math.round(Number(entry.rpm)) } : {}),
          ...(entry.curve !== null && typeof entry.curve === 'object'
            ? { curve: { sensor: String(entry.curve.sensor ?? 'cpuPerformance'), points: normalizeCurve(entry.curve.points) } }
            : {}),
        }))
    } catch {
      // A corrupt or missing preset file costs only the custom presets.
    }
  }

  /** Persist the custom presets (best effort). */
  savePresets() {
    if (this.presetsPath === null) return
    try {
      mkdirSync(dirname(this.presetsPath), { recursive: true, mode: 0o700 })
      const temporary = `${this.presetsPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, presets: this.customPresets }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.presetsPath)
    } catch (failure) {
      this.warn('could not persist the fan presets', failure)
    }
  }

  /** @returns {{ minimumRpm: number, maximumRpm: number }} the fan range from the latest sample (fallback included). */
  fanLimits() {
    const sample = this.sampleProvider()
    const fan = sample?.fans?.[0]
    const minimumRpm = Number.isFinite(fan?.minRpm) && fan.minRpm > 0 ? fan.minRpm : 1000
    const maximumRpm = Number.isFinite(fan?.maxRpm) && fan.maxRpm > minimumRpm ? fan.maxRpm : Math.max(minimumRpm, 4900)
    return { minimumRpm, maximumRpm }
  }

  /** @returns {{ celsius: number, rpm: number }[]} the active curve, or the default for the current fan range. */
  activeCurve() {
    if (this.curve !== null) return this.curve.points
    const limits = this.fanLimits()
    return defaultCurve(limits.minimumRpm, limits.maximumRpm)
  }

  /** @returns {string[]} curve sensor ids that currently have a reading. */
  sensorOptions() {
    const sample = this.sampleProvider()
    const groups = sample === null ? {} : (sample.groups ?? {})
    const available = CURVE_SENSORS.filter((sensor) => true)
    const withReading = available.filter((sensor) => Number.isFinite(this.groupValue(groups, sensor)))
    return withReading.length === 0 ? ['cpuPerformance'] : withReading
  }

  /**
   * Read one temperature group, tolerating a sample without precomputed groups.
   *
   * @param {Record<string, unknown>} groups - summary groups (may be empty).
   * @param {string} sensor - sensor id.
   * @returns {number | null} the temperature.
   */
  groupValue(groups, sensor) {
    const value = groups[sensor]
    if (Number.isFinite(value)) return Number(value)
    const sample = this.sampleProvider()
    const readings = sample?.temperatures ?? []
    const pattern = {
      cpuPerformance: /^Tp/u,
      cpuEfficiency: /^Te/u,
      gpu: /^Tg/u,
      ssd: /^TH/u,
      memory: /^Tm/u,
    }[sensor]
    if (pattern === undefined) return null
    let maximum = null
    for (const reading of readings) {
      if (!pattern.test(reading.key)) continue
      if (maximum === null || reading.celsius > maximum) maximum = reading.celsius
    }
    return maximum
  }

  /** @returns {boolean} whether the helper is installed (plist + binary on disk). */
  isInstalled() {
    try {
      return existsSync(this.plistPath) && existsSync(this.installBinary)
    } catch {
      return false
    }
  }

  /** @returns {{ minimum: number, maximum: number, range: number }} the slider range. */
  range() {
    const { minimumRpm, maximumRpm } = this.fanLimits()
    return { minimum: minimumRpm, maximum: maximumRpm, range: Math.max(0, maximumRpm - minimumRpm) }
  }

  /** @returns {object[]} built-in + custom presets. */
  presets() {
    const { minimumRpm, maximumRpm } = this.fanLimits()
    return [...builtinPresets(minimumRpm, maximumRpm), ...this.customPresets]
  }

  /**
   * The `fanControl` block of the monitor snapshot.
   *
   * @returns {object} status per the client contract.
   */
  status() {
    if (this.now() - this.otherControllersAt > 15_000) void this.refreshOtherControllers(true)
    const installed = this.isInstalled()
    const sample = this.sampleProvider()
    const fanCount = sample === null ? null : sample.fanCount
    const limits = this.range()
    let state
    let reason = this.reason
    let message = this.message
    if (process.platform !== 'darwin') {
      state = 'unavailable'
      reason = 'unsupported-platform'
    } else if (this.installing) {
      state = 'installing'
      reason = null
    } else if (!installed) {
      state = 'not-installed'
      reason = null
      message = null
    } else if (this.connected) {
      state = 'ready'
      reason = null
      message = null
    } else {
      state = 'error'
      reason = reason ?? 'daemon-unreachable'
    }
    if (state !== 'unavailable' && fanCount === 0) {
      state = 'unavailable'
      reason = 'no-fans'
    }
    return {
      state,
      reason,
      message,
      installed,
      running: this.connected,
      otherControllers: this.otherControllers,
      mode: this.mode,
      manualRpm: this.manualRpm === null ? Math.round(limits.minimum + limits.range * 0.4) : this.manualRpm,
      curve: { sensor: this.curve?.sensor ?? 'cpuPerformance', points: this.activeCurve() },
      sensorOptions: this.sensorOptions(),
      appliedRpm: this.appliedRpm,
      lastAppliedAt: this.lastAppliedAt,
      minRpm: limits.minimum,
      maxRpm: limits.maximum,
      presets: this.presets(),
    }
  }

  /**
   * Load presets, detect the installed helper and connect. Safe to call once.
   *
   * @returns {Promise<void>} resolves once initialization settled.
   */
  async start() {
    if (this.disposed) return
    if (this.isInstalled()) {
      await this.connectWithRetry(2000).catch(() => {})
    }
    await this.refreshOtherControllers()
  }

  /** Refresh the other-controller list when it is stale. */
  async refreshOtherControllers(force = false) {
    if (!force && this.now() - this.otherControllersAt < 15_000) return
    this.otherControllersAt = this.now()
    try {
      this.otherControllers = await findOtherControllers({ run: this.run })
    } catch {
      this.otherControllers = []
    }
  }

  /**
   * Compile and install the privileged helper (one administrator dialog).
   *
   * @returns {Promise<object>} the settled status block.
   * @throws {FanError} when the platform, toolchain or authorization fails.
   */
  async install() {
    if (process.platform !== 'darwin') {
      throw new FanError('unsupported-platform', 'fan control requires macOS')
    }
    if (this.installing) throw new FanError('fan_install_busy', 'a fan helper installation is already running')
    this.installing = true
    this.reason = null
    let scriptDirectory = null
    try {
      let binary
      try {
        binary = await this.compile({ sourcePaths: fanDaemonSources(), cacheName: 'fan-daemon' })
      } catch (failure) {
        throw new FanError('swift-missing', failure instanceof Error ? failure.message : String(failure))
      }
      scriptDirectory = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-fan-'))
      const scriptPath = join(scriptDirectory, 'install.sh')
      const script = buildInstallScript({
        sourceBinary: binary,
        installDirectory: this.installDirectory,
        installBinary: this.installBinary,
        socketPath: this.socketPath,
        plistPath: this.plistPath,
        label: this.label,
        ownerUid: this.ownerUid,
      })
      writeFileSync(scriptPath, script, { mode: 0o700 })
      const result = await this.runAdministratorScript(scriptPath)
      if (!String(result.stdout).includes('DSH_FAN_INSTALLED')) {
        throw new FanError('install-failed', 'the installer did not confirm the installation')
      }
      const connected = await this.connectWithRetry(8000)
      if (!connected) {
        throw new FanError('daemon-unreachable', 'the fan helper was installed but its socket did not answer')
      }
      this.reason = null
      this.message = null
      this.installing = false
      return this.status()
    } catch (failure) {
      const fanError = failure instanceof FanError ? failure : new FanError('install-failed', failure instanceof Error ? failure.message : String(failure))
      this.reason = fanError.code
      this.message = fanError.message
      throw fanError
    } finally {
      this.installing = false
      if (scriptDirectory !== null) {
        try {
          rmSync(scriptDirectory, { recursive: true, force: true })
        } catch {
          // A leftover temp script is harmless; the directory is user-private.
        }
      }
    }
  }

  /**
   * Run one bash script through the administrator dialog.
   *
   * @param {string} scriptPath - script to execute as root.
   * @returns {Promise<{ stdout: string, stderr: string }>} the process result.
   * @throws {FanError} with `cancelled` when the operator dismisses the dialog.
   */
  async runAdministratorScript(scriptPath) {
    const command = `/bin/bash ${shellQuote(scriptPath)}`
    try {
      return await this.run('/usr/bin/osascript', ['-e', buildAppleScript(command)], { timeoutMs: 180_000 })
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure)
      const cancelled = /cancel/iu.test(detail) || /-128/u.test(detail) || (failure !== null && typeof failure === 'object' && failure.code === 'timeout')
      if (cancelled) {
        throw new FanError('cancelled', 'the administrator authorization was cancelled')
      }
      throw new FanError('install-failed', `the installer failed: ${detail}`)
    }
  }

  /**
   * Restore automatic control, then remove the privileged helper.
   *
   * @returns {Promise<object>} the settled status block.
   * @throws {FanError} when the uninstall script fails or is cancelled.
   */
  async uninstall() {
    if (process.platform !== 'darwin') {
      throw new FanError('unsupported-platform', 'fan control requires macOS')
    }
    if (!this.isInstalled()) {
      this.closeSocket()
      return this.status()
    }
    this.mode = 'auto'
    this.appliedRpm = null
    if (this.connected) {
      await this.request({ op: 'autoAll' }, 2000).catch(() => {})
    }
    this.closeSocket()
    let scriptDirectory = null
    try {
      scriptDirectory = mkdtempSync(join(tmpdir(), 'dsh-mac-tools-fan-'))
      const scriptPath = join(scriptDirectory, 'uninstall.sh')
      writeFileSync(scriptPath, buildUninstallScript({
        installDirectory: this.installDirectory,
        plistPath: this.plistPath,
        label: this.label,
      }), { mode: 0o700 })
      const result = await this.runAdministratorScript(scriptPath)
      if (!String(result.stdout).includes('DSH_FAN_UNINSTALLED')) {
        throw new FanError('uninstall-failed', 'the uninstaller did not confirm the removal')
      }
      this.reason = null
      this.message = null
      return this.status()
    } catch (failure) {
      const fanError = failure instanceof FanError ? failure : new FanError('uninstall-failed', failure instanceof Error ? failure.message : String(failure))
      this.reason = fanError.code
      this.message = fanError.message
      throw fanError
    } finally {
      if (scriptDirectory !== null) {
        try {
          rmSync(scriptDirectory, { recursive: true, force: true })
        } catch {
          // Harmless leftover.
        }
      }
    }
  }

  /** Open the persistent socket connection and verify the daemon protocol. */
  connect() {
    if (this.disposed) return Promise.resolve(false)
    if (this.connected) return Promise.resolve(true)
    if (this.connecting !== null) return this.connecting
    this.lastConnectAttempt = this.now()
    this.connecting = new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath)
      socket.setEncoding('utf8')
      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        settle(false)
        socket.destroy()
      }, 5000)
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!value) {
          this.connected = false
          if (this.socket === socket) this.socket = null
          try {
            socket.destroy()
          } catch {
            // Already gone.
          }
        }
        resolve(value)
      }
      socket.on('connect', () => {
        this.socket = socket
        this.connected = true
        this.request({ op: 'ping' }, 3000).then((response) => {
          if (response === null || response.ok !== true || response.protocol !== FAN_PROTOCOL_VERSION) {
            this.closeSocket()
            this.reason = 'protocol-mismatch'
            settle(false)
            return
          }
          this.reason = null
          this.message = null
          settle(true)
        }).catch(() => {
          this.closeSocket()
          settle(false)
        })
      })
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        if (buffer.length > 1_000_000) buffer = buffer.slice(-500_000)
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf('\n')
          if (line === '') continue
          const pending = this.pending.shift()
          if (pending === undefined) continue
          clearTimeout(pending.timer)
          try {
            pending.resolve(JSON.parse(line))
          } catch {
            pending.resolve(null)
          }
        }
      })
      socket.on('error', () => {
        settle(false)
      })
      socket.on('close', () => {
        this.connected = false
        if (this.socket === socket) this.socket = null
        this.rejectPending('daemon-disconnected')
        if (!settled) settle(false)
      })
    }).finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /**
   * Connect, trying again briefly (launchd may still be starting the helper).
   *
   * @param {number} deadlineMs - how long to keep trying, in milliseconds.
   * @returns {Promise<boolean>} whether the socket answered.
   */
  async connectWithRetry(deadlineMs) {
    const deadline = this.now() + deadlineMs
    while (this.now() <= deadline) {
      if (await this.connect()) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (this.disposed) return false
    }
    return false
  }

  /** Send one command on the persistent connection. */
  request(command, timeoutMs = 5000) {
    if (!this.connected || this.socket === null) {
      return Promise.reject(new FanError('fan_not_ready', 'the fan helper is not connected'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending('fan-helper-timeout')
        reject(new FanError('fan_apply_failed', 'the fan helper did not answer'))
      }, timeoutMs)
      this.pending.push({ resolve, reject, timer })
      try {
        this.socket.write(`${JSON.stringify(command)}\n`)
      } catch (failure) {
        clearTimeout(timer)
        this.pending.pop()
        reject(new FanError('fan_apply_failed', failure instanceof Error ? failure.message : String(failure)))
      }
    })
  }

  /** Reject every in-flight command. */
  rejectPending(reason) {
    while (this.pending.length > 0) {
      const pending = this.pending.shift()
      clearTimeout(pending.timer)
      pending.reject(new FanError('fan_apply_failed', reason))
    }
  }

  /** Close the socket and reject in-flight commands. */
  closeSocket() {
    this.connected = false
    this.rejectPending('daemon-disconnected')
    if (this.socket !== null) {
      try {
        this.socket.destroy()
      } catch {
        // Already gone.
      }
      this.socket = null
    }
  }

  /**
   * Take control of the fans (or hand them back) and answer the new state.
   *
   * @param {{ mode: 'auto' } | { mode: 'manual', rpm: number } | { mode: 'curve', sensor?: string, points?: object[] }} spec - requested control mode.
   * @returns {Promise<object>} the settled status block.
   * @throws {FanError} when the helper is unavailable or the SMC refuses the write.
   */
  async apply(spec) {
    if (spec === null || typeof spec !== 'object') throw new FanError('fan_apply_failed', 'missing control specification')
    const mode = spec.mode
    if (mode !== 'auto' && mode !== 'manual' && mode !== 'curve') {
      throw new FanError('fan_apply_failed', `unknown fan mode ${JSON.stringify(mode)}`)
    }
    if (!this.isInstalled()) throw new FanError('fan_not_ready', 'the fan helper is not installed')
    if (!this.connected) await this.connectWithRetry(3000)
    if (!this.connected) throw new FanError('fan_not_ready', 'the fan helper is not reachable')

    const limits = this.range()
    if (mode === 'auto') {
      await this.request({ op: 'autoAll' }, 5000).catch(() => {})
      this.mode = 'auto'
      this.curveGovernor.reset()
      this.appliedRpm = null
      this.lastAppliedAt = new Date(this.now()).toISOString()
      return this.status()
    }
    if (mode === 'manual') {
      const requested = Number(spec.rpm)
      if (!Number.isFinite(requested)) throw new FanError('fan_apply_failed', 'invalid fan rpm')
      const rpm = Math.round(clamp(requested, limits.minimum, limits.maximum))
      const applied = await this.applyAll(rpm)
      this.mode = 'manual'
      this.curveGovernor.reset()
      this.manualRpm = rpm
      this.appliedRpm = applied
      this.lastAppliedAt = new Date(this.now()).toISOString()
      return this.status()
    }

    const points = normalizeCurve(spec.points)
    if (points.length < 2) throw new FanError('fan_apply_failed', 'a curve needs at least two points')
    const sensor = typeof spec.sensor === 'string' && CURVE_SENSORS.includes(spec.sensor) ? spec.sensor : 'cpuPerformance'
    const celsius = this.groupValue(this.sampleProvider()?.groups ?? {}, sensor)
    if (celsius === null) throw new FanError('fan_apply_failed', 'the curve sensor has no reading', { reason: 'sensor-unavailable' })
    const target = curveRpm(points, celsius)
    if (target === null) throw new FanError('fan_apply_failed', 'the curve produced no target')
    const applied = await this.applyAll(Math.round(clamp(target, limits.minimum, limits.maximum)))
    this.mode = 'curve'
    this.curve = { sensor, points }
    // Seed the stabilizer with the reading we just applied so the next tick
    // does not step again immediately.
    this.curveGovernor.reset()
    this.curveGovernor.update({
      celsius,
      points,
      limits: { minimum: limits.minimum, maximum: limits.maximum },
      now: this.now(),
    })
    this.appliedRpm = applied
    this.lastAppliedAt = new Date(this.now()).toISOString()
    return this.status()
  }

  /**
   * Push one RPM target to every fan.
   *
   * @param {number} rpm - target speed.
   * @returns {Promise<number | null>} the applied speed of the last fan.
   */
  async applyAll(rpm) {
    const sample = this.sampleProvider()
    const fanCount = Number.isInteger(sample?.fanCount) && sample.fanCount > 0 ? sample.fanCount : 1
    let applied = null
    for (let index = 0; index < fanCount; index += 1) {
      const response = await this.request({ op: 'set', fan: index, rpm }, 5000)
      if (response === null || response.ok !== true) {
        const reason = response !== null && typeof response.error === 'string' ? response.error : 'smc-write-failed'
        throw new FanError('fan_apply_failed', `the fan helper refused the write (${reason})`, { reason })
      }
      applied = Number.isFinite(response.rpm) ? Number(response.rpm) : rpm
    }
    return applied
  }

  /**
   * Periodic work from the monitor loop: re-apply a held target and repair the
   * connection. Never throws.
   *
   * @param {import('./smc.js').SensorSample | null} [sample] - unused; the provider is the source of truth.
   * @returns {void}
   */
  tick(sample) {
    void sample
    if (this.disposed) return
    void this.refreshOtherControllers()
    if (this.mode === 'auto') return
    const now = this.now()
    if (now - this.lastApplyAt < 1500) return
    this.lastApplyAt = now
    if (!this.connected) {
      if (this.isInstalled() && now - this.lastConnectAttempt > 5000) {
        void this.connect().catch(() => {})
      }
      return
    }
    const limits = this.range()
    let target = null
    if (this.mode === 'manual' && this.manualRpm !== null) {
      target = this.manualRpm
    } else if (this.mode === 'curve' && this.curve !== null) {
      const celsius = this.groupValue(this.sampleProvider()?.groups ?? {}, this.curve.sensor)
      const outcome = this.curveGovernor.update({
        celsius,
        points: this.curve.points,
        limits: { minimum: limits.minimum, maximum: limits.maximum },
        now,
      })
      if (outcome !== null) target = outcome.target
    }
    if (target === null) return
    const rpm = Math.round(clamp(target, limits.minimum, limits.maximum))
    void this.applyAll(rpm).then((applied) => {
      this.appliedRpm = applied
      this.lastAppliedAt = new Date(this.now()).toISOString()
      this.reason = null
    }).catch((failure) => {
      if (failure instanceof FanError && failure.message.includes('not connected')) {
        this.connected = false
        this.reason = 'daemon-unreachable'
      }
    })
  }

  /**
   * Save one custom preset.
   *
   * @param {{ name: unknown, mode: unknown, rpm?: unknown, sensor?: unknown, points?: unknown }} patch - preset fields.
   * @returns {{ presets: object[] }} the full preset list.
   * @throws {FanError} when the name or settings are invalid.
   */
  savePreset(patch) {
    const name = normalizePresetName(patch.name)
    if (name === '') throw new FanError('preset_invalid', 'a preset needs a name')
    if (this.customPresets.some((preset) => preset.name === name)) {
      throw new FanError('preset_duplicate', 'a preset with this name already exists')
    }
    if (this.customPresets.length >= 12) throw new FanError('preset_limit', 'at most 12 custom presets are kept')
    const mode = patch.mode === 'curve' ? 'curve' : 'manual'
    /** @type {{ id: string, name: string, mode: string, rpm?: number, curve?: object }} */
    const preset = { id: `p-${randomBytes(4).toString('hex')}`, name, mode }
    if (mode === 'manual') {
      const rpm = Number(patch.rpm)
      if (!Number.isFinite(rpm)) throw new FanError('preset_invalid', 'a manual preset needs an rpm')
      preset.rpm = Math.round(rpm)
    } else {
      const points = normalizeCurve(patch.points)
      if (points.length < 2) throw new FanError('preset_invalid', 'a curve preset needs at least two points')
      preset.curve = {
        sensor: typeof patch.sensor === 'string' && CURVE_SENSORS.includes(patch.sensor) ? patch.sensor : 'cpuPerformance',
        points,
      }
    }
    this.customPresets.push(preset)
    this.savePresets()
    return { presets: this.presets() }
  }

  /**
   * Delete one custom preset.
   *
   * @param {string} id - preset id.
   * @returns {{ presets: object[] }} the full preset list.
   * @throws {FanError} when the preset does not exist or is built in.
   */
  deletePreset(id) {
    const index = this.customPresets.findIndex((preset) => preset.id === id)
    if (index < 0) throw new FanError('preset_not_found', 'unknown custom preset')
    this.customPresets.splice(index, 1)
    this.savePresets()
    return { presets: this.presets() }
  }

  /** Restore automatic control (best effort), close the socket and stop timers. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.connected) {
      try {
        this.socket?.write(`${JSON.stringify({ op: 'autoAll' })}\n`)
      } catch {
        // Best effort; the daemon also restores on disconnect.
      }
    }
    this.mode = 'auto'
    this.appliedRpm = null
    this.closeSocket()
  }
}
