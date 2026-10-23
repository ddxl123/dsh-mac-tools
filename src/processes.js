/**
 * Process ranking and termination for the monitor tab.
 *
 * The panel polls a ranked list of the busiest processes and, for the rows
 * owned by the current user, can terminate one with SIGTERM. Parsing is pure
 * and the command runner is injectable, so the ranking is tested on recorded
 * `ps` output.
 *
 * Safety rules live here, not in the panel: pid 0/1, non-integers and the
 * Host's own process are refused before any signal is sent, and the OS errors
 * are mapped to the stable codes of the monitor contract.
 *
 * @module dsh-mac-tools/processes
 */

import os from 'node:os'

import { runProcess } from './capture.js'

/** The system process-status utility. */
const PS = '/bin/ps'

/** Deadline for `ps`. */
const PS_TIMEOUT_MS = 5_000

/** Longest executable name kept in a row (contract limit). */
export const MAX_PROCESS_NAME_LENGTH = 64

/** Accepted process sort keys. */
export const PROCESS_SORTS = Object.freeze(['cpu', 'memory'])

/** Rows returned when the caller does not specify a limit. */
export const DEFAULT_PROCESS_LIMIT = 15

/** Hard cap on rows the Host will return for one request. */
const MAX_PROCESS_LIMIT = 100

/**
 * @param {number} value - raw number.
 * @returns {number} the number rounded to one decimal.
 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * @param {string} commandName - `ps` comm value, usually an absolute path.
 * @returns {string} the executable basename.
 */
function basename(commandName) {
  const withoutTrailingSlash = commandName.replace(/\/+$/u, '')
  const lastSlash = withoutTrailingSlash.lastIndexOf('/')
  return lastSlash === -1 ? withoutTrailingSlash : withoutTrailingSlash.slice(lastSlash + 1)
}

/**
 * @param {string} code - stable failure code.
 * @param {string} message - English diagnostic.
 * @param {object} [details] - extra structured context.
 * @returns {Error} the error the endpoint rejects with.
 */
function processError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

/**
 * Parse `ps -Ao pid=,pcpu=,pmem=,rss=,user=,comm=` output.
 *
 * One row per process: the pid and the three numeric columns come first, the
 * user is the next whitespace-free field, and the command (which may contain
 * spaces or an app path) is the remainder. The name is the executable
 * basename trimmed to 64 characters; RSS is converted from KiB to bytes.
 *
 * @param {string} text - `ps` output.
 * @returns {{ pid: number, name: string, cpuPercent: number, memoryPercent: number, rssBytes: number, user: string }[]} parsed rows in output order.
 */
export function parseProcessList(text) {
  const rows = []
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = /^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const command = match[6].trim()
    if (command === '') continue
    rows.push({
      pid,
      name: basename(command).slice(0, MAX_PROCESS_NAME_LENGTH),
      cpuPercent: round1(Number(match[2])),
      memoryPercent: round1(Number(match[3])),
      rssBytes: Math.round(Number(match[4]) * 1024),
      user: match[5],
    })
  }
  return rows
}

/**
 * List the busiest processes for the panel's ranking.
 *
 * Every row carries an additive `killable` flag (not part of the documented
 * row shape) because the browser cannot otherwise know the Host's username or
 * pid: it is true only for a positive pid above 1, owned by the current user
 * and different from the Host process itself.
 *
 * @param {object} [options] - request options.
 * @param {'cpu' | 'memory'} [options.sort] - ranking key, `cpu` by default.
 * @param {number} [options.limit] - maximum rows (default 15, capped at 100).
 * @param {(command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>} [options.run] - command runner, `runProcess` by default.
 * @returns {Promise<{ sort: 'cpu' | 'memory', count: number, processes: object[] }>} the §3.2 value without `sampledAt`.
 * @throws {Error} when `ps` cannot be executed or exits non-zero.
 */
export async function listProcesses({ sort = 'cpu', limit = DEFAULT_PROCESS_LIMIT, run = runProcess } = {}) {
  const rankedBy = PROCESS_SORTS.includes(sort) ? sort : 'cpu'
  const maxRows = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PROCESS_LIMIT) : DEFAULT_PROCESS_LIMIT
  const { stdout } = await run(PS, ['-Ao', 'pid=,pcpu=,pmem=,rss=,user=,comm='], { timeoutMs: PS_TIMEOUT_MS })
  const rows = parseProcessList(stdout)
  rows.sort((left, right) => {
    if (rankedBy === 'memory') {
      const byMemory = right.memoryPercent - left.memoryPercent
      if (byMemory !== 0) return byMemory
      const byRss = right.rssBytes - left.rssBytes
      if (byRss !== 0) return byRss
      return left.pid - right.pid
    }
    const byCpu = right.cpuPercent - left.cpuPercent
    if (byCpu !== 0) return byCpu
    const byMemory = right.memoryPercent - left.memoryPercent
    if (byMemory !== 0) return byMemory
    return left.pid - right.pid
  })
  const currentUser = os.userInfo().username
  const processes = rows.slice(0, maxRows).map((row) => ({
    ...row,
    killable: row.pid > 1 && row.pid !== process.pid && row.user === currentUser,
  }))
  return { sort: rankedBy, count: processes.length, processes }
}

/**
 * Resolve the executable name of one process for the kill answer. Best
 * effort: failure only means the response carries an empty name.
 *
 * @param {number} pid - target process id.
 * @param {(command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>} run - command runner.
 * @returns {Promise<string>} the executable basename, or an empty string.
 */
async function resolveProcessName(pid, run) {
  try {
    const { stdout } = await run(PS, ['-o', 'comm=', '-p', String(pid)], { timeoutMs: 2_000 })
    const firstLine = String(stdout ?? '').split(/\r?\n/u)[0]?.trim() ?? ''
    return firstLine === '' ? '' : basename(firstLine).slice(0, MAX_PROCESS_NAME_LENGTH)
  } catch {
    return ''
  }
}

/**
 * Classify a `process.kill` failure into one of the contract codes.
 *
 * @param {number} pid - target process id.
 * @param {unknown} failure - thrown value from `process.kill`.
 * @returns {Error} the error with `.code` set.
 */
function classifyKillFailure(pid, failure) {
  const code = failure !== null && typeof failure === 'object' ? failure.code : undefined
  if (code === 'ESRCH') return processError('kill_not_found', `process ${pid} does not exist`, { pid })
  if (code === 'EPERM' || code === 'EACCES') return processError('kill_denied', `not allowed to terminate process ${pid}`, { pid })
  if (code === 'EINVAL') return processError('kill_invalid_pid', `invalid process id ${pid}`, { pid })
  const message = failure instanceof Error ? failure.message : String(failure)
  return processError('kill_denied', `could not terminate process ${pid}: ${message}`, { pid })
}

/**
 * Terminate one process with SIGTERM (no escalation).
 *
 * @param {number} pid - target process id.
 * @param {object} [options] - request options.
 * @param {(command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>} [options.run] - command runner used to resolve the executable name.
 * @returns {Promise<{ pid: number, name: string, signal: 'SIGTERM' }>} the §3.3 value.
 * @throws {Error} with `.code` = `kill_invalid_pid` | `kill_not_found` | `kill_denied`.
 */
export async function killProcess(pid, { run = runProcess } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    throw processError('kill_invalid_pid', `refusing to terminate pid ${JSON.stringify(pid)}`, { pid })
  }
  const name = await resolveProcessName(pid, run)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (failure) {
    throw classifyKillFailure(pid, failure)
  }
  return { pid, name, signal: 'SIGTERM' }
}
