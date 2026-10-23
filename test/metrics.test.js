/**
 * Software-metrics tests.
 *
 * The parsers are exercised on command output recorded on this Mac (Mac mini
 * M4, macOS 26.3.1); the collector replays the same fixtures through an
 * injected `run`, so the suite is deterministic and needs no root, network or
 * hardware. One live smoke test guards the real command paths.
 */

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

import {
  collectSoftwareMetrics,
  computeCpuPercentages,
  parseBattery,
  parseDf,
  parseHostFacts,
  parseNetstat,
  parseSwapUsage,
  parseVmStat,
  resetMetricsCache,
} from '../src/metrics.js'

// ---------------------------------------------------------------------------
// Recorded command output (2026-10-23, this Mac).
// ---------------------------------------------------------------------------

/** `vm_stat`, verbatim. */
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                4624.',
  'Pages active:                            585156.',
  'Pages inactive:                          583588.',
  'Pages speculative:                          518.',
  'Pages throttled:                              0.',
  'Pages wired down:                        207697.',
  'Pages purgeable:                          13837.',
  '"Translation faults":                 939602363.',
  'Pages copy-on-write:                   21148667.',
  'Pages zero filled:                     179520362.',
  'Pages reactivated:                     13612465.',
  'Pages purged:                           1642147.',
  'File-backed pages:                       328162.',
  'Anonymous pages:                         841100.',
  'Pages stored in compressor:             1284794.',
  'Pages occupied by compressor:            680950.',
  'Decompressions:                         8343896.',
  'Compressions:                          11514880.',
  'Pageins:                                4952775.',
  'Pageouts:                                 43590.',
].join('\n')

/** `netstat -ibn`, head verbatim; note the link rows without an address. */
const NETSTAT = [
  'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
  'lo0        16384 <Link#1>                       3289675     0 24577006311  3289675     0 24577006311     0',
  'lo0        16384 127           127.0.0.1        3289675     - 24577006311  3289675     - 24577006311     -',
  'lo0        16384 ::1/128     ::1                3289675     - 24577006311  3289675     - 24577006311     -',
  'en0        1500  <Link#7>    d0:11:e5:b9:f8:40        0     0          0        0     0          0     0',
  'en1        1500  <Link#15>   da:2c:80:b9:fc:28  6995303     0 3933684823  7001249     0 8392771234     0',
  'en1        1500  192.168.1     192.168.1.47     6995303     - 3933684823  7001249     - 8392771234     -',
  'anpi0      1500  <Link#4>    16:98:bf:43:7c:68        0     0          0        0     0          0     0',
  'gif0*      1280  <Link#2>                             0     0          0        0     0          0     0',
].join('\n')

/** `df -kP /System/Volumes/Data`, verbatim. */
const DF_DATA = [
  'Filesystem   1024-blocks      Used Available Capacity  Mounted on',
  '/dev/disk3s5   482797652 419393416  38446856    92%    /System/Volumes/Data',
].join('\n')

/** `df -kP /`, verbatim. */
const DF_ROOT = [
  'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
  '/dev/disk3s1s1   482797652  12166652  38446856    25%    /',
].join('\n')

/** `diskutil info -plist /`, trimmed to the fields the collector reads. */
const DISKUTIL_ROOT_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '	<key>DeviceNode</key>',
  '	<string>/dev/disk3s1s1</string>',
  '	<key>MountPoint</key>',
  '	<string>/</string>',
  '	<key>VolumeName</key>',
  '	<string>Macintosh HD</string>',
  '</dict>',
  '</plist>',
].join('\n')

/** `diskutil info -plist /System/Volumes/Data`, trimmed to the fields read. */
const DISKUTIL_DATA_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  '<dict>',
  '	<key>DeviceNode</key>',
  '	<string>/dev/disk3s5</string>',
  '	<key>MountPoint</key>',
  '	<string>/System/Volumes/Data</string>',
  '	<key>VolumeName</key>',
  '	<string>Data</string>',
  '</dict>',
  '</plist>',
].join('\n')

/** One netstat row set with small, easy-to-check counters. */
const NETSTAT_COUNTERS = [
  'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
  'en0        1500  <Link#7>    d0:11:e5:b9:f8:40       12     0       4096       20     0       8192     0',
  'en0        1500  192.168.50  192.168.50.212          12     0       4096       20     0       8192     0',
].join('\n')

/**
 * Build a runner that replays recorded command output and records the calls.
 *
 * @param {Record<string, string | Error>} [overrides] - per-command fixture overrides (`"command arg arg"` keys).
 * @returns {((command: string, args?: string[], options?: object) => Promise<{ stdout: string }>) & { calls: string[] }} the runner.
 */
function createFixtureRun(overrides = {}) {
  /** @type {Record<string, string | Error>} */
  const fixtures = {
    '/usr/bin/vm_stat': VM_STAT,
    '/usr/sbin/sysctl -n hw.memsize': '34359738368\n',
    '/usr/sbin/sysctl -n vm.swapusage': 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n',
    '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level': '1\n',
    '/usr/sbin/sysctl -n machdep.cpu.brand_string': 'Apple M4\n',
    '/usr/sbin/sysctl -n hw.model': 'Mac16,10\n',
    '/usr/bin/sw_vers -productVersion': '26.3.1\n',
    '/usr/sbin/sysctl -n hw.perflevel0.logicalcpu': '4\n',
    '/usr/sbin/sysctl -n hw.perflevel1.logicalcpu': '6\n',
    '/usr/sbin/netstat -ibn': NETSTAT_COUNTERS,
    '/bin/df -kP /System/Volumes/Data': DF_DATA,
    '/bin/df -kP /': DF_ROOT,
    '/usr/bin/pmset -g batt': "Now drawing from 'AC Power'\n",
    '/usr/sbin/diskutil info -plist /': DISKUTIL_ROOT_PLIST,
    '/usr/sbin/diskutil info -plist /System/Volumes/Data': DISKUTIL_DATA_PLIST,
    ...overrides,
  }
  /** @type {string[]} */
  const calls = []
  const run = async (command, args = []) => {
    const key = [command, ...args].join(' ')
    calls.push(key)
    if (!(key in fixtures)) throw new Error(`unexpected command in test: ${key}`)
    const fixture = fixtures[key]
    if (fixture instanceof Error) throw fixture
    return { stdout: fixture, stderr: '', code: 0 }
  }
  run.calls = calls
  return run
}

// ---------------------------------------------------------------------------
// Pure parsers.
// ---------------------------------------------------------------------------

test('computes CPU percentages from os.cpus() deltas', () => {
  const previous = [
    { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
  ]
  const current = [
    { times: { user: 150, nice: 10, sys: 70, idle: 1770, irq: 0 } },
    { times: { user: 300, nice: 0, sys: 100, idle: 600, irq: 0 } },
  ]
  assert.deepEqual(computeCpuPercentages(previous, current), {
    usagePercent: 24,
    userPercent: 18,
    systemPercent: 6,
    idlePercent: 76,
    perCorePercent: [8, 40],
  })
  assert.equal(computeCpuPercentages(null, current), null)
  assert.equal(computeCpuPercentages(previous, []), null)
  assert.equal(computeCpuPercentages(previous, [current[0]]), null)
  assert.equal(computeCpuPercentages(previous, previous), null)
})

test('parses recorded vm_stat into the memory shape', () => {
  const total = 34_359_738_368
  const pageSize = 16_384
  const memory = parseVmStat(VM_STAT, total)
  assert.ok(memory !== null)
  const availablePages = 4624 + 583588 + 518 + 13837
  assert.equal(memory.totalBytes, total)
  assert.equal(memory.availableBytes, availablePages * pageSize)
  assert.equal(memory.usedBytes, total - availablePages * pageSize)
  assert.equal(memory.usedBytes + memory.availableBytes, total)
  assert.equal(memory.usedPercent, Math.round(((total - availablePages * pageSize) / total) * 1000) / 10)
  assert.equal(memory.wiredBytes, 207697 * pageSize)
  assert.equal(memory.compressedBytes, 680950 * pageSize)
  assert.equal(memory.cachedBytes, (583588 + 518) * pageSize)
  assert.equal(memory.appBytes, memory.usedBytes - memory.wiredBytes - memory.compressedBytes)
  assert.equal(memory.swapUsedBytes, 0)
  assert.equal(parseVmStat('nonsense', total), null)
  assert.equal(parseVmStat(VM_STAT, 0), null)
})

test('parses sysctl vm.swapusage', () => {
  assert.equal(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)'), 0)
  assert.equal(parseSwapUsage('vm.swapusage: total = 4096.00M  used = 1024.50M  free = 3071.50M  (encrypted)'), 1_074_266_112)
  assert.equal(parseSwapUsage('total = 4.00G  used = 2.00G  free = 2.00G'), 2_147_483_648)
  assert.equal(parseSwapUsage(''), 0)
  assert.equal(parseSwapUsage('used = nope'), 0)
})

test('parses recorded netstat totals, including address-less link rows', () => {
  const rows = parseNetstat(NETSTAT)
  assert.deepEqual(rows.map((row) => row.interface), ['lo0', 'en0', 'en1', 'anpi0', 'gif0'])
  const lo0 = rows[0]
  assert.equal(lo0.receivedBytes, 24_577_006_311)
  assert.equal(lo0.sentBytes, 24_577_006_311)
  assert.deepEqual(rows[1], { interface: 'en0', receivedBytes: 0, sentBytes: 0 })
  assert.deepEqual(rows[2], { interface: 'en1', receivedBytes: 3_933_684_823, sentBytes: 8_392_771_234 })
  assert.deepEqual(parseNetstat('Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll'), [])
  assert.deepEqual(parseNetstat(''), [])
})

test('parses df output into bytes', () => {
  assert.deepEqual(parseDf(DF_DATA), {
    totalBytes: 482_797_652 * 1024,
    usedBytes: 419_393_416 * 1024,
    freeBytes: 38_446_856 * 1024,
  })
  assert.deepEqual(parseDf(DF_ROOT), {
    totalBytes: 482_797_652 * 1024,
    usedBytes: 12_166_652 * 1024,
    freeBytes: 38_446_856 * 1024,
  })
  assert.equal(parseDf('nonsense'), null)
  assert.equal(parseDf('header line\nnot a row'), null)
})

test('parses pmset battery output and degrades to null on a desktop', () => {
  assert.equal(parseBattery("Now drawing from 'AC Power'\n"), null)
  assert.deepEqual(
    parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t95%; charging; 0:20 remaining present: true\n"),
    { percent: 95, charging: true, pluggedIn: true, timeRemainingMinutes: 20, healthPercent: null, cycleCount: null },
  )
  assert.deepEqual(
    parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t87%; discharging; 2:10 remaining present: true\n"),
    { percent: 87, charging: false, pluggedIn: false, timeRemainingMinutes: 130, healthPercent: null, cycleCount: null },
  )
  assert.deepEqual(
    parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"),
    { percent: 100, charging: true, pluggedIn: true, timeRemainingMinutes: 0, healthPercent: null, cycleCount: null },
  )
  assert.deepEqual(
    parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t75%; AC attached; not charging present: true\n"),
    { percent: 75, charging: false, pluggedIn: true, timeRemainingMinutes: null, healthPercent: null, cycleCount: null },
  )
  assert.equal(parseBattery('no battery present'), null)
  assert.equal(parseBattery(''), null)
})

test('builds the host block from os.* and static sysctl facts', () => {
  const host = parseHostFacts({
    modelIdentifier: 'Mac16,10',
    cpuModel: 'Apple M4',
    osVersion: '26.3.1',
    performanceCores: 4,
    efficiencyCores: 6,
  })
  assert.equal(host.hostname, os.hostname())
  assert.equal(host.modelName, 'Mac mini')
  assert.equal(host.modelIdentifier, 'Mac16,10')
  assert.equal(host.cpuModel, 'Apple M4')
  assert.equal(host.arch, os.arch())
  assert.equal(host.osVersion, '26.3.1')
  assert.equal(host.cpuCores, os.cpus().length)
  assert.equal(host.performanceCores, 4)
  assert.equal(host.efficiencyCores, 6)
  assert.ok(host.uptimeSeconds > 0)
  const fallback = parseHostFacts()
  assert.equal(fallback.modelName, 'Mac')
  assert.equal(fallback.modelIdentifier, 'unknown')
  assert.equal(fallback.performanceCores, null)
  assert.ok(fallback.cpuModel.length > 0)
  assert.ok(fallback.osVersion.length > 0)
})

// ---------------------------------------------------------------------------
// Collector with recorded command output.
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetMetricsCache()
})

test('collects a full sample from recorded command output', async () => {
  const run = createFixtureRun()
  const sample = await collectSoftwareMetrics({ run })
  assert.equal(sample.at, new Date(sample.at).toISOString())

  assert.equal(sample.host.modelName, 'Mac mini')
  assert.equal(sample.host.modelIdentifier, 'Mac16,10')
  assert.equal(sample.host.cpuModel, 'Apple M4')
  assert.equal(sample.host.osVersion, '26.3.1')
  assert.equal(sample.host.performanceCores, 4)
  assert.equal(sample.host.efficiencyCores, 6)
  assert.equal(sample.host.cpuCores, os.cpus().length)

  for (const key of ['usagePercent', 'userPercent', 'systemPercent', 'idlePercent']) {
    assert.ok(Number.isFinite(sample.cpu[key]) && sample.cpu[key] >= 0 && sample.cpu[key] <= 100, key)
  }
  assert.equal(sample.cpu.perCorePercent.length, os.cpus().length)
  assert.ok(sample.cpu.loadAverage.length === 3 && sample.cpu.loadAverage.every(Number.isFinite))
  assert.equal(sample.cpu.temperatureCelsius, null)

  assert.equal(sample.memory.totalBytes, 34_359_738_368)
  assert.equal(sample.memory.swapUsedBytes, 0)
  assert.equal(sample.memory.pressure, 'normal')
  assert.equal(sample.memory.usedBytes + sample.memory.availableBytes, sample.memory.totalBytes)
  assert.ok(sample.memory.usedPercent >= 0 && sample.memory.usedPercent <= 100)
  assert.equal(sample.memory.appBytes + sample.memory.wiredBytes + sample.memory.compressedBytes, sample.memory.usedBytes)

  assert.equal(sample.disk.name, 'Macintosh HD')
  assert.equal(sample.disk.mount, '/System/Volumes/Data')
  assert.equal(sample.disk.totalBytes, 482_797_652 * 1024)
  assert.equal(sample.disk.usedBytes, 419_393_416 * 1024)
  assert.equal(sample.disk.freeBytes, 38_446_856 * 1024)
  assert.equal(sample.disk.usedPercent, Math.round((419_393_416 / 482_797_652) * 1000) / 10)

  assert.equal(sample.network.interface, 'en0')
  assert.ok(sample.network.localIp === null || typeof sample.network.localIp === 'string')
  assert.equal(sample.network.receivedTotalBytes, 4096)
  assert.equal(sample.network.sentTotalBytes, 8192)
  assert.equal(sample.network.receivedBytesPerSecond, 0)
  assert.equal(sample.network.sentBytesPerSecond, 0)
  assert.equal(sample.battery, null)
})

test('reuses cached static facts and reports 0 rate for unchanged counters', async () => {
  const run = createFixtureRun()
  const first = await collectSoftwareMetrics({ run })
  const diskUtilCalls = run.calls.filter((call) => call.startsWith('/usr/sbin/diskutil')).length
  assert.equal(diskUtilCalls, 2)
  const second = await collectSoftwareMetrics({ previous: first, run })
  assert.equal(run.calls.filter((call) => call.startsWith('/usr/sbin/diskutil')).length, diskUtilCalls)
  assert.equal(second.network.receivedTotalBytes, first.network.receivedTotalBytes)
  assert.equal(second.network.receivedBytesPerSecond, 0)
  assert.equal(second.network.sentBytesPerSecond, 0)
})

test('computes network rates from the previous sample', async () => {
  const run = createFixtureRun({
    '/usr/sbin/netstat -ibn': [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'en0        1500  192.168.50  192.168.50.212          12     0       2024       20     0       1524     0',
    ].join('\n'),
  })
  const previous = {
    at: new Date(Date.now() - 1000).toISOString(),
    network: { receivedTotalBytes: 1000, sentTotalBytes: 500 },
  }
  const sample = await collectSoftwareMetrics({ previous, run })
  assert.ok(sample.network.receivedBytesPerSecond > 0)
  assert.ok(sample.network.receivedBytesPerSecond <= 1024)
  assert.ok(sample.network.sentBytesPerSecond > 0)
  assert.ok(sample.network.sentBytesPerSecond <= 1024)
})

test('falls back to the root filesystem when the data volume df is empty', async () => {
  const run = createFixtureRun({
    '/bin/df -kP /System/Volumes/Data': '',
    '/bin/df -kP /': DF_ROOT,
  })
  const sample = await collectSoftwareMetrics({ run })
  assert.equal(sample.disk.mount, '/')
  assert.equal(sample.disk.totalBytes, 482_797_652 * 1024)
  assert.equal(sample.disk.usedBytes, 12_166_652 * 1024)
  assert.equal(sample.disk.name, 'Macintosh HD')
})

test('never throws when every command fails', async () => {
  const run = async () => {
    throw new Error('command unavailable')
  }
  const sample = await collectSoftwareMetrics({ run })
  assert.equal(sample.at, new Date(sample.at).toISOString())
  assert.ok(sample.memory.totalBytes > 0)
  assert.ok(sample.memory.usedPercent >= 0 && sample.memory.usedPercent <= 100)
  assert.deepEqual(sample.disk, {
    name: 'Macintosh HD',
    mount: '/',
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
    usedPercent: 0,
  })
  assert.equal(sample.network.receivedTotalBytes, 0)
  assert.equal(sample.network.sentTotalBytes, 0)
  assert.equal(sample.network.receivedBytesPerSecond, 0)
  assert.equal(sample.battery, null)
  assert.equal(sample.cpu.perCorePercent.length, os.cpus().length)
})

test('reports memory pressure levels when the sysctl answers', async () => {
  const run = createFixtureRun({ '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level': '4\n' })
  const sample = await collectSoftwareMetrics({ run })
  assert.equal(sample.memory.pressure, 'critical')
  resetMetricsCache()
  const missing = createFixtureRun({ '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level': '' })
  assert.equal((await collectSoftwareMetrics({ run: missing })).memory.pressure, null)
})

// ---------------------------------------------------------------------------
// Live smoke test against the real macOS utilities (this Mac only).
// ---------------------------------------------------------------------------

test('collects a coherent live snapshot on this Mac', { skip: process.platform !== 'darwin' }, async () => {
  resetMetricsCache()
  const first = await collectSoftwareMetrics({})
  assert.ok(Number.isFinite(Date.parse(first.at)))
  for (const key of ['usagePercent', 'userPercent', 'systemPercent', 'idlePercent']) {
    assert.ok(Number.isFinite(first.cpu[key]) && first.cpu[key] >= 0 && first.cpu[key] <= 100, `cpu.${key}`)
  }
  assert.equal(first.cpu.perCorePercent.length, os.cpus().length)
  assert.equal(first.cpu.temperatureCelsius, null)
  assert.ok(first.host.cpuCores >= 1)
  assert.ok(first.host.cpuModel.length > 0)
  assert.ok(first.memory.totalBytes > 0)
  assert.equal(first.memory.usedBytes + first.memory.availableBytes, first.memory.totalBytes)
  assert.ok(first.memory.usedPercent >= 0 && first.memory.usedPercent <= 100)
  assert.ok([null, 'normal', 'warning', 'critical'].includes(first.memory.pressure))
  assert.ok(first.disk.totalBytes > 0)
  assert.ok(first.disk.mount === '/System/Volumes/Data' || first.disk.mount === '/')
  assert.ok(first.disk.usedPercent >= 0 && first.disk.usedPercent <= 100)
  assert.equal(typeof first.network.interface, 'string')
  assert.ok(Number.isFinite(first.network.receivedTotalBytes) && first.network.receivedTotalBytes >= 0)
  assert.ok(Number.isFinite(first.network.receivedBytesPerSecond) && first.network.receivedBytesPerSecond >= 0)
  if (first.battery !== null) {
    assert.ok(first.battery.percent >= 0 && first.battery.percent <= 100)
    assert.equal(typeof first.battery.charging, 'boolean')
  }
  const second = await collectSoftwareMetrics({ previous: first })
  assert.ok(Number.isFinite(second.network.receivedBytesPerSecond) && second.network.receivedBytesPerSecond >= 0)
  assert.ok(Number.isFinite(second.cpu.usagePercent))
})
