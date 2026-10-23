/**
 * Software metrics for the monitor tab.
 *
 * The module has two halves. The pure parsers below turn recorded macOS
 * command output (`vm_stat`, `netstat`, `df`, `pmset`, …) into the exact
 * shapes of the monitor contract, and {@link collectSoftwareMetrics} wires
 * them to the real utilities on the one-second sampling tick.
 *
 * Every source degrades on its own: a desktop has no battery, a restricted
 * environment may refuse `df`, a sysctl may be missing — none of those may
 * take the sample down. Static facts (model, chip, volume name) are cached
 * for a few minutes so the tick only runs the cheap commands; everything
 * that changes is re-read every time.
 *
 * `run` is injectable everywhere it matters, so tests can replay fixtures
 * without root, network or special hardware.
 *
 * @module dsh-mac-tools/metrics
 */

import os from 'node:os'

import { runProcess } from './capture.js'

/** APFS data volume; its free space is what the panel reports. */
const DATA_VOLUME = '/System/Volumes/Data'

/** Deadline for one metric command. */
const COMMAND_TIMEOUT_MS = 5_000

/** How long the static host/disk facts are reused before they are probed again. */
const STATIC_CACHE_TTL_MS = 300_000

/** Absolute macOS binaries; the plugin only runs on macOS. */
const VM_STAT = '/usr/bin/vm_stat'
const SYSCTL = '/usr/sbin/sysctl'
const NETSTAT = '/usr/sbin/netstat'
const DF = '/bin/df'
const PMSET = '/usr/bin/pmset'
const DISKUTIL = '/usr/sbin/diskutil'
const SW_VERS = '/usr/bin/sw_vers'

/** Fallback display name when `diskutil` cannot name the boot volume. */
const FALLBACK_VOLUME_NAME = 'Macintosh HD'

/** Kernel memory-pressure levels (`kern.memorystatus_vm_pressure_level`). */
const PRESSURE_LEVELS = new Map([
  [1, 'normal'],
  [2, 'warning'],
  [4, 'critical'],
])

/** Marketing names for the Apple Silicon identifiers we can name confidently. */
const MODEL_NAMES = new Map([
  ['Mac14,3', 'Mac mini'],
  ['Mac14,12', 'Mac mini'],
  ['Mac16,10', 'Mac mini'],
  ['Mac16,11', 'Mac mini'],
  ['MacBookAir10,1', 'MacBook Air'],
  ['Mac14,2', 'MacBook Air'],
  ['Mac14,15', 'MacBook Air'],
  ['Mac15,12', 'MacBook Air'],
  ['Mac15,13', 'MacBook Air'],
  ['Mac16,12', 'MacBook Air'],
  ['Mac16,13', 'MacBook Air'],
  ['MacBookPro18,1', 'MacBook Pro'],
  ['MacBookPro18,2', 'MacBook Pro'],
  ['MacBookPro18,3', 'MacBook Pro'],
  ['MacBookPro18,4', 'MacBook Pro'],
  ['Mac14,5', 'MacBook Pro'],
  ['Mac14,6', 'MacBook Pro'],
  ['Mac14,7', 'MacBook Pro'],
  ['Mac14,9', 'MacBook Pro'],
  ['Mac14,10', 'MacBook Pro'],
  ['Mac15,3', 'MacBook Pro'],
  ['Mac15,6', 'MacBook Pro'],
  ['Mac15,7', 'MacBook Pro'],
  ['Mac15,8', 'MacBook Pro'],
  ['Mac15,9', 'MacBook Pro'],
  ['Mac15,10', 'MacBook Pro'],
  ['Mac15,11', 'MacBook Pro'],
  ['Mac16,5', 'MacBook Pro'],
  ['Mac16,6', 'MacBook Pro'],
  ['Mac16,7', 'MacBook Pro'],
  ['Mac16,8', 'MacBook Pro'],
  ['Mac13,1', 'Mac Studio'],
  ['Mac13,2', 'Mac Studio'],
  ['Mac14,13', 'Mac Studio'],
  ['Mac14,14', 'Mac Studio'],
  ['Mac13,3', 'Mac Pro'],
  ['Mac14,8', 'Mac Pro'],
  ['iMac21,1', 'iMac'],
  ['iMac21,2', 'iMac'],
  ['Mac15,4', 'iMac'],
  ['Mac15,5', 'iMac'],
])

/** Host/disk facts that do not change between ticks, cached across samples. */
let staticFactsCache = null
/** When {@link staticFactsCache} was filled, in epoch milliseconds. */
let staticFactsCachedAt = 0
/** Raw `os.cpus()` snapshot taken at the start of the previous collection. */
let lastCpuSnapshot = null

/**
 * Forget the cached static facts and CPU snapshot.
 *
 * Only used by tests (so injected command output is not masked by a cache
 * filled by an earlier test); production code never needs it.
 *
 * @returns {void}
 */
export function resetMetricsCache() {
  staticFactsCache = null
  staticFactsCachedAt = 0
  lastCpuSnapshot = null
}

/**
 * @param {number} value - raw number.
 * @returns {number} the number rounded to one decimal.
 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * Read one command through the injected runner, returning an empty string on
 * any failure so a broken source only leaves its field at the fallback.
 *
 * @param {(command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>} run - command runner.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {number} [timeoutMs] - deadline.
 * @returns {Promise<string>} stdout, or an empty string.
 */
async function readCommand(run, command, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  try {
    const { stdout } = await run(command, args, { timeoutMs })
    return typeof stdout === 'string' ? stdout : ''
  } catch {
    return ''
  }
}

/**
 * Compute CPU utilisation percentages from two `os.cpus()` snapshots.
 *
 * `os.cpus()` returns cumulative tick counters, so the percentages describe
 * the interval between the two snapshots. `user` includes nice time and
 * `system` includes IRQ time, which is how Activity Monitor groups them.
 *
 * @param {import('node:os').CpuInfo[] | null | undefined} previous - earlier snapshot.
 * @param {import('node:os').CpuInfo[] | null | undefined} current - later snapshot.
 * @returns {{ usagePercent: number, userPercent: number, systemPercent: number, idlePercent: number, perCorePercent: number[] } | null} percentages (0…100, one decimal), or null when the snapshots cannot be compared.
 */
export function computeCpuPercentages(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || current.length === 0 || previous.length !== current.length) return null
  /** @param {number | undefined} before - earlier counter. @param {number | undefined} after - later counter. @returns {number} non-negative delta. */
  const delta = (before, after) => {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return 0
    return after > before ? after - before : 0
  }
  let userTicks = 0
  let systemTicks = 0
  let idleTicks = 0
  const perCorePercent = []
  for (let index = 0; index < current.length; index += 1) {
    const before = previous[index]?.times
    const after = current[index]?.times
    if (before === undefined || after === undefined) return null
    const user = delta(before.user, after.user) + delta(before.nice, after.nice)
    const system = delta(before.sys, after.sys) + delta(before.irq, after.irq)
    const idle = delta(before.idle, after.idle)
    const total = user + system + idle
    if (total <= 0) {
      perCorePercent.push(0)
      continue
    }
    userTicks += user
    systemTicks += system
    idleTicks += idle
    perCorePercent.push(round1(((total - idle) / total) * 100))
  }
  const totalTicks = userTicks + systemTicks + idleTicks
  if (totalTicks <= 0) return null
  const idlePercent = round1((idleTicks / totalTicks) * 100)
  return {
    usagePercent: round1(((totalTicks - idleTicks) / totalTicks) * 100),
    userPercent: round1((userTicks / totalTicks) * 100),
    systemPercent: round1((systemTicks / totalTicks) * 100),
    idlePercent,
    perCorePercent,
  }
}

/**
 * Parse `vm_stat` into the Activity-Monitor-style memory figures of the
 * monitor contract. `availableBytes` is free + inactive + speculative +
 * purgeable pages (the memory a person expects to see as usable); `usedBytes`
 * is the rest. `cachedBytes` is the inactive + speculative file cache and
 * `appBytes` is whatever used memory is left after wired and compressed pages.
 *
 * @param {string} text - `vm_stat` output.
 * @param {number} totalBytes - physical memory in bytes.
 * @returns {{ totalBytes: number, usedBytes: number, availableBytes: number, usedPercent: number, appBytes: number, wiredBytes: number, compressedBytes: number, cachedBytes: number, swapUsedBytes: number } | null} memory facts (without `pressure`), or null when the output is unusable.
 */
export function parseVmStat(text, totalBytes) {
  const source = String(text ?? '')
  const total = Number(totalBytes)
  if (!Number.isFinite(total) || total <= 0) return null
  const pageSizeMatch = /page size of (\d+) bytes/iu.exec(source)
  const freeMatch = /Pages free:\s+(\d+)/u.exec(source)
  if (pageSizeMatch === null || freeMatch === null) return null
  const pageSize = Number(pageSizeMatch[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  /**
   * @param {RegExp} pattern - page-count pattern.
   * @returns {number} the page count, or 0 when the counter is absent.
   */
  const pages = (pattern) => {
    const match = pattern.exec(source)
    return match === null ? 0 : Number(match[1])
  }
  const freeBytes = Number(freeMatch[1]) * pageSize
  const inactiveBytes = pages(/Pages inactive:\s+(\d+)/u) * pageSize
  const speculativeBytes = pages(/Pages speculative:\s+(\d+)/u) * pageSize
  const purgeableBytes = pages(/Pages purgeable:\s+(\d+)/u) * pageSize
  const wiredBytes = pages(/Pages wired down:\s+(\d+)/u) * pageSize
  const compressedBytes = pages(/Pages occupied by compressor:\s+(\d+)/u) * pageSize
  const availableBytes = Math.min(total, freeBytes + inactiveBytes + speculativeBytes + purgeableBytes)
  const usedBytes = Math.max(0, total - availableBytes)
  const cachedBytes = Math.min(availableBytes, inactiveBytes + speculativeBytes)
  const appBytes = Math.max(0, usedBytes - wiredBytes - compressedBytes)
  return {
    totalBytes: total,
    usedBytes,
    availableBytes,
    usedPercent: round1((usedBytes / total) * 100),
    appBytes,
    wiredBytes,
    compressedBytes,
    cachedBytes,
    swapUsedBytes: 0,
  }
}

/**
 * Parse the `used =` figure out of `sysctl vm.swapusage`.
 *
 * @param {string} text - `sysctl -n vm.swapusage` output (the command prefix is optional).
 * @param {number} [totalBytes] - accepted for the contract signature; swap can exceed physical memory, so it is not used as a clamp.
 * @returns {number} used swap in bytes, or 0 when the output is unusable.
 */
export function parseSwapUsage(text, totalBytes = 0) {
  void totalBytes
  const match = /used\s*=\s*([\d.]+)\s*([KMGTP]?)B?/iu.exec(String(text ?? ''))
  if (match === null) return 0
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const unit = (match[2] ?? '').toUpperCase()
  const multipliers = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
  return Math.round(amount * (multipliers[unit] ?? 1))
}

/**
 * Parse `netstat -ibn` into per-interface byte totals.
 *
 * The output has one header line followed by rows whose column count varies
 * (link-level rows may omit the address), so the numeric counters are read
 * from the right end: the last seven fields are always
 * numbers, and the byte counters are the 5th and 2nd from the end. An
 * interface that appears on several address rows keeps the largest counters.
 *
 * @param {string} text - `netstat -ibn` output.
 * @returns {{ interface: string, receivedBytes: number, sentBytes: number }[]} one entry per interface, in output order.
 */
export function parseNetstat(text) {
  const order = []
  const totals = new Map()
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(/\s+/u)
    if (fields.length < 10) continue
    const name = fields[0].endsWith('*') ? fields[0].slice(0, -1) : fields[0]
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) continue
    const mtu = Number(fields[1])
    if (!Number.isFinite(mtu)) continue
    const receivedBytes = Number(fields[fields.length - 5])
    const sentBytes = Number(fields[fields.length - 2])
    if (!Number.isFinite(receivedBytes) || !Number.isFinite(sentBytes) || receivedBytes < 0 || sentBytes < 0) continue
    const existing = totals.get(name)
    if (existing === undefined) {
      order.push(name)
      totals.set(name, { interface: name, receivedBytes, sentBytes })
    } else {
      existing.receivedBytes = Math.max(existing.receivedBytes, receivedBytes)
      existing.sentBytes = Math.max(existing.sentBytes, sentBytes)
    }
  }
  return order.map((name) => totals.get(name))
}

/**
 * Parse the last line of `df -kP <mount>` (POSIX blocks of 1024 bytes).
 *
 * @param {string} text - `df -kP` output.
 * @returns {{ totalBytes: number, usedBytes: number, freeBytes: number } | null} disk facts, or null when the output is unusable.
 */
export function parseDf(text) {
  const lines = String(text ?? '').split(/\r?\n/u).filter((line) => line.trim() !== '')
  if (lines.length < 2) return null
  const fields = lines[lines.length - 1].trim().split(/\s+/u)
  if (fields.length < 4) return null
  const blocks = Number(fields[1])
  const used = Number(fields[2])
  const available = Number(fields[3])
  if (![blocks, used, available].every((value) => Number.isFinite(value)) || blocks < 0 || used < 0 || available < 0) return null
  return {
    totalBytes: Math.round(blocks * 1024),
    usedBytes: Math.round(used * 1024),
    freeBytes: Math.round(available * 1024),
  }
}

/**
 * Parse the battery block out of `pmset -g batt`.
 *
 * A desktop prints only the power-source line, which correctly yields null.
 * `pmset` does not expose battery health or cycle count, so those two fields
 * are always null here (the contract shape keeps them for a future source).
 *
 * @param {string} text - `pmset -g batt` output.
 * @returns {{ percent: number, charging: boolean, pluggedIn: boolean, timeRemainingMinutes: number | null, healthPercent: number | null, cycleCount: number | null } | null} battery facts, or null when there is no battery.
 */
export function parseBattery(text) {
  const source = String(text ?? '')
  const percentMatch = /(\d{1,3})%/u.exec(source)
  if (percentMatch === null) return null
  const percent = Number(percentMatch[1])
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
  // The state is the field between the first two semicolons of the battery line:
  // "87%; discharging; 2:10 remaining" / "100%; charged; 0:00 remaining".
  const statusMatch = /;\s*([^;]+?)\s*;/u.exec(source)
  const status = statusMatch === null ? '' : statusMatch[1].toLowerCase()
  const charging = /^(?:charging|finishing charge|charged)$/u.test(status)
  const pluggedIn = charging || /AC Power|AC attached/iu.test(source)
  const remainingMatch = /(\d+):(\d{2})\s+remaining/u.exec(source)
  const timeRemainingMinutes = remainingMatch === null
    ? null
    : Number(remainingMatch[1]) * 60 + Number(remainingMatch[2])
  return {
    percent,
    charging,
    pluggedIn,
    timeRemainingMinutes: Number.isFinite(timeRemainingMinutes) ? timeRemainingMinutes : null,
    healthPercent: null,
    cycleCount: null,
  }
}

/**
 * Build the monitor contract's host block from `os.*` plus the static sysctl
 * facts. Pure: the sysctl values are passed in (they never change between
 * ticks), so this is tested without running anything.
 *
 * @param {{ modelIdentifier?: string, cpuModel?: string, osVersion?: string, performanceCores?: number | null, efficiencyCores?: number | null }} [facts] - static sysctl facts; all optional.
 * @returns {object} the host shape of the snapshot.
 */
export function parseHostFacts(facts = {}) {
  const cpus = os.cpus()
  const normalize = (value) => (typeof value === 'string' ? value.trim() : '')
  const modelIdentifier = normalize(facts.modelIdentifier)
  const cpuModel = normalize(facts.cpuModel) || normalize(cpus[0]?.model) || 'unknown'
  const osVersion = normalize(facts.osVersion) || os.release()
  const coreCount = (value) => (Number.isInteger(value) && value > 0 ? value : null)
  return {
    hostname: os.hostname(),
    modelName: modelNameFor(modelIdentifier),
    modelIdentifier: modelIdentifier === '' ? 'unknown' : modelIdentifier,
    cpuModel,
    arch: os.arch(),
    osName: process.platform === 'darwin' ? 'macOS' : os.type(),
    osVersion,
    cpuCores: cpus.length,
    performanceCores: coreCount(facts.performanceCores),
    efficiencyCores: coreCount(facts.efficiencyCores),
    uptimeSeconds: Math.round(os.uptime()),
  }
}

/**
 * @param {string} modelIdentifier - `hw.model` value such as `Mac16,10`.
 * @returns {string} a marketing name when known, else a family guess.
 */
function modelNameFor(modelIdentifier) {
  if (modelIdentifier === '') return 'Mac'
  const exact = MODEL_NAMES.get(modelIdentifier)
  if (exact !== undefined) return exact
  if (modelIdentifier.startsWith('MacBookPro')) return 'MacBook Pro'
  if (modelIdentifier.startsWith('MacBookAir')) return 'MacBook Air'
  if (modelIdentifier.startsWith('MacBook')) return 'MacBook'
  if (modelIdentifier.startsWith('Macmini')) return 'Mac mini'
  if (modelIdentifier.startsWith('MacPro')) return 'Mac Pro'
  if (modelIdentifier.startsWith('MacStudio')) return 'Mac Studio'
  if (modelIdentifier.startsWith('iMac')) return 'iMac'
  return 'Mac'
}

/**
 * Collect the cached static host/disk facts (memory size, chip, model, OS
 * version, core split, boot-volume display name).
 *
 * @param {(command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>} run - command runner.
 * @returns {Promise<{ totalBytes: number, cpuModel: string, modelIdentifier: string, osVersion: string, performanceCores: number | null, efficiencyCores: number | null, diskName: string }>} the static facts.
 */
async function readStaticFacts(run) {
  const now = Date.now()
  if (staticFactsCache !== null && now - staticFactsCachedAt < STATIC_CACHE_TTL_MS) return staticFactsCache
  const [memoryText, cpuModelText, modelText, osVersionText, performanceText, efficiencyText, rootPlist, dataPlist] = await Promise.all([
    readCommand(run, SYSCTL, ['-n', 'hw.memsize']),
    readCommand(run, SYSCTL, ['-n', 'machdep.cpu.brand_string']),
    readCommand(run, SYSCTL, ['-n', 'hw.model']),
    readCommand(run, SW_VERS, ['-productVersion']),
    readCommand(run, SYSCTL, ['-n', 'hw.perflevel0.logicalcpu']),
    readCommand(run, SYSCTL, ['-n', 'hw.perflevel1.logicalcpu']),
    readCommand(run, DISKUTIL, ['info', '-plist', '/']),
    readCommand(run, DISKUTIL, ['info', '-plist', DATA_VOLUME]),
  ])
  const totalBytes = Number.parseInt(memoryText.trim(), 10)
  const facts = {
    totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : os.totalmem(),
    cpuModel: cpuModelText.trim(),
    modelIdentifier: modelText.trim(),
    osVersion: osVersionText.trim(),
    performanceCores: parseCoreCount(performanceText),
    efficiencyCores: parseCoreCount(efficiencyText),
    // The boot volume carries the user-facing name ("Macintosh HD"); the APFS
    // data volume is named "Data" and is only a fallback.
    diskName: volumeNameFromPlist(rootPlist) || volumeNameFromPlist(dataPlist) || FALLBACK_VOLUME_NAME,
  }
  // When every static probe failed (e.g. the very first tick raced an exiting
  // shell), leave the cache empty so the next tick retries instead of serving
  // the fallbacks for five minutes.
  if (memoryText.trim() !== '' || cpuModelText.trim() !== '' || modelText.trim() !== '') {
    staticFactsCache = facts
    staticFactsCachedAt = now
  }
  return facts
}

/**
 * @param {string} text - `diskutil info -plist` output.
 * @returns {string} the volume name, or an empty string when it is absent.
 */
function volumeNameFromPlist(text) {
  const match = /<key>VolumeName<\/key>\s*<string>([^<]*)<\/string>/u.exec(String(text ?? ''))
  if (match === null) return ''
  return match[1].replace(/&amp;/gu, '&').trim()
}

/**
 * @param {string} text - sysctl core-count output.
 * @returns {number | null} the count, or null when unknown.
 */
function parseCoreCount(text) {
  const value = Number.parseInt(String(text ?? '').trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * @param {string} text - `kern.memorystatus_vm_pressure_level` output.
 * @returns {'normal' | 'warning' | 'critical' | null} the mapped pressure level.
 */
function parseMemoryPressure(text) {
  const value = Number.parseInt(String(text ?? '').trim(), 10)
  if (!Number.isFinite(value)) return null
  return PRESSURE_LEVELS.get(value) ?? null
}

/**
 * @param {number} coreCount - number of logical cores.
 * @returns {{ usagePercent: number, userPercent: number, systemPercent: number, idlePercent: number, perCorePercent: number[] }} an all-idle CPU block.
 */
function emptyCpuPercentages(coreCount) {
  const count = Number.isInteger(coreCount) && coreCount > 0 ? coreCount : 0
  return {
    usagePercent: 0,
    userPercent: 0,
    systemPercent: 0,
    idlePercent: 100,
    perCorePercent: new Array(count).fill(0),
  }
}

/**
 * Pick the primary network interface: `en0` when it carries a real IPv4
 * address, else the first address-bearing interface seen by `netstat`, and
 * finally `en0` / the first `netstat` row as a last resort.
 *
 * @param {{ interface: string, receivedBytes: number, sentBytes: number }[]} rows - parsed `netstat` totals.
 * @returns {{ interface: string | null, localIp: string | null }} the chosen interface and its IPv4 address.
 */
function choosePrimaryInterface(rows) {
  const addresses = new Map()
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (!addresses.has(name)) addresses.set(name, entry.address)
    }
  }
  const rowNames = new Set(rows.map((row) => row.interface))
  const addressed = [...addresses.keys()].filter((name) => rowNames.has(name))
  const preferred = addressed.includes('en0') ? 'en0' : addressed[0]
  if (preferred !== undefined) return { interface: preferred, localIp: addresses.get(preferred) ?? null }
  if (rowNames.has('en0')) return { interface: 'en0', localIp: addresses.get('en0') ?? null }
  const first = rows[0]
  if (first !== undefined) return { interface: first.interface, localIp: addresses.get(first.interface) ?? null }
  const fallback = addresses.has('en0') ? 'en0' : [...addresses.keys()][0]
  return {
    interface: fallback ?? null,
    localIp: fallback === undefined ? null : addresses.get(fallback) ?? null,
  }
}

/**
 * Read the totals and timestamp of the previous network sample. Accepts a
 * whole previous snapshot or a bare network block.
 *
 * @param {object | null} previous - previous sample.
 * @returns {{ receivedTotalBytes: number, sentTotalBytes: number, atMs: number } | null} the baseline, or null when it cannot support a rate.
 */
function readPreviousNetwork(previous) {
  if (previous === null || typeof previous !== 'object') return null
  const network = previous.network !== null && typeof previous.network === 'object' ? previous.network : previous
  const receivedTotalBytes = Number(network.receivedTotalBytes)
  const sentTotalBytes = Number(network.sentTotalBytes)
  if (!Number.isFinite(receivedTotalBytes) || !Number.isFinite(sentTotalBytes)) return null
  const atText = typeof previous.at === 'string' ? previous.at : typeof network.at === 'string' ? network.at : ''
  const atMs = Date.parse(atText)
  if (!Number.isFinite(atMs)) return null
  return { receivedTotalBytes, sentTotalBytes, atMs }
}

/**
 * Assemble the network block, including rates derived from the previous
 * sample's totals. The first sample (no usable baseline) reports 0 rates.
 *
 * @param {{ interface: string, receivedBytes: number, sentBytes: number }[]} rows - parsed `netstat` totals.
 * @param {object | null} previous - previous sample.
 * @param {number} sampledAtMs - this sample's epoch milliseconds.
 * @returns {object} the network shape of the snapshot.
 */
function buildNetwork(rows, previous, sampledAtMs) {
  const primary = choosePrimaryInterface(rows)
  const totals = primary.interface === null
    ? { receivedBytes: 0, sentBytes: 0 }
    : rows.find((row) => row.interface === primary.interface) ?? { receivedBytes: 0, sentBytes: 0 }
  let receivedBytesPerSecond = 0
  let sentBytesPerSecond = 0
  const baseline = readPreviousNetwork(previous)
  if (baseline !== null) {
    const elapsedMs = sampledAtMs - baseline.atMs
    if (elapsedMs > 0) {
      receivedBytesPerSecond = Math.max(0, Math.round(((totals.receivedBytes - baseline.receivedTotalBytes) * 1000) / elapsedMs))
      sentBytesPerSecond = Math.max(0, Math.round(((totals.sentBytes - baseline.sentTotalBytes) * 1000) / elapsedMs))
    }
  }
  return {
    interface: primary.interface,
    localIp: primary.localIp,
    receivedBytesPerSecond,
    sentBytesPerSecond,
    receivedTotalBytes: Math.round(totals.receivedBytes),
    sentTotalBytes: Math.round(totals.sentBytes),
  }
}

/**
 * Assemble the memory block, falling back to `os` figures when `vm_stat` is
 * unforthcoming.
 *
 * @param {object | null} parsed - output of {@link parseVmStat}, when usable.
 * @param {number} totalBytes - physical memory.
 * @param {number} swapUsedBytes - used swap.
 * @param {'normal' | 'warning' | 'critical' | null} pressure - memory pressure.
 * @returns {object} the memory shape of the snapshot.
 */
function buildMemory(parsed, totalBytes, swapUsedBytes, pressure) {
  if (parsed !== null) return { ...parsed, swapUsedBytes, pressure }
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : os.totalmem()
  const availableBytes = Math.min(total, os.freemem())
  const usedBytes = Math.max(0, total - availableBytes)
  return {
    totalBytes: total,
    usedBytes,
    availableBytes,
    usedPercent: total > 0 ? round1((usedBytes / total) * 100) : 0,
    appBytes: 0,
    wiredBytes: 0,
    compressedBytes: 0,
    cachedBytes: 0,
    swapUsedBytes,
    pressure,
  }
}

/**
 * Last-resort sample used only if something unexpected throws: still a valid
 * contract shape, built from `os` alone.
 *
 * @param {number} sampledAtMs - this sample's epoch milliseconds.
 * @returns {object} the degraded sample.
 */
function degradedSample(sampledAtMs) {
  const totalBytes = os.totalmem()
  return {
    at: new Date(sampledAtMs).toISOString(),
    host: parseHostFacts({}),
    cpu: {
      ...emptyCpuPercentages(os.cpus().length),
      loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
      temperatureCelsius: null,
    },
    memory: buildMemory(null, totalBytes, 0, null),
    disk: {
      name: FALLBACK_VOLUME_NAME,
      mount: DATA_VOLUME,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
    },
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
 * Collect one software-metrics sample for the monitor tick.
 *
 * Runs the cheap commands concurrently, caches the static ones, merges the
 * parsers and degrades per field: a failed `df`, a missing battery or an
 * unreadable sysctl only blanks its own field, and the function resolves with
 * a valid sample even if every command fails.
 *
 * @param {object} [options] - collection options.
 * @param {object | null} [options.previous] - previous sample, used for the CPU delta window and the network rate.
 * @param {(command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>} [options.run] - command runner, `runProcess` by default.
 * @returns {Promise<{ at: string, host: object, cpu: object, memory: object, disk: object, network: object, battery: object | null }>} the software metrics of the snapshot (no sensors/fans).
 */
export async function collectSoftwareMetrics({ previous = null, run = runProcess } = {}) {
  const sampledAtMs = Date.now()
  const at = new Date(sampledAtMs).toISOString()
  const runner = typeof run === 'function' ? run : runProcess
  try {
    const cpusBefore = os.cpus()
    let percentages = computeCpuPercentages(lastCpuSnapshot, cpusBefore)
    const [staticFacts, vmStatText, swapText, netstatText, dataDfText, batteryText, pressureText] = await Promise.all([
      readStaticFacts(runner),
      readCommand(runner, VM_STAT, []),
      readCommand(runner, SYSCTL, ['-n', 'vm.swapusage']),
      readCommand(runner, NETSTAT, ['-ibn']),
      readCommand(runner, DF, ['-kP', DATA_VOLUME]),
      readCommand(runner, PMSET, ['-g', 'batt']),
      readCommand(runner, SYSCTL, ['-n', 'kern.memorystatus_vm_pressure_level']),
    ])
    if (percentages === null) {
      // First call (or a reset): measure over the command window so even the
      // very first snapshot carries a real figure.
      const cpusAfter = os.cpus()
      percentages = computeCpuPercentages(cpusBefore, cpusAfter)
      lastCpuSnapshot = cpusAfter
    } else {
      lastCpuSnapshot = cpusBefore
    }
    const cpu = {
      ...(percentages ?? emptyCpuPercentages(cpusBefore.length)),
      loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
      temperatureCelsius: null,
    }
    const memory = buildMemory(
      parseVmStat(vmStatText, staticFacts.totalBytes),
      staticFacts.totalBytes,
      parseSwapUsage(swapText, staticFacts.totalBytes),
      parseMemoryPressure(pressureText),
    )
    let mount = DATA_VOLUME
    let diskFacts = parseDf(dataDfText)
    if (diskFacts === null) {
      mount = '/'
      diskFacts = parseDf(await readCommand(runner, DF, ['-kP', mount]))
    }
    const disk = diskFacts === null
      ? { name: staticFacts.diskName, mount, totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0 }
      : {
        name: staticFacts.diskName,
        mount,
        ...diskFacts,
        usedPercent: diskFacts.totalBytes > 0 ? round1((diskFacts.usedBytes / diskFacts.totalBytes) * 100) : 0,
      }
    return {
      at,
      host: parseHostFacts(staticFacts),
      cpu,
      memory,
      disk,
      network: buildNetwork(parseNetstat(netstatText), previous, sampledAtMs),
      battery: parseBattery(batteryText),
    }
  } catch {
    return degradedSample(sampledAtMs)
  }
}
