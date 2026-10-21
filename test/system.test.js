/**
 * System-information tests: the parsers are pure; the collector is exercised
 * against this Mac.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseBattery, parseDisk, parseVmStat, systemInfo } from '../src/system.js'

test('parses battery output', () => {
  assert.deepEqual(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1) 87%; discharging; 2:10 remaining present: true\n"), {
    percent: 87,
    charging: false,
    timeRemainingMinutes: 130,
  })
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1) 100%; charged; 0:00 remaining present: true\n"), {
    percent: 100,
    charging: true,
    timeRemainingMinutes: 0,
  })
  assert.equal(parseBattery("Now drawing from 'AC Power'\n"), null)
})

test('parses the root filesystem line', () => {
  const disk = parseDisk('Filesystem     1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1s1   482797652  12166652  16438164    43%    /\n')
  assert.deepEqual(disk, {
    mount: '/',
    totalBytes: 482797652 * 1024,
    usedBytes: 12166652 * 1024,
    freeBytes: 16438164 * 1024,
  })
  assert.equal(parseDisk('nonsense'), null)
})

test('parses vm_stat into Activity-Monitor-style memory', () => {
  const text = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               39518.',
    'Pages active:                            668057.',
    'Pages inactive:                          672260.',
    'Pages speculative:                         5090.',
    'Pages wired down:                        235586.',
  ].join('\n')
  const total = 34_359_738_368
  const memory = parseVmStat(text, total)
  assert.ok(memory !== null)
  const expectedFree = (39518 + 672260 + 5090) * 16384
  assert.equal(memory.freeBytes, expectedFree)
  assert.equal(memory.usedPercent, Math.round(((total - expectedFree) / total) * 1000) / 10)
  assert.equal(parseVmStat('nope', total), null)
})

test('collects a coherent snapshot on this Mac', { skip: process.platform !== 'darwin' }, async () => {
  const info = await systemInfo()
  assert.equal(info.os.name, 'macOS')
  assert.match(info.os.version, /^\d+/u)
  assert.ok(info.os.arch === 'arm64' || info.os.arch === 'x64')
  assert.ok(info.cpu.cores >= 1)
  assert.ok(info.memory.totalBytes > 0)
  assert.ok(info.memory.usedPercent >= 0 && info.memory.usedPercent <= 100)
  assert.equal(typeof info.uptimeSeconds, 'number')
  assert.ok(info.uptimeSeconds > 0)
  if (info.disk !== null) assert.ok(info.disk.totalBytes > 0)
  if (info.battery !== null) assert.ok(info.battery.percent >= 0 && info.battery.percent <= 100)
})
