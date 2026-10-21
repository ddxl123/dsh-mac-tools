/**
 * Local system information for the panel's system tab and the
 * `mac_system_info` tool.
 *
 * Every field degrades independently: a Mac mini has no battery, a restricted
 * environment may refuse `df`, and neither should take the whole answer down.
 * The Node `os` module covers the cheap facts; the shell commands cover the
 * macOS facts it does not expose.
 *
 * @module dsh-mac-tools/system
 */

import os from 'node:os'
import { runProcess } from './capture.js'

/** Fields included in every answer. */
export const SYSTEM_INFO_FIELDS = Object.freeze([
  'os',
  'uptimeSeconds',
  'cpu',
  'memory',
  'disk',
  'battery',
  'capturedAt',
])

/**
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - deadline.
 * @returns {Promise<string>} stdout, or an empty string when the command fails.
 */
async function readCommand(command, args, timeoutMs = 5_000) {
  try {
    const { stdout } = await runProcess(command, args, { timeoutMs })
    return stdout
  } catch {
    return ''
  }
}

/**
 * Parse the battery line from `pmset -g batt`.
 *
 * Kept pure for tests.
 *
 * @param {string} text - `pmset` output.
 * @returns {{ percent: number, charging: boolean, timeRemainingMinutes: number | null } | null} battery facts, or null when there is no battery.
 */
export function parseBattery(text) {
  const match = /(\d+)%/u.exec(text ?? '')
  if (match === null) return null
  const percent = Number(match[1])
  const charging = /(?:^|[;\s])(charging|AC Power|finishing charge|charged)/iu.test(text)
  const remaining = /(\d+):(\d{2})\s+remaining/iu.exec(text)
  return {
    percent,
    charging,
    timeRemainingMinutes: remaining === null ? null : Number(remaining[1]) * 60 + Number(remaining[2]),
  }
}

/**
 * Parse the root filesystem line from `df -kP /`.
 *
 * @param {string} text - `df -kP` output.
 * @returns {{ mount: string, totalBytes: number, usedBytes: number, freeBytes: number } | null} disk facts.
 */
export function parseDisk(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/u)
  const line = lines[lines.length - 1] ?? ''
  const fields = line.trim().split(/\s+/u)
  if (fields.length < 6) return null
  const blocks = Number(fields[1])
  const used = Number(fields[2])
  const available = Number(fields[3])
  if (!Number.isFinite(blocks) || !Number.isFinite(used) || !Number.isFinite(available)) return null
  return {
    mount: fields.slice(5).join(' '),
    totalBytes: blocks * 1024,
    usedBytes: used * 1024,
    freeBytes: available * 1024,
  }
}

/**
 * Parse `vm_stat` into a usable memory figure. macOS counts file cache as
 * "inactive"/"speculative" pages rather than free, so `os.freemem()` reports a
 * machine under load as nearly full; free + inactive + speculative is the
 * number a person expects from Activity Monitor.
 *
 * @param {string} text - `vm_stat` output.
 * @param {number} totalBytes - physical memory.
 * @returns {{ freeBytes: number, usedPercent: number } | null} memory facts.
 */
export function parseVmStat(text, totalBytes) {
  const pageSize = /page size of (\d+) bytes/iu.exec(text ?? '')
  const free = /Pages free:\s+(\d+)/u.exec(text ?? '')
  if (pageSize === null || free === null) return null
  const inactive = /Pages inactive:\s+(\d+)/u.exec(text ?? '')
  const speculative = /Pages speculative:\s+(\d+)/u.exec(text ?? '')
  const bytes = Number(pageSize[1])
  const availablePages = Number(free[1])
    + (inactive === null ? 0 : Number(inactive[1]))
    + (speculative === null ? 0 : Number(speculative[1]))
  const freeBytes = Math.min(totalBytes, availablePages * bytes)
  return {
    freeBytes,
    usedPercent: totalBytes === 0 ? 0 : Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10,
  }
}

/**
 * Collect the system information answer.
 *
 * @returns {Promise<object>} the system snapshot.
 */
export async function systemInfo() {
  const cpus = os.cpus()
  const total = os.totalmem()
  const [productVersion, model, diskText, batteryText, vmStatText] = await Promise.all([
    readCommand('/usr/bin/sw_vers', ['-productVersion']),
    readCommand('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']).then(async (value) => {
      if (value.trim() !== '') return value
      return readCommand('/usr/sbin/sysctl', ['-n', 'hw.model'])
    }),
    readCommand('/bin/df', ['-kP', '/']),
    readCommand('/usr/bin/pmset', ['-g', 'batt']),
    readCommand('/usr/bin/vm_stat', []),
  ])
  const memory = parseVmStat(vmStatText, total) ?? {
    freeBytes: os.freemem(),
    usedPercent: total === 0 ? 0 : Math.round(((total - os.freemem()) / total) * 1000) / 10,
  }
  return {
    os: {
      name: 'macOS',
      version: productVersion.trim() === '' ? os.release() : productVersion.trim(),
      kernel: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
    },
    uptimeSeconds: Math.round(os.uptime()),
    cpu: {
      model: model.trim() === '' ? cpus[0]?.model ?? 'unknown' : model.trim(),
      cores: cpus.length,
    },
    memory: { totalBytes: total, ...memory },
    disk: parseDisk(diskText),
    battery: parseBattery(batteryText),
    capturedAt: new Date().toISOString(),
  }
}
