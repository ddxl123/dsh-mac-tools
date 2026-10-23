/**
 * Process ranking and kill tests.
 *
 * The list parser and ranking replay recorded `ps` output through an injected
 * runner. The kill tests never signal an unrelated process: the success path
 * terminates a child of the test process, and the error paths either use an
 * impossible pid or stub `process.kill` for the duration of one test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'

import { killProcess, listProcesses, parseProcessList } from '../src/processes.js'

/** Recorded-looking `ps -Ao pid=,pcpu=,pmem=,rss=,user=,comm=` output. */
const PS_OUTPUT = [
  '    1   1.0  0.1  17344 root             /sbin/launchd',
  '   95   1.6  0.1  32816 root             /usr/libexec/logd',
  ' 1035  12.3  1.2 129408 linlong         /Applications/Macs Fan Control.app/Contents/MacOS/Macs Fan Control',
  ' 1501   0.0  0.0   6240 linlong         /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/FSEvents.framework/Versions/A/Support/fseventsd',
  ' 2200   5.0  3.4 830000 linlong         /Applications/Xcode.app/Contents/MacOS/Xcode',
  ' 3300   2.0  0.0   1024 root             /usr/libexec/very-long-process-name-that-exceeds-sixty-four-characters-for-sure',
  'not a process row at all',
  '',
].join('\n')

/**
 * @param {string} stdout - fixture output.
 * @returns {((command: string, args?: string[], options?: object) => Promise<{ stdout: string }>) & { calls: string[] }} a runner that records its calls.
 */
function fixtureRun(stdout) {
  const calls = []
  const run = async (command, args = []) => {
    calls.push([command, ...args].join(' '))
    return { stdout, stderr: '', code: 0 }
  }
  run.calls = calls
  return run
}

test('parses ps output into ranked-process rows', () => {
  const rows = parseProcessList(PS_OUTPUT)
  assert.equal(rows.length, 6)
  assert.deepEqual(rows[0], {
    pid: 1,
    name: 'launchd',
    cpuPercent: 1,
    memoryPercent: 0.1,
    rssBytes: 17344 * 1024,
    user: 'root',
  })
  assert.deepEqual(rows[2], {
    pid: 1035,
    name: 'Macs Fan Control',
    cpuPercent: 12.3,
    memoryPercent: 1.2,
    rssBytes: 129408 * 1024,
    user: 'linlong',
  })
  // The executable name is the basename of comm (app paths contain spaces) and
  // is trimmed to the contract's 64 characters.
  const longName = 'very-long-process-name-that-exceeds-sixty-four-characters-for-sure'
  assert.equal(longName.length, 66)
  assert.equal(rows[5].name, longName.slice(0, 64))
  assert.equal(rows[5].name.length, 64)
  assert.deepEqual(parseProcessList(''), [])
  assert.deepEqual(parseProcessList('garbage'), [])
})

test('lists processes ranked by cpu or memory with killable flags', async () => {
  const currentUser = os.userInfo().username
  const psFixture = [
    `   10  50.0  9.9  100000 root             /usr/sbin/root-daemon`,
    `   20   5.0  1.0   20000 ${currentUser}       /usr/bin/top`,
    `   30   5.0  2.0   50000 ${currentUser}       /bin/zsh`,
    `   ${process.pid}  99.0  0.1   1000 ${currentUser}       /usr/local/bin/node`,
    `   40   1.0  9.9  900000 ${currentUser}       /usr/bin/memory-hog`,
  ].join('\n')
  const run = fixtureRun(psFixture)
  const byCpu = await listProcesses({ sort: 'cpu', limit: 5, run })
  assert.equal(byCpu.sort, 'cpu')
  assert.equal(byCpu.count, 5)
  assert.deepEqual(byCpu.processes.map((row) => row.pid), [process.pid, 10, 30, 20, 40])
  const hostRow = byCpu.processes.find((row) => row.pid === process.pid)
  assert.equal(hostRow.killable, false)
  assert.equal(byCpu.processes.find((row) => row.pid === 10).killable, false)
  assert.equal(byCpu.processes.find((row) => row.pid === 20).killable, true)

  const byMemory = await listProcesses({ sort: 'memory', run })
  assert.equal(byMemory.sort, 'memory')
  assert.deepEqual(byMemory.processes.map((row) => row.pid), [40, 10, 30, 20, process.pid])

  const limited = await listProcesses({ sort: 'cpu', limit: 2, run })
  assert.equal(limited.count, 2)
  const invalidSort = await listProcesses({ sort: 'bogus', limit: 0, run })
  assert.equal(invalidSort.sort, 'cpu')
  assert.equal(invalidSort.count, 5)
  const names = await listProcesses({ limit: 'nope', run })
  assert.equal(names.count, 5)
  assert.deepEqual(run.calls[0], '/bin/ps -Ao pid=,pcpu=,pmem=,rss=,user=,comm=')
})

test('killProcess refuses pid 0, 1, non-integers and its own pid', async () => {
  const runThatMustNotRun = async () => {
    throw new Error('the runner must not be called for an invalid pid')
  }
  for (const pid of [0, 1, -3, 1.5, '1234', null, undefined, process.pid]) {
    await assert.rejects(
      killProcess(pid, { run: runThatMustNotRun }),
      (error) => error instanceof Error && error.code === 'kill_invalid_pid',
      `pid ${String(pid)} must be refused`,
    )
  }
})

test('killProcess maps a missing process to kill_not_found', async () => {
  const run = async () => ({ stdout: '', stderr: '', code: 0 })
  await assert.rejects(
    killProcess(2_000_000, { run }),
    (error) => error instanceof Error && error.code === 'kill_not_found',
  )
})

test('killProcess terminates a real child with SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  try {
    const result = await killProcess(child.pid)
    assert.deepEqual({ pid: result.pid, signal: result.signal }, { pid: child.pid, signal: 'SIGTERM' })
    assert.equal(typeof result.name, 'string')
    await exited
  } finally {
    child.kill('SIGKILL')
  }
})

test('killProcess maps EPERM and EACCES to kill_denied', async () => {
  const original = process.kill
  try {
    for (const code of ['EPERM', 'EACCES']) {
      process.kill = () => {
        const failure = new Error('operation not permitted')
        failure.code = code
        throw failure
      }
      await assert.rejects(
        killProcess(424242, { run: async () => ({ stdout: '/usr/bin/secret-tool\n' }) }),
        (error) => error instanceof Error && error.code === 'kill_denied',
      )
    }
    process.kill = () => {
      const failure = new Error('invalid argument')
      failure.code = 'EINVAL'
      throw failure
    }
    await assert.rejects(
      killProcess(424242, { run: async () => ({ stdout: '' }) }),
      (error) => error instanceof Error && error.code === 'kill_invalid_pid',
    )
  } finally {
    process.kill = original
  }
})

test('killProcess resolves the name best-effort and still kills', async () => {
  const original = process.kill
  process.kill = () => true
  try {
    const named = await killProcess(424242, { run: async () => ({ stdout: '/Applications/Xcode.app/Contents/MacOS/Xcode\n' }) })
    assert.deepEqual(named, { pid: 424242, name: 'Xcode', signal: 'SIGTERM' })
    const unnamed = await killProcess(424243, {
      run: async () => {
        throw new Error('ps failed')
      },
    })
    assert.deepEqual(unnamed, { pid: 424243, name: '', signal: 'SIGTERM' })
  } finally {
    process.kill = original
  }
})
